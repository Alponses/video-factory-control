import assert from 'node:assert/strict';
import test from 'node:test';
import { Platform } from '@prisma/client';
import { createJsonSchedulerLogger } from '../../src/scheduling/logging.js';

test('scheduler structured logging emits only run/item allowlists and strips sensitive fields', () => {
  const lines: string[] = [];
  const logger = createJsonSchedulerLogger((line) => lines.push(line), () => new Date('2026-09-12T01:00:00.000Z'));

  const runInput = {
    schedulerRunId: 'run-1', leaseOwner: 'run-1', startedAt: '2026-09-12T00:59:59.000Z', durationMs: 123,
    dueFound: 2, dispatched: 1, alreadyDispatched: 0, late: 1, failed: 1,
    caption: 'secret-caption', description: 'secret-description', hashtags: ['#secret'], payloadSnapshot: { secret: true },
    signedUrl: 'https://example.invalid/?X-Amz-Signature=secret', token: 'secret-token', DATABASE_URL: 'mysql://secret',
    R2_SECRET_ACCESS_KEY: 'secret-r2', encryptedAccessToken: 'secret-access', encryptedRefreshToken: 'secret-refresh',
  };
  logger.logRun(runInput);

  const itemInput = {
    publicationId: 'pub-1', scheduleId: 'schedule-1', dispatchId: 'dispatch-1', platform: Platform.TIKTOK,
    errorCode: 'PREFLIGHT_FAILED', latenessSeconds: 301,
    caption: 'secret-caption', description: 'secret-description', hashtags: ['#secret'], payloadSnapshot: { secret: true },
    signedUrl: 'https://example.invalid/?X-Amz-Signature=secret', token: 'secret-token', DATABASE_URL: 'mysql://secret',
    R2_ACCESS_KEY_ID: 'secret-r2', integrationAccountSecret: 'secret-integration',
  };
  logger.logItem(itemInput);

  assert.equal(lines.length, 2);
  const serialized = lines.join('\n');
  for (const forbidden of [
    'secret-caption', 'secret-description', '#secret', 'payloadSnapshot', 'X-Amz-Signature', 'secret-token',
    'DATABASE_URL', 'mysql://secret', 'R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'secret-r2',
    'encryptedAccessToken', 'encryptedRefreshToken', 'secret-access', 'secret-refresh', 'integrationAccountSecret', 'secret-integration',
  ]) assert.equal(serialized.includes(forbidden), false, `scheduler logs must not contain ${forbidden}`);

  const run = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(run).sort(), [
    'alreadyDispatched', 'dispatched', 'dueFound', 'durationMs', 'event', 'failed', 'late', 'leaseOwner', 'level', 'schedulerRunId', 'startedAt', 'timestamp',
  ].sort());
  const item = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(item).sort(), [
    'dispatchId', 'errorCode', 'event', 'latenessSeconds', 'level', 'platform', 'publicationId', 'scheduleId', 'timestamp',
  ].sort());
});
