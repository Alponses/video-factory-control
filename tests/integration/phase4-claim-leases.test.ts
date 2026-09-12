import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient, RenderAttemptStatus, VideoStatus, WorkerStatus } from '@prisma/client';
import { ApiError } from '../../src/http/errors.js';
import { claimNextJob, completeJob, failJob, renewLease, reportProgress } from '../../src/http/worker-service.js';
import { importLegacy } from '../../src/legacy/importer.js';

const prisma = new PrismaClient();
const prefix = 'phase4-claim-';

await importLegacy(prisma);

async function cleanup() {
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: prefix } } });
}

async function worker(id: string) {
  return prisma.worker.create({ data: { id, status: WorkerStatus.ONLINE, secretVersion: 1 } });
}

async function video(id: string, status: VideoStatus = VideoStatus.QUEUED) {
  return prisma.video.create({
    data: {
      id,
      channelId: 'religion-es',
      slug: id,
      title: id,
      category: 'phase4-test',
      status,
      version: 1,
      legacyIncomplete: false,
      renderConfig: { orientation: 'portrait' },
      metadata: { phase4Test: true },
      createdAt: new Date(),
    },
  });
}

function expectApiCode(error: unknown, code: string) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  return true;
}

test.beforeEach(cleanup);

test('one QUEUED video and one worker yields one claim', async () => {
  await worker(`${prefix}worker-1`);
  await video(`${prefix}video-1`);
  const claimed = await claimNextJob(prisma, `${prefix}worker-1`, 120);
  assert.equal(claimed?.video.id, `${prefix}video-1`);
  assert.equal(await prisma.workerLease.count({ where: { videoId: `${prefix}video-1`, releasedAt: null } }), 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: `${prefix}video-1` } }), 1);
});

test('two simultaneous workers competing for one QUEUED video produce exactly one claim', async () => {
  await Promise.all([worker(`${prefix}worker-1`), worker(`${prefix}worker-2`)]);
  await video(`${prefix}video-1`);
  const results = await Promise.all([
    claimNextJob(prisma, `${prefix}worker-1`, 120),
    claimNextJob(prisma, `${prefix}worker-2`, 120),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal(await prisma.workerLease.count({ where: { videoId: `${prefix}video-1`, releasedAt: null } }), 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: `${prefix}video-1` } }), 1);
});

test('ten simultaneous claims for one QUEUED video produce exactly one success and nine empty results', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `${prefix}worker-${index + 1}`);
  await prisma.worker.createMany({ data: ids.map((id) => ({ id, status: WorkerStatus.ONLINE, secretVersion: 1 })) });
  await video(`${prefix}video-1`);
  const results = await Promise.all(ids.map((id) => claimNextJob(prisma, id, 120)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result === null).length, 9);
  assert.equal(await prisma.workerLease.count({ where: { videoId: `${prefix}video-1`, releasedAt: null } }), 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: `${prefix}video-1` } }), 1);
});

test('two QUEUED videos and two workers receive different jobs', async () => {
  await prisma.worker.createMany({ data: [1, 2].map((index) => ({ id: `${prefix}worker-${index}`, status: WorkerStatus.ONLINE, secretVersion: 1 })) });
  await video(`${prefix}video-1`);
  await video(`${prefix}video-2`);
  const results = await Promise.all([
    claimNextJob(prisma, `${prefix}worker-1`, 120),
    claimNextJob(prisma, `${prefix}worker-2`, 120),
  ]);
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(new Set(results.map((result) => result?.video.id)).size, 2);
  assert.equal(await prisma.workerLease.count({ where: { videoId: { startsWith: `${prefix}video-` }, releasedAt: null } }), 2);
});

test('zero QUEUED videos returns no claim', async () => {
  await worker(`${prefix}worker-1`);
  assert.equal(await claimNextJob(prisma, `${prefix}worker-1`, 120), null);
});

test('valid lease allows progress; wrong token and different worker are rejected', async () => {
  await Promise.all([worker(`${prefix}worker-1`), worker(`${prefix}worker-2`)]);
  await video(`${prefix}video-1`);
  const job = await claimNextJob(prisma, `${prefix}worker-1`, 120);
  assert.ok(job);
  assert.equal((await reportProgress(prisma, `${prefix}worker-1`, job.video.id, job.leaseToken, 25, 'RENDERING')).progress, 25);
  await assert.rejects(() => reportProgress(prisma, `${prefix}worker-1`, job.video.id, 'vfl_wrong-token', 30, 'RENDERING'), (error) => expectApiCode(error, 'LEASE_INVALID'));
  await assert.rejects(() => reportProgress(prisma, `${prefix}worker-2`, job.video.id, job.leaseToken, 30, 'RENDERING'), (error) => expectApiCode(error, 'LEASE_NOT_OWNER'));
});

