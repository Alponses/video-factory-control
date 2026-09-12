import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient, RenderAttemptStatus, VideoStatus, WorkerStatus } from '@prisma/client';
import { ApiError } from '../../src/http/errors.js';
import { claimNextJob, completeJob, failJob, queueRender, rerenderVideo, type CompleteInput } from '../../src/http/worker-service.js';
import { importLegacy } from '../../src/legacy/importer.js';

const prisma = new PrismaClient();
const prefix = 'phase4-final-';
const completion: CompleteInput = {
  rendererVideoId: 'renderer-phase4',
  localFile: 'worker-output/phase4.mp4',
  durationSeconds: 61,
  width: 1080,
  height: 1920,
  hasAudio: true,
  qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: { source: 'ffprobe' } },
};

await importLegacy(prisma);

async function cleanup() {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS phase4_idempotency_abort');
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: prefix } } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: { contains: prefix } } });
}

async function worker(id: string) {
  return prisma.worker.create({ data: { id, status: WorkerStatus.ONLINE, secretVersion: 1 } });
}

async function video(id: string, status: VideoStatus) {
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

async function claimed(id: string) {
  const workerId = `${id}-worker`;
  await worker(workerId);
  await video(id, VideoStatus.QUEUED);
  const job = await claimNextJob(prisma, workerId, 120);
  assert.ok(job);
  return { workerId, job };
}

function expectApiCode(error: unknown, code: string) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  return true;
}

async function installIdempotencyAbortTrigger() {
  await prisma.$executeRawUnsafe("CREATE TRIGGER phase4_idempotency_abort BEFORE INSERT ON idempotency_keys FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'phase4 forced rollback'");
}

test.beforeEach(cleanup);

test('complete is idempotent for same key/payload and conflicts for same key/different payload', async () => {
  const id = `${prefix}complete`;
  const { workerId, job } = await claimed(id);
  const first = await completeJob(prisma, workerId, id, job.leaseToken, 'complete-key-0001', completion);
  const second = await completeJob(prisma, workerId, id, job.leaseToken, 'complete-key-0001', completion);
  assert.deepEqual(second, first);
  assert.equal(await prisma.qaResult.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RENDER_COMPLETED' } }), 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.workerLease.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.idempotencyKey.count({ where: { scope: { contains: id }, key: 'complete-key-0001' } }), 1);
  assert.equal((await prisma.video.findUniqueOrThrow({ where: { id } })).status, VideoStatus.APPROVED);

  await assert.rejects(
    () => completeJob(prisma, workerId, id, job.leaseToken, 'complete-key-0001', { ...completion, durationSeconds: 75 }),
    (error) => expectApiCode(error, 'IDEMPOTENCY_CONFLICT'),
  );
});

test('fail is idempotent for same key/payload and conflicts for same key/different payload', async () => {
  const id = `${prefix}fail`;
  const { workerId, job } = await claimed(id);
  const input = { errorCode: 'RENDERER_FAILED', safeErrorMessage: 'renderer failed safely' };
  const first = await failJob(prisma, workerId, id, job.leaseToken, 'fail-key-0001', input);
  const second = await failJob(prisma, workerId, id, job.leaseToken, 'fail-key-0001', input);
  assert.deepEqual(second, first);
  assert.equal(await prisma.qaResult.count({ where: { videoId: id } }), 0);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RENDER_FAILED' } }), 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.workerLease.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.idempotencyKey.count({ where: { scope: { contains: id }, key: 'fail-key-0001' } }), 1);
  assert.equal((await prisma.video.findUniqueOrThrow({ where: { id } })).status, VideoStatus.FAILED);

  await assert.rejects(
    () => failJob(prisma, workerId, id, job.leaseToken, 'fail-key-0001', { ...input, safeErrorMessage: 'different payload' }),
    (error) => expectApiCode(error, 'IDEMPOTENCY_CONFLICT'),
  );
});

test('complete rolls back RenderAttempt, QaResult, lease, Video, JobEvent and Worker when final write fails', async () => {
  const id = `${prefix}rollback-complete`;
  const { workerId, job } = await claimed(id);
  await installIdempotencyAbortTrigger();
  await assert.rejects(() => completeJob(prisma, workerId, id, job.leaseToken, 'rollback-complete-key', completion));
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS phase4_idempotency_abort');

  const attempt = await prisma.renderAttempt.findFirstOrThrow({ where: { videoId: id, attempt: 1 } });
  const lease = await prisma.workerLease.findFirstOrThrow({ where: { videoId: id } });
  const storedVideo = await prisma.video.findUniqueOrThrow({ where: { id } });
  const storedWorker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(attempt.status, RenderAttemptStatus.RUNNING);
  assert.equal(attempt.rendererVideoId, null);
  assert.equal(attempt.finishedAt, null);
  assert.equal(await prisma.qaResult.count({ where: { videoId: id } }), 0);
  assert.equal(lease.releasedAt, null);
  assert.equal(storedVideo.status, VideoStatus.RENDERING);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: { in: ['RENDER_COMPLETED', 'QA_FAILED'] } } }), 0);
  assert.equal(storedWorker.status, WorkerStatus.BUSY);
  assert.equal(storedWorker.currentVideoId, id);
  assert.equal(await prisma.idempotencyKey.count({ where: { scope: { contains: id } } }), 0);
});

