import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoStatus } from '@prisma/client';
import { normalizeLegacyJob } from '../../src/legacy/normalize.js';
import { loadFactoryFallbackChannel, loadLegacyJob } from '../../src/legacy/source.js';

test('religion-000001 remains legacy incomplete with zero scenes', async () => {
  const [source, fallback] = await Promise.all([
    loadLegacyJob('religion-000001'),
    loadFactoryFallbackChannel(),
  ]);
  const normalized = normalizeLegacyJob(source, fallback);

  assert.equal(normalized.id, 'religion-000001');
  assert.equal(normalized.scenes.length, 0);
  assert.equal(normalized.legacyIncomplete, true);
  assert.equal(normalized.status, VideoStatus.APPROVED);
  assert.ok(normalized.warnings.includes('scenes:0'));
  assert.ok(normalized.warnings.some((warning) => warning.startsWith('normalized channelId')));
});

test('modern historical job preserves all 16 scene positions', async () => {
  const [source, fallback] = await Promise.all([
    loadLegacyJob('religion-000011'),
    loadFactoryFallbackChannel(),
  ]);
  const normalized = normalizeLegacyJob(source, fallback);

  assert.equal(normalized.scenes.length, 16);
  assert.deepEqual(normalized.scenes.map((scene) => scene.position), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(normalized.render?.rendererVideoId, source.effective.render && typeof source.effective.render === 'object'
    ? (source.effective.render as Record<string, unknown>).videoId
    : null);
});
