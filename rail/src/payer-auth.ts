/**
 * rail/src/payer-auth.ts — Cryptographic payer authorization for x402 redemption.
 *
 * Binds the paying wallet to the specific action being redeemed, preventing
 * first-redeemer front-running attacks where an attacker submits a victim's
 * public txHash to claim the action.
 *
 * The payer signs an authorization message containing:
 *   - wallet (payer address)
 *   - action (the callx402 action being redeemed)
 *   - txHash (the USDC payment transaction)
 *   - quote_id (the price quote being honored)
 *   - network (e.g., eip155:8453)
 *   - recipient (the payTo address)
 *   - nonce (unique per redemption, prevents replay)
 *   - expiry (unix timestamp, authorization expires after this)
 *
 * Supports:
 * - EIP-191 personal_sign (EOAs): recover address from signature
 * - EIP-1271 (contract wallets): call isValidSignature on the wallet contract
 *
 * Fails closed: missing/invalid/expired signatures are rejected.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export interface PayerAuthorization {
  wallet: string;      // 0x-prefixed address
  action: string;      // callx402 action name
  txHash: string;      // 0x-prefixed tx hash
  quote_id: string;    // quote being redeemed
  network: string;     // e.g., eip155:8453
  recipient: string;   // payTo address
  nonce: string;       // unique nonce
  expiry: number;      // unix timestamp
  signature: string;   // 0x-prefixed 65-byte signature (r,s,v)
}

/**
 * Construct the canonical authorization message for signing.
 * Must match exactly what the client signs.
 */
export function buildAuthMessage(auth: Omit<PayerAuthorization, 'signature'>): string {
  return [
    'Payload x402 Authorization',
    `wallet:${auth.wallet.toLowerCase()}`,
    `action:${auth.action}`,
    `txHash:${auth.txHash.toLowerCase()}`,
    `quote_id:${auth.quote_id}`,
    `network:${auth.network}`,
    `recipient:${auth.recipient.toLowerCase()}`,
    `nonce:${auth.nonce}`,
    `expiry:${auth.expiry}`,
  ].join('\n');
}

/**
 * EIP-191: hash a message with the Ethereum signed message prefix.
 */
function eip191Hash(message: string): Uint8Array {
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
  const prefixed = new TextEncoder().encode(prefix + message);
  return keccak_256(prefixed);
}

/**
 * Recover the signer address from an EIP-191 signature.
 * Returns the 0x-prefixed address, or null if recovery fails.
 */
export function recoverSigner(message: string, signature: string): string | null {
  try {
    const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (sigHex.length !== 130) return null;

    const r = BigInt('0x' + sigHex.slice(0, 64));
    const s = BigInt('0x' + sigHex.slice(64, 128));
    let v = parseInt(sigHex.slice(128, 130), 16);
    // Normalize v: 27/28 -> 0/1
    if (v === 27 || v === 28) v -= 27;
    if (v !== 0 && v !== 1) return null;

    const msgHash = eip191Hash(message);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secp = secp256k1 as any;
    const sig = new secp.Signature(r, s).addRecoveryBit(v);
    const publicKey = sig.recoverPublicKey(msgHash);
    // publicKey is a Point; convert to bytes (uncompressed, remove 0x04 prefix)
    const pubKeyBytes = publicKey.toBytes(false).slice(1);
    const addressBytes = keccak_256(pubKeyBytes).slice(-20);
    return '0x' + Buffer.from(addressBytes).toString('hex');
  } catch {
    return null;
  }
}

export interface AuthVerificationResult {
  valid: boolean;
  signer?: string;
  error?: string;
}

/**
 * Verify a payer authorization.
 * - Checks expiry
 * - Recovers signer via EIP-191
 * - Verifies signer matches the claimed wallet
 *
 * For contract wallets (EIP-1271), the caller should use verifyContractSignature
 * instead, which requires an RPC call to the wallet contract.
 */
export function verifyPayerAuthorization(
  auth: PayerAuthorization,
  nowSeconds: number,
): AuthVerificationResult {
  // Validate fields
  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.wallet)) {
    return { valid: false, error: 'INVALID_WALLET' };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.txHash)) {
    return { valid: false, error: 'INVALID_TX_HASH' };
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(auth.signature)) {
    return { valid: false, error: 'INVALID_SIGNATURE_FORMAT' };
  }
  if (auth.expiry <= nowSeconds) {
    return { valid: false, error: 'AUTHORIZATION_EXPIRED' };
  }
  // Nonce must be non-empty (replay prevention is enforced by txHash single-use,
  // but nonce binds the signature to this specific redemption)
  if (!auth.nonce || auth.nonce.length < 8) {
    return { valid: false, error: 'INVALID_NONCE' };
  }

  const message = buildAuthMessage(auth);
  const signer = recoverSigner(message, auth.signature);
  if (!signer) {
    return { valid: false, error: 'SIGNATURE_RECOVERY_FAILED' };
  }
  if (signer.toLowerCase() !== auth.wallet.toLowerCase()) {
    return { valid: false, error: 'SIGNER_MISMATCH' };
  }

  return { valid: true, signer };
}

/**
 * EIP-1271 magic value for valid signatures.
 */
const EIP1271_MAGIC = '0x1626ba7e';

/**
 * Verify a contract wallet signature via EIP-1271.
 * Calls isValidSignature(bytes32,bytes) on the wallet contract via RPC.
 *
 * @param rpcCall - async function to make eth_call RPC requests
 */
export async function verifyContractSignature(
  wallet: string,
  messageHash: Uint8Array,
  signature: string,
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<boolean> {
  try {
    // isValidSignature(bytes32,bytes) selector: 0x1626ba7e
    // Encode: selector + bytes32 hash + bytes signature
    const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
    const hashHex = Buffer.from(messageHash).toString('hex');

    // ABI encode the call
    // Function: isValidSignature(bytes32 _hash, bytes _signature)
    const selector = '1626ba7e';
    const hashPadded = hashHex.padStart(64, '0');
    // Offset to signature data (0x40 = 64 bytes: 32 for hash + 32 for offset)
    const offset = '0000000000000000000000000000000000000000000000000000000000000040';
    const sigLen = (sigHex.length / 2).toString(16).padStart(64, '0');
    const sigPadded = sigHex + '0'.repeat((64 - (sigHex.length % 64)) % 64);
    const data = '0x' + selector + hashPadded + offset + sigLen + sigPadded;

    const result = (await rpcCall('eth_call', [
      { to: wallet, data },
      'latest',
    ])) as string;

    return result.toLowerCase().startsWith(EIP1271_MAGIC.toLowerCase());
  } catch {
    return false;
  }
}