test('fail rolls back RenderAttempt, lease, Video, JobEvent and Worker when final write fails', async () => {
  const id = `${prefix}rollback-fail`;
  const { workerId, job } = await claimed(id);
  await installIdempotencyAbortTrigger();
  await assert.rejects(() => failJob(prisma, workerId, id, job.leaseToken, 'rollback-fail-key', { errorCode: 'FORCED_FAILURE', safeErrorMessage: 'safe' }));
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS phase4_idempotency_abort');

  const attempt = await prisma.renderAttempt.findFirstOrThrow({ where: { videoId: id, attempt: 1 } });
  const lease = await prisma.workerLease.findFirstOrThrow({ where: { videoId: id } });
  const storedVideo = await prisma.video.findUniqueOrThrow({ where: { id } });
  const storedWorker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
  assert.equal(attempt.status, RenderAttemptStatus.RUNNING);
  assert.equal(attempt.finishedAt, null);
  assert.equal(lease.releasedAt, null);
  assert.equal(storedVideo.status, VideoStatus.RENDERING);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RENDER_FAILED' } }), 0);
  assert.equal(storedWorker.status, WorkerStatus.BUSY);
  assert.equal(storedWorker.currentVideoId, id);
  assert.equal(await prisma.idempotencyKey.count({ where: { scope: { contains: id } } }), 0);
});

test('queue-render transitions DRAFT/READY with AuditLog + JobEvent and rejects stale/active work', async () => {
  const draft = `${prefix}queue-draft`;
  await video(draft, VideoStatus.DRAFT);
  const queued = await queueRender(prisma, draft, 1, 'admin@example.com', 'queue-request');
  assert.deepEqual(queued, { id: draft, status: 'QUEUED', version: 2 });
  assert.equal(await prisma.jobEvent.count({ where: { videoId: draft, type: 'RENDER_QUEUED' } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityId: draft, action: 'VIDEO_QUEUE_RENDER' } }), 1);

  const stale = `${prefix}queue-stale`;
  await video(stale, VideoStatus.READY);
  await assert.rejects(() => queueRender(prisma, stale, 99, 'admin@example.com', 'stale-request'), (error) => expectApiCode(error, 'VIDEO_VERSION_CONFLICT'));

  const activeAttempt = `${prefix}queue-active-attempt`;
  await video(activeAttempt, VideoStatus.DRAFT);
  await prisma.renderAttempt.create({ data: { videoId: activeAttempt, attempt: 1, status: RenderAttemptStatus.RUNNING, raw: {} } });
  await assert.rejects(() => queueRender(prisma, activeAttempt, 1, 'admin@example.com', 'active-request'), (error) => expectApiCode(error, 'VIDEO_RENDER_ACTIVE'));

  const activeLease = `${prefix}queue-active-lease`;
  const activeWorker = `${prefix}queue-worker`;
  await worker(activeWorker);
  await video(activeLease, VideoStatus.DRAFT);
  await prisma.workerLease.create({ data: { videoId: activeLease, workerId: activeWorker, leaseTokenHash: `test-${Date.now()}`, claimedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) } });
  await assert.rejects(() => queueRender(prisma, activeLease, 1, 'admin@example.com', 'lease-request'), (error) => expectApiCode(error, 'VIDEO_RENDER_ACTIVE'));
});

