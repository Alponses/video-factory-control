import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schedulerSource = readFileSync(new URL('../../src/scheduling/scheduler.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../../scripts/scheduler-tick.ts', import.meta.url), 'utf8');
const combined = `${schedulerSource}\n${cliSource}`;

test('Phase 6 scheduler has no social-network HTTP publishing dependency', () => {
  for (const forbidden of ['tiktokapis.com', 'googleapis.com', 'graph.facebook.com', 'videos.insert', 'video.publish']) {
    assert.equal(combined.includes(forbidden), false, `scheduler boundary must not contain ${forbidden}`);
  }
  assert.equal(/\bfetch\s*\(/.test(combined), false, 'scheduler must not make HTTP fetch calls');
});

test('Phase 6 scheduling is one-shot and contains no timer/daemon scheduler', () => {
  for (const forbidden of ['setInterval(', 'node-cron', 'setTimeout(']) assert.equal(combined.includes(forbidden), false);
});
