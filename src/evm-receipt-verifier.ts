/**
 * Independent, read-only ERC-20 Transfer receipt verifier.
 *
 * Call ONLY with a trusted, server-configured RPC URL. NEVER accept an RPC URL
 * supplied by the requester (SSRF / untrusted-receipt hazard). Reads canonical
 * eth_chainId, eth_getTransactionReceipt and eth_blockNumber responses; never
 * transmits a signature or signs / spends money.
 *
 * This verifies on-chain transfer FACTS; the payout's economic PURPOSE is
 * attributed to an instruction by a trusted payout partner/controller.
 */
import type { TransferLocator, VerifiedErc20Transfer } from './payout-evidence.js';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HEX_32 = /^0x[0-9a-f]{64}$/i;
const HEX_INT = /^0x[0-9a-f]+$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

function hexInt(value: unknown, field: string): number {
  if (typeof value !== 'string' || !HEX_INT.test(value)) throw new Error(field + ' must be RPC hex integer');
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(field + ' exceeds safe integer');
  return Number(amount);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' must be object');
  return value as Record<string, unknown>;
}

function canonicalAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(field + ' is not address');
  return value.toLowerCase();
}

function indexedAddress(topic: unknown, field: string): string {
  if (typeof topic !== 'string' || !HEX_32.test(topic) || !/^0x0{24}/i.test(topic)) {
    throw new Error(field + ' is not an indexed EVM address');
  }
  return canonicalAddress('0x' + topic.slice(-40), field);
}

export function createEvmRpcTransferVerifier(
  rpcUrl: string,
  opts: { timeoutMs?: number } = {},
): (locator: TransferLocator) => Promise<VerifiedErc20Transfer | null> {
  const url = new URL(rpcUrl);
  // Local non-TLS endpoints are for isolated tests only; production RPC must
  // be configured out-of-band and use HTTPS.
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('RPC URL must be trusted HTTPS (or localhost for tests)');
  }
  const timeoutMs = opts.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new Error('RPC timeoutMs out of range [100, 30000]');
  }

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('RPC HTTP status ' + response.status);
    const packet = object(await response.json(), 'RPC response');
    if (packet['error']) throw new Error('RPC returned error for ' + method);
    return packet['result'];
  }

  return async (locator: TransferLocator): Promise<VerifiedErc20Transfer | null> => {
    if (!Number.isSafeInteger(locator.chainId) || locator.chainId <= 0 ||
        !Number.isSafeInteger(locator.logIndex) || locator.logIndex < 0 ||
        typeof locator.txHash !== 'string' || !HEX_32.test(locator.txHash)) {
      throw new Error('invalid transfer locator');
    }
    const chainId = hexInt(await rpc('eth_chainId', []), 'chainId');
    if (chainId !== locator.chainId) throw new Error('RPC chain does not match configured payout chain');

    const receiptValue = await rpc('eth_getTransactionReceipt', [locator.txHash]);
    if (receiptValue === null) return null;
    const receipt = object(receiptValue, 'receipt');
    const receiptHash = receipt['transactionHash'];
    if (typeof receiptHash !== 'string' || !HEX_32.test(receiptHash) ||
        receiptHash.toLowerCase() !== locator.txHash.toLowerCase()) {
      throw new Error('RPC transaction hash mismatch');
    }
    const blockNumber = hexInt(receipt['blockNumber'], 'receipt.blockNumber');
    const blockHash = receipt['blockHash'];
    if (typeof blockHash !== 'string' || !HEX_32.test(blockHash)) throw new Error('invalid blockHash');
    const success = hexInt(receipt['status'], 'receipt.status') === 1;
    const currentBlock = hexInt(await rpc('eth_blockNumber', []), 'currentBlock');
    if (currentBlock < blockNumber) throw new Error('receipt block exceeds current chain height');
    const confirmations = currentBlock - blockNumber + 1;

    if (!Array.isArray(receipt['logs'])) throw new Error('receipt.logs must be array');
    const matching = receipt['logs'].map((v) => object(v, 'receipt.log'))
      .filter((v) => hexInt(v['logIndex'], 'logIndex') === locator.logIndex);
    if (matching.length !== 1) throw new Error('transfer log index missing or ambiguous');
    const log = matching[0]!;
    if (log['removed'] === true) throw new Error('transfer log marked removed');
    if (typeof log['transactionHash'] !== 'string' ||
        log['transactionHash'].toLowerCase() !== locator.txHash.toLowerCase()) {
      throw new Error('transfer log transaction hash mismatch');
    }
    const topics = log['topics'];
    if (!Array.isArray(topics) || topics.length !== 3 ||
        typeof topics[0] !== 'string' || topics[0].toLowerCase() !== TRANSFER_TOPIC) {
      throw new Error('log is not an ERC-20 Transfer(address,address,uint256)');
    }
    const tokenAddress = canonicalAddress(log['address'], 'token');
    const senderAddress = indexedAddress(topics[1], 'sender');
    const recipientAddress = indexedAddress(topics[2], 'recipient');
    const data = log['data'];
    if (typeof data !== 'string' || !HEX_32.test(data)) throw new Error('invalid ERC-20 transfer value');
    const amountBaseUnits = BigInt(data).toString();

    return {
      chainId,
      txHash: locator.txHash.toLowerCase(),
      logIndex: locator.logIndex,
      blockNumber,
      blockHash: blockHash.toLowerCase(),
      tokenAddress,
      senderAddress,
      recipientAddress,
      amountBaseUnits,
      confirmations,
      transactionSucceeded: success,
    };
  };
}
