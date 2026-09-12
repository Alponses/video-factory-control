import assert from 'node:assert/strict';
import test from 'node:test';
import { log } from '../src/logger.js';

test('worker logger emits only allowlisted operational fields', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    log('error', {
      workerId: 'imac-01',
      event: 'redaction-test',
      videoId: 'religion-000011',
      errorCode: 'SAFE_CODE',
      workerSecret: 'vfws_should_never_log',
      authorization: 'Bearer should-never-log',
      cfAccessClientSecret: 'cf-should-never-log',
      cfAccessJwtAssertion: 'jwt-should-never-log',
      leaseToken: 'vfl_should-never-log',
      leaseTokenHash: 'lease-hash-should-never-log',
      databaseUrl: 'mysql://should-never-log',
      secretHash: 'worker-hash-should-never-log',
    } as never);
  } finally {
    process.stdout.write = originalWrite;
  }
  const entry = JSON.parse(output) as Record<string, unknown>;
  assert.equal(entry.workerId, 'imac-01');
  assert.equal(entry.errorCode, 'SAFE_CODE');
  for (const marker of ['vfws_should_never_log', 'Bearer should-never-log', 'cf-should-never-log', 'jwt-should-never-log', 'vfl_should-never-log', 'lease-hash-should-never-log', 'mysql://should-never-log', 'worker-hash-should-never-log']) {
    assert.equal(output.includes(marker), false);
  }
});
