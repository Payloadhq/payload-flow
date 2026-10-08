import { describe, it, expect } from 'vitest';
import {
  executeCallx402Action,
  SERVER_EXECUTABLE_ACTIONS,
} from '../src/callx402-execute.js';

describe('callx402 server-side execution', () => {
  it('exposes the expected executable actions', () => {
    expect(SERVER_EXECUTABLE_ACTIONS).toContain('diagnose');
    expect(SERVER_EXECUTABLE_ACTIONS).toContain('resolve');
    expect(SERVER_EXECUTABLE_ACTIONS).toContain('recover');
    expect(SERVER_EXECUTABLE_ACTIONS).not.toContain('execute');
    expect(SERVER_EXECUTABLE_ACTIONS).not.toContain('monitor');
  });

  it('resolve: empty evidence -> UNKNOWN, fail-closed', () => {
    const r = executeCallx402Action('resolve', { evidence: {} });
    expect(r.executed).toBe(true);
    expect(r.result.state).toBe('UNKNOWN');
    expect(r.disposition).toMatch(/no auto-retry/i);
  });

  it('diagnose: returns a report', () => {
    const r = executeCallx402Action('diagnose', {
      evidence: { error: 'timeout waiting for settle response' },
    });
    expect(r.executed).toBe(true);
    expect(r.result).toBeDefined();
    expect(typeof r.disposition).toBe('string');
  });

  it('failure_classification: returns a class', () => {
    const r = executeCallx402Action('failure_classification', {
      evidence: { error: 'invalid signature' },
    });
    expect(r.executed).toBe(true);
    expect(r.result).toBeDefined();
  });

  it('duplicate_payment_risk: paid evidence -> HIGH risk', () => {
    const r = executeCallx402Action('duplicate_payment_risk', {
      evidence: {
        txHash: '0x' + 'ab'.repeat(32),
        chain: { confirmed: true, payer: '0x1', payTo: '0x2', amount: '100000', network: 'eip155:8453' },
        expected: { payer: '0x1', payTo: '0x2', amount: '100000', network: 'eip155:8453' },
      },
    });
    expect(r.executed).toBe(true);
    expect(r.disposition).toMatch(/HIGH|LOW|UNKNOWN/);
  });

  it('execute: not server-executable', () => {
    const r = executeCallx402Action('execute', {});
    expect(r.executed).toBe(false);
    expect(r.error).toMatch(/local runtime/i);
  });

  it('recover: returns a decision', () => {
    const r = executeCallx402Action('recover', { evidence: {} });
    expect(r.executed).toBe(true);
    expect(r.result.decision).toMatch(/RECOVERABLE|SAFE_RETRY|HUMAN_REVIEW/);
  });
});
