import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, PrismaClient, VideoStatus, WorkerStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createAdminProfileUpload, createAdminVideoUpload, createDownloadUrl, createWorkerVideoUpload, finalizeAdminUpload, finalizeWorkerUpload } from '../../src/http/asset-service.js';
import { ApiError } from '../../src/http/errors.js';
import { claimNextJob, completeJob } from '../../src/http/worker-service.js';
import { FakeR2Storage } from '../helpers/fake-r2.js';

const prisma = new PrismaClient();
const storage = new FakeR2Storage();
const prefix = 'phase5-durable-edge-';
const admin = 'admin@example.com';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', adminAllowedEmails: [admin], leaseDurationSeconds: 120,
  r2: { accountId: 'edge', accessKeyId: 'never-leak', secretAccessKey: 'never-leak-secret', bucket: storage.bucket, endpoint: storage.origin, origin: storage.origin, presignTtlSeconds: 300, singleUploadThresholdBytes: 100 * 1024 * 1024, multipartPartSizeBytes: 16 * 1024 * 1024 },
};

function expectCode(error: unknown, code: string) { assert.ok(error instanceof ApiError); assert.equal(error.code, code); return true; }

async function cleanup() {
  const profiles = await prisma.profile.findMany({ where: { id: { startsWith: prefix } }, select: { id: true } });
  await prisma.videoAsset.deleteMany({ where: { OR: [{ videoId: { startsWith: prefix } }, { profileId: { in: profiles.map((p) => p.id) } }] } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.channel.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: { contains: prefix } } });
  storage.objects.clear();
}

async function makeVideo(suffix: string, status: VideoStatus = VideoStatus.DRAFT) {
  const channelId = `${prefix}channel`;
  await prisma.channel.upsert({ where: { id: channelId }, create: { id: channelId, displayName: 'Not Pausa con Fe', language: 'es-MX' }, update: {} });
  const id = `${prefix}${suffix}`;
  await prisma.video.create({ data: { id, channelId, slug: id, title: id, category: 'test', status, version: 1, legacyIncomplete: false, renderConfig: {}, metadata: {}, createdAt: new Date() } });
  return id;
}

async function readyAdminVideoAsset(videoId: string, key: string) {
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, key, key, { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size: 512n });
  const row = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } }); storage.putObject(row.objectKey!, 512n, 'video/mp4');
  return finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, key, `${key}-final`, []);
}

test.beforeEach(cleanup);

test('profile AVATAR replacement race leaves one READY and preserves independent BANNER slot', async () => {
  const channelId = `${prefix}profiles`;
  const profileId = `${prefix}youtube`;
  await prisma.channel.create({ data: { id: channelId, displayName: 'Another Channel', language: 'es-MX' } });
  await prisma.profile.create({ data: { id: profileId, channelId, platform: 'YOUTUBE' } });
  const readyProfile = async (kind: AssetKind, key: string, mime = 'image/webp') => {
    const session = await createAdminProfileUpload(prisma, storage, config, profileId, admin, key, key, { kind, mimeType: mime, size: 100n });
    const row = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } }); storage.putObject(row.objectKey!, 100n, mime);
    return finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, key, `${key}-final`, []);
  };
  await readyProfile(AssetKind.AVATAR, `${prefix}old-avatar`);
  const banner = await readyProfile(AssetKind.BANNER, `${prefix}banner`);
  const pending = await Promise.all([1, 2].map(async (n) => {
    const key = `${prefix}avatar-${n}`;
    const session = await createAdminProfileUpload(prisma, storage, config, profileId, admin, key, key, { kind: AssetKind.AVATAR, mimeType: 'image/png', size: 120n });
    const row = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } }); storage.putObject(row.objectKey!, 120n, 'image/png');
    return { key, session };
  }));
  await Promise.all(pending.map(({ key, session }) => finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, key, `${key}-final`, [])));
  assert.equal(await prisma.videoAsset.count({ where: { profileId, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: banner.id } })).status, AssetStatus.READY);
});