test('queue-render transaction rolls back status and JobEvent when audit write fails', async () => {
  const id = `${prefix}queue-rollback`;
  await video(id, VideoStatus.DRAFT);
  await assert.rejects(() => queueRender(prisma, id, 1, 'admin@example.com', 'queue-rollback', async () => { throw new Error('forced audit failure'); }));
  const stored = await prisma.video.findUniqueOrThrow({ where: { id } });
  assert.equal(stored.status, VideoStatus.DRAFT);
  assert.equal(stored.version, 1);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RENDER_QUEUED' } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { entityId: id, action: 'VIDEO_QUEUE_RENDER' } }), 0);
});

test('rerender accepts FAILED/APPROVED, rejects PUBLISHED, preserves attempts and enforces version', async () => {
  for (const status of [VideoStatus.FAILED, VideoStatus.APPROVED]) {
    const id = `${prefix}rerender-${status.toLowerCase()}`;
    await video(id, status);
    await prisma.renderAttempt.create({ data: { videoId: id, attempt: 1, status: RenderAttemptStatus.SUCCEEDED, raw: { historical: true } } });
    const result = await rerenderVideo(prisma, id, 1, 'admin@example.com', `rerender-${status}`);
    assert.equal(result.status, 'QUEUED');
    assert.equal(await prisma.renderAttempt.count({ where: { videoId: id } }), 1);
    assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RERENDER_QUEUED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: id, action: 'VIDEO_RERENDER' } }), 1);
  }

  const published = `${prefix}rerender-published`;
  await video(published, VideoStatus.PUBLISHED);
  await assert.rejects(() => rerenderVideo(prisma, published, 1, 'admin@example.com', 'published'), (error) => expectApiCode(error, 'VIDEO_ALREADY_PUBLISHED'));

  const stale = `${prefix}rerender-stale`;
  await video(stale, VideoStatus.FAILED);
  await assert.rejects(() => rerenderVideo(prisma, stale, 2, 'admin@example.com', 'stale'), (error) => expectApiCode(error, 'VIDEO_VERSION_CONFLICT'));
});

test('rerender transaction rolls back when audit write fails', async () => {
  const id = `${prefix}rerender-rollback`;
  await video(id, VideoStatus.FAILED);
  await prisma.renderAttempt.create({ data: { videoId: id, attempt: 1, status: RenderAttemptStatus.FAILED, error: 'old failure', raw: {} } });
  await assert.rejects(() => rerenderVideo(prisma, id, 1, 'admin@example.com', 'rerender-rollback', async () => { throw new Error('forced audit failure'); }));
  const stored = await prisma.video.findUniqueOrThrow({ where: { id } });
  assert.equal(stored.status, VideoStatus.FAILED);
  assert.equal(stored.version, 1);
  assert.equal(await prisma.renderAttempt.count({ where: { videoId: id } }), 1);
  assert.equal(await prisma.jobEvent.count({ where: { videoId: id, type: 'RERENDER_QUEUED' } }), 0);
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
