import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createJsonPublisherLogger } from '../../src/publishing/logging.js';
import { exponentialBackoffMs } from '../../src/publishing/retry.js';

test('publisher structured logs expose only the Phase 7 allowlist', () => {
  const lines: string[] = [];
  const logger = createJsonPublisherLogger((line) => lines.push(line), () => new Date('2026-09-12T08:00:00Z'));
  logger.log({ publisherRunId: 'run', dispatchId: 'dispatch', publicationId: 'publication', attemptId: 'attempt', provider: 'TIKTOK', stage: 'UPLOADING', status: 'RUNNING', durationMs: 12, httpStatus: 200, providerErrorCode: 'NONE', retryable: false, caption: 'secret-caption', access_token: 'secret-token' } as never);
  const serialized = lines.join('\n');
  for (const forbidden of ['secret-caption', 'secret-token', 'access_token', 'refresh_token', 'client_secret', 'authorization_code', 'upload_url', 'resumable', 'page_access_token', 'X-Amz-Signature']) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.match(serialized, /"dispatchId":"dispatch"/);
});

test('publisher backoff is bounded and does not sleep inside a tick', async () => {
  assert.equal(exponentialBackoffMs(1, 0.5), 5000);
  assert.ok(exponentialBackoffMs(20, 1) <= 60 * 60 * 1000 * 1.25);
  const packageJson = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  assert.equal(packageJson.includes('node-cron'), false);
});