test('valid renew extends expiration; expired renew is rejected', async () => {
  await worker(`${prefix}worker-1`);
  await video(`${prefix}video-1`);
  const job = await claimNextJob(prisma, `${prefix}worker-1`, 30);
  assert.ok(job);
  const before = new Date(job.leaseExpiresAt).getTime();
  const renewed = await renewLease(prisma, `${prefix}worker-1`, job.video.id, job.leaseToken, 120);
  assert.ok(new Date(renewed.leaseExpiresAt).getTime() > before);
  await prisma.workerLease.updateMany({ where: { videoId: job.video.id, releasedAt: null }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => renewLease(prisma, `${prefix}worker-1`, job.video.id, job.leaseToken, 120), (error) => expectApiCode(error, 'LEASE_EXPIRED'));
});

test('released lease cannot report progress', async () => {
  await worker(`${prefix}worker-1`);
  await video(`${prefix}video-1`);
  const job = await claimNextJob(prisma, `${prefix}worker-1`, 120);
  assert.ok(job);
  await prisma.workerLease.updateMany({ where: { videoId: job.video.id, releasedAt: null }, data: { releasedAt: new Date() } });
  await assert.rejects(() => reportProgress(prisma, `${prefix}worker-1`, job.video.id, job.leaseToken, 50, 'RENDERING'), (error) => expectApiCode(error, 'LEASE_INVALID'));
});

test('expired lease is reclaimed without overwriting attempt #1 and stale worker loses all mutation rights', async () => {
  await Promise.all([worker(`${prefix}worker-old`), worker(`${prefix}worker-new`)]);
  await video(`${prefix}video-reclaim`);
  const oldJob = await claimNextJob(prisma, `${prefix}worker-old`, 120);
  assert.ok(oldJob);
  await prisma.workerLease.updateMany({ where: { videoId: oldJob.video.id, releasedAt: null }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

  const newJob = await claimNextJob(prisma, `${prefix}worker-new`, 120);
  assert.ok(newJob);
  assert.equal(newJob.attempt, 2);
  const attempts = await prisma.renderAttempt.findMany({ where: { videoId: oldJob.video.id }, orderBy: { attempt: 'asc' } });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.attempt, 1);
  assert.equal(attempts[0]?.status, RenderAttemptStatus.FAILED);
  assert.equal(attempts[0]?.error, 'LEASE_EXPIRED');
  assert.equal(attempts[1]?.attempt, 2);
  assert.equal(attempts[1]?.status, RenderAttemptStatus.RUNNING);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: oldJob.video.id, type: 'LEASE_EXPIRED_REQUEUED' } }), 1);

  await assert.rejects(() => reportProgress(prisma, `${prefix}worker-old`, oldJob.video.id, oldJob.leaseToken, 50, 'RENDERING'));
  await assert.rejects(() => renewLease(prisma, `${prefix}worker-old`, oldJob.video.id, oldJob.leaseToken, 120));
  await assert.rejects(() => completeJob(prisma, `${prefix}worker-old`, oldJob.video.id, oldJob.leaseToken, 'old-complete-key', {
    rendererVideoId: 'old-renderer', localFile: 'worker-output/old.mp4', durationSeconds: 61, width: 1080, height: 1920, hasAudio: true,
    qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: {} },
  }));
  await assert.rejects(() => failJob(prisma, `${prefix}worker-old`, oldJob.video.id, oldJob.leaseToken, 'old-fail-key', { errorCode: 'OLD_WORKER', safeErrorMessage: 'stale' }));

  const progress = await reportProgress(prisma, `${prefix}worker-new`, newJob.video.id, newJob.leaseToken, 55, 'RENDERING');
  assert.equal(progress.progress, 55);
  assert.equal(await prisma.workerLease.count({ where: { videoId: oldJob.video.id, releasedAt: null, leaseExpiresAt: { gt: new Date() } } }), 1);
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
