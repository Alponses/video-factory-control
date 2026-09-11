import assert from 'node:assert/strict';
import test from 'node:test';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { discoverLegacyJobIds, loadAllLegacyJobs, snapshotLegacySources } from '../../src/legacy/source.js';
import { stableStringify } from '../../src/legacy/stable-json.js';
import { verifyLegacy } from '../../src/legacy/verifier.js';

const prisma = getPrisma();

async function cleanDatabase(): Promise<void> {
  await prisma.metricSnapshot.deleteMany();
  await prisma.publicationMetric.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.workerLease.deleteMany();
  await prisma.qaResult.deleteMany();
  await prisma.renderAttempt.deleteMany();
  await prisma.videoAsset.deleteMany();
  await prisma.videoScene.deleteMany();
  await prisma.jobEvent.deleteMany();
  await prisma.legacyImport.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.video.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.worker.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.schedulerLease.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.integrationAccount.deleteMany();
}

test('legacy importer is lossless, read-only and idempotent across three runs', async () => {
  await cleanDatabase();
  const before = await snapshotLegacySources();
  const expectedIds = await discoverLegacyJobIds();
  const sources = await loadAllLegacyJobs();

  assert.equal(expectedIds.length, 11);

  const first = await importLegacy(prisma);
  assert.equal(first.jobsDiscovered, 11);
  assert.equal(first.jobsImported, 11);
  assert.equal(first.jobsSkipped, 0);
  assert.equal(first.jobsUpdated, 0);

  const countsAfterFirst = {
    videos: await prisma.video.count({ where: { id: { in: expectedIds } } }),
    scenes: await prisma.videoScene.count({ where: { videoId: { in: expectedIds } } }),
    publications: await prisma.publication.count({ where: { videoId: { in: expectedIds } } }),
    renders: await prisma.renderAttempt.count({ where: { videoId: { in: expectedIds } } }),
    qa: await prisma.qaResult.count({ where: { videoId: { in: expectedIds } } }),
    assets: await prisma.videoAsset.count({ where: { videoId: { in: expectedIds }, storageProvider: 'LEGACY_LOCAL' } }),
    legacy: await prisma.legacyImport.count({ where: { videoId: { in: expectedIds } } }),
  };
  assert.equal(countsAfterFirst.videos, 11);
  assert.equal(countsAfterFirst.legacy, 11);

  const second = await importLegacy(prisma);
  assert.equal(second.jobsImported, 0);
  assert.equal(second.jobsUpdated, 0);
  assert.equal(second.jobsSkipped, 11);

  const third = await importLegacy(prisma);
  assert.equal(third.jobsImported, 0);
  assert.equal(third.jobsUpdated, 0);
  assert.equal(third.jobsSkipped, 11);

  const countsAfterThird = {
    videos: await prisma.video.count({ where: { id: { in: expectedIds } } }),
    scenes: await prisma.videoScene.count({ where: { videoId: { in: expectedIds } } }),
    publications: await prisma.publication.count({ where: { videoId: { in: expectedIds } } }),
    renders: await prisma.renderAttempt.count({ where: { videoId: { in: expectedIds } } }),
    qa: await prisma.qaResult.count({ where: { videoId: { in: expectedIds } } }),
    assets: await prisma.videoAsset.count({ where: { videoId: { in: expectedIds }, storageProvider: 'LEGACY_LOCAL' } }),
    legacy: await prisma.legacyImport.count({ where: { videoId: { in: expectedIds } } }),
  };
  assert.deepEqual(countsAfterThird, countsAfterFirst);

  const rows = await prisma.video.findMany({ where: { id: { in: expectedIds } }, select: { id: true } });
  assert.deepEqual(rows.map((row) => row.id).sort(), expectedIds);

  const legacyOne = await prisma.video.findUnique({
    where: { id: 'religion-000001' },
    include: { scenes: true, legacyImport: true },
  });
  assert.ok(legacyOne);
  assert.equal(legacyOne.scenes.length, 0);
  assert.equal(legacyOne.legacyIncomplete, true);

  const modern = await prisma.video.findUnique({
    where: { id: 'religion-000011' },
    include: { scenes: true, legacyImport: true, publications: true, renderAttempts: true, qaResults: true },
  });
  assert.ok(modern);
  assert.equal(modern.scenes.length, 16);
  assert.ok(modern.legacyImport?.v3Json);
  assert.ok(modern.legacyImport?.v4Json);
  assert.equal(modern.publications.length, 3);
  assert.equal(modern.renderAttempts.length, 1);
  assert.equal(modern.qaResults.length, 1);

  for (const source of sources) {
    const record = await prisma.legacyImport.findUnique({ where: { videoId: source.fileId } });
    assert.ok(record);
    assert.equal(stableStringify(record.baseJson), stableStringify(source.base.json));
    assert.equal(stableStringify(record.v3Json), stableStringify(source.v3?.json ?? null));
    assert.equal(stableStringify(record.v4Json), stableStringify(source.v4?.json ?? null));
    assert.equal(stableStringify(record.dashboardJson), stableStringify(source.dashboard?.json ?? null));
    assert.equal(stableStringify(record.effectiveJson), stableStringify(source.effective));
  }

  const after = await snapshotLegacySources();
  assert.deepEqual(after, before);

  const verification = await verifyLegacy(prisma);
  assert.equal(verification.result, 'PASS', verification.errors.join('\n'));
  assert.deepEqual(verification.duplicateIds, []);
  assert.equal(verification.jobsDiscovered, 11);
  assert.equal(verification.jobsImported, 11);
  assert.equal(verification.jobsSkipped, 11);
  assert.equal(verification.jobsUpdated, 0);
});

test.after(async () => {
  await disconnectPrisma();
});