test('durable complete rejects PENDING, FAILED and another-video assets without false APPROVED', async () => {
  const videoId = await makeVideo('worker', VideoStatus.QUEUED);
  const otherVideoId = await makeVideo('other');
  const workerId = `${prefix}worker`;
  await prisma.worker.create({ data: { id: workerId, status: WorkerStatus.ONLINE, secretVersion: 1 } });
  const job = await claimNextJob(prisma, workerId, 120); assert.ok(job);
  const pending = await createWorkerVideoUpload(prisma, storage, config, workerId, videoId, job.leaseToken, `${prefix}worker-upload`, { mimeType: 'video/mp4', size: 1000n, sha256: 'b'.repeat(64) });
  const payload = (outputAssetId: string) => ({ rendererVideoId: 'renderer', localFile: 'local.mp4', outputAssetId, durationSeconds: 61, width: 1080, height: 1920, hasAudio: true, qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: {} } });
  await assert.rejects(() => completeJob(prisma, workerId, videoId, job.leaseToken, `${prefix}pending`, payload(pending.assetId), { requireDurableOutput: true }), (e) => expectCode(e, 'OUTPUT_ASSET_NOT_READY'));
  assert.notEqual((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status, VideoStatus.APPROVED);
  await prisma.videoAsset.update({ where: { id: pending.assetId }, data: { status: AssetStatus.FAILED } });
  await assert.rejects(() => completeJob(prisma, workerId, videoId, job.leaseToken, `${prefix}failed`, payload(pending.assetId), { requireDurableOutput: true }), (e) => expectCode(e, 'OUTPUT_ASSET_NOT_READY'));
  const other = await readyAdminVideoAsset(otherVideoId, `${prefix}other-asset`);
  await assert.rejects(() => completeJob(prisma, workerId, videoId, job.leaseToken, `${prefix}other`, payload(other.id), { requireDurableOutput: true }), (e) => expectCode(e, 'OUTPUT_ASSET_NOT_READY'));
  assert.notEqual((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status, VideoStatus.APPROVED);
});

test('worker durable READY asset from the same attempt is accepted and keeps worker SHA distinct from ETag', async () => {
  const videoId = await makeVideo('happy', VideoStatus.QUEUED);
  const workerId = `${prefix}happy-worker`;
  await prisma.worker.create({ data: { id: workerId, status: WorkerStatus.ONLINE, secretVersion: 1 } });
  const job = await claimNextJob(prisma, workerId, 120); assert.ok(job);
  const session = await createWorkerVideoUpload(prisma, storage, config, workerId, videoId, job.leaseToken, `${prefix}happy-upload`, { mimeType: 'video/mp4', size: 1000n, sha256: 'c'.repeat(64), originalFilename: 'render.mp4' });
  const row = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } }); storage.putObject(row.objectKey!, 1000n, 'video/mp4');
  const ready = await finalizeWorkerUpload(prisma, storage, config, session.sessionId, workerId, job.leaseToken, `${prefix}happy-final`, []);
  assert.equal(ready.sha256, 'c'.repeat(64)); assert.notEqual(ready.sha256, '"fake-etag"'); assert.equal(ready.hashSource, 'WORKER');
  const result = await completeJob(prisma, workerId, videoId, job.leaseToken, `${prefix}happy-complete`, { rendererVideoId: 'renderer', localFile: 'local.mp4', outputAssetId: ready.id, durationSeconds: 61, width: 1080, height: 1920, hasAudio: true, qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: {} } }, { requireDurableOutput: true });
  assert.equal(result.videoStatus, 'APPROVED');
});

test('download policy rejects PENDING/FAILED/unknown and allows READY then REPLACED history', async () => {
  const videoId = await makeVideo('download');
  const pending = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'pending', `${prefix}pending`, { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size: 100n });
  await assert.rejects(() => createDownloadUrl(prisma, storage, config, pending.assetId), (e) => expectCode(e, 'ASSET_NOT_READY'));
  await prisma.videoAsset.update({ where: { id: pending.assetId }, data: { status: AssetStatus.FAILED } });
  await assert.rejects(() => createDownloadUrl(prisma, storage, config, pending.assetId), (e) => expectCode(e, 'ASSET_NOT_READY'));
  await assert.rejects(() => createDownloadUrl(prisma, storage, config, '00000000-0000-0000-0000-000000000000'), (e) => expectCode(e, 'ASSET_NOT_FOUND'));
  const old = await readyAdminVideoAsset(videoId, `${prefix}old`);
  const current = await readyAdminVideoAsset(videoId, `${prefix}new`);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: old.id } })).status, AssetStatus.REPLACED);
  assert.match((await createDownloadUrl(prisma, storage, config, old.id)).downloadUrl, /X-Amz-Signature=/);
  assert.match((await createDownloadUrl(prisma, storage, config, current.id)).downloadUrl, /X-Amz-Signature=/);
});

test.after(async () => { await cleanup(); await prisma.$disconnect(); });
