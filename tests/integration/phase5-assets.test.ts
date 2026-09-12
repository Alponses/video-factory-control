import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, PrismaClient, VideoStatus, WorkerStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import {
  abortAdminUpload,
  assertWorkerOutputAsset,
  createAdminProfileUpload,
  createAdminVideoUpload,
  createDownloadUrl,
  createWorkerVideoUpload,
  finalizeAdminUpload,
  finalizeWorkerUpload,
  presignAdminParts,
} from '../../src/http/asset-service.js';
import { ApiError } from '../../src/http/errors.js';
import { claimNextJob, completeJob } from '../../src/http/worker-service.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { FakeR2Storage } from '../helpers/fake-r2.js';

const prisma = new PrismaClient();
const storage = new FakeR2Storage();
const prefix = 'phase5-';
const admin = 'admin@example.com';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', adminAllowedEmails: [admin], workerOfflineThresholdSeconds: 60, leaseDurationSeconds: 120,
  r2: { accountId: 'test-account', accessKeyId: 'permanent-access-key-must-never-leak', secretAccessKey: 'permanent-secret-must-never-leak', bucket: storage.bucket, endpoint: storage.origin, origin: storage.origin, presignTtlSeconds: 300, singleUploadThresholdBytes: 100 * 1024 * 1024, multipartPartSizeBytes: 16 * 1024 * 1024 },
};

await importLegacy(prisma);

async function cleanup() {
  const profiles = await prisma.profile.findMany({ where: { id: { startsWith: prefix } }, select: { id: true } });
  await prisma.videoAsset.deleteMany({ where: { OR: [{ videoId: { startsWith: prefix } }, { profileId: { in: profiles.map((item) => item.id) } }] } });
  await prisma.auditLog.deleteMany({ where: { action: { in: ['ASSET_UPLOAD_CREATED', 'ASSET_UPLOAD_COMPLETED', 'ASSET_REPLACED', 'ASSET_UPLOAD_ABORTED', 'PROFILE_AVATAR_CHANGED', 'PROFILE_BANNER_CHANGED'] } } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: { contains: prefix } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.channel.deleteMany({ where: { id: { startsWith: prefix } } });
  storage.objects.clear();
  storage.aborted.length = 0;
  storage.completed.length = 0;
}

async function makeVideo(id: string, status: VideoStatus = VideoStatus.DRAFT) {
  const channelId = `${prefix}channel`;
  await prisma.channel.upsert({ where: { id: channelId }, create: { id: channelId, displayName: 'Phase 5', language: 'es-MX' }, update: {} });
  return prisma.video.create({ data: { id, channelId, slug: id, title: id, category: 'phase5-test', status, version: 1, legacyIncomplete: false, renderConfig: {}, metadata: {}, createdAt: new Date() } });
}

async function readyVideoAsset(videoId: string, kind: AssetKind, key: string, size = 1024n, mimeType = kind === AssetKind.VIDEO ? 'video/mp4' : 'image/webp') {
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, key, key, { kind, mimeType, size, originalFilename: '../../evil/../foo/bar.file' });
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
  assert.ok(asset.objectKey);
  storage.putObject(asset.objectKey, size, mimeType);
  return finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, key, `${key}-finish`, []);
}

function expectCode(error: unknown, code: string) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  return true;
}

test.beforeEach(cleanup);

test('server-generated object key ignores traversal filename; MIME and size policy reject unsafe inputs', async () => {
  const videoId = `${prefix}object-key`;
  await makeVideo(videoId);
  const created = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'req-key', 'create-key-001', { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size: 1024n, originalFilename: '../../evil.mp4' });
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: created.assetId } });
  assert.equal(asset.objectKey, `channels/${prefix}channel/videos/${videoId}/assets/${asset.id}/video.mp4`);
  assert.equal(asset.objectKey.includes('evil'), false);
  assert.equal(JSON.stringify(created).includes(config.r2!.accessKeyId), false);
  assert.equal(JSON.stringify(created).includes(config.r2!.secretAccessKey), false);
  assert.match(created.uploadUrl ?? '', /X-Amz-Signature=/);
  assert.match(created.uploadUrl ?? '', /X-Amz-Expires=300/);

  await assert.rejects(() => createAdminVideoUpload(prisma, storage, config, videoId, admin, 'bad-mime', 'create-key-002', { kind: AssetKind.VIDEO, mimeType: 'text/html', size: 10n }), (error) => expectCode(error, 'ASSET_INVALID_TYPE'));
  await assert.rejects(() => createAdminVideoUpload(prisma, storage, config, videoId, admin, 'bad-size', 'create-key-003', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 21n * 1024n * 1024n }), (error) => expectCode(error, 'ASSET_TOO_LARGE'));
});

test('single upload finalizes only after HEAD size/type match and duplicate finalize is idempotent', async () => {
  const videoId = `${prefix}single`;
  await makeVideo(videoId);
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'single', 'single-create-key', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 2048n, sha256: 'a'.repeat(64), originalFilename: 'cover.webp' });
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
  storage.putObject(asset.objectKey!, 2048n, 'image/webp');
  const first = await finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, 'single', 'single-finalize-key', []);
  const second = await finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, 'single', 'single-finalize-key', []);
  assert.deepEqual(second, first);
  assert.equal(first.status, 'READY');
  assert.equal(first.sha256, 'a'.repeat(64));
  assert.equal(first.hashSource, 'BROWSER_ASSERTED');
  assert.equal(await prisma.videoAsset.count({ where: { videoId, kind: AssetKind.COVER, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.assetUploadSession.count({ where: { assetId: asset.id } }), 1);
  const download = await createDownloadUrl(prisma, storage, config, asset.id);
  assert.match(download.downloadUrl, /X-Amz-Signature=/);
});

test('HEAD mismatch fails the new upload and never replaces current READY asset', async () => {
  const videoId = `${prefix}mismatch`;
  await makeVideo(videoId);
  const old = await readyVideoAsset(videoId, AssetKind.COVER, 'old-cover');
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'mismatch', 'new-cover-create', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 4096n });
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
  storage.putObject(asset.objectKey!, 4095n, 'image/webp');
  await assert.rejects(() => finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, 'mismatch', 'new-cover-finish', []), (error) => expectCode(error, 'R2_OBJECT_SIZE_MISMATCH'));
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: old.id } })).status, AssetStatus.READY);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: asset.id } })).status, AssetStatus.FAILED);
});

test('replacement is atomic and two successful competing replacements leave exactly one READY slot', async () => {
  const videoId = `${prefix}replace`;
  await makeVideo(videoId);
  const original = await readyVideoAsset(videoId, AssetKind.THUMBNAIL, 'original-thumb');
  const one = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'one', 'replace-one', { kind: AssetKind.THUMBNAIL, mimeType: 'image/png', size: 500n });
  const two = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'two', 'replace-two', { kind: AssetKind.THUMBNAIL, mimeType: 'image/png', size: 500n });
  for (const item of [one, two]) {
    const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: item.assetId } });
    storage.putObject(asset.objectKey!, 500n, 'image/png');
  }
  await Promise.all([
    finalizeAdminUpload(prisma, storage, config, one.sessionId, admin, 'one', 'replace-one-finish', []),
    finalizeAdminUpload(prisma, storage, config, two.sessionId, admin, 'two', 'replace-two-finish', []),
  ]);
  const assets = await prisma.videoAsset.findMany({ where: { videoId, kind: AssetKind.THUMBNAIL } });
  assert.equal(assets.filter((asset) => asset.status === AssetStatus.READY).length, 1);
  assert.equal(assets.filter((asset) => asset.status === AssetStatus.REPLACED).length, 2);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: original.id } })).status, AssetStatus.REPLACED);
});

test('multipart validates part numbers, completes READY and abort prevents completion', async () => {
  const videoId = `${prefix}multipart`;
  await makeVideo(videoId);
  const size = 100n * 1024n * 1024n + 1n;
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'multi', 'multipart-create', { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size });
  assert.equal(session.mode, 'MULTIPART');
  assert.equal(session.uploadUrl, null);
  await assert.rejects(() => presignAdminParts(prisma, storage, config, session.sessionId, admin, [0]), (error) => expectCode(error, 'MULTIPART_INVALID_PART'));
  const signed = await presignAdminParts(prisma, storage, config, session.sessionId, admin, [1, 7]);
  assert.equal(signed.parts.length, 2);
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
  storage.putObject(asset.objectKey!, size, 'video/mp4');
  const parts = Array.from({ length: 7 }, (_, index) => ({ partNumber: index + 1, eTag: `"part-${index + 1}"` }));
  const ready = await finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, 'multi', 'multipart-finish', parts);
  assert.equal(ready.status, 'READY');
  assert.equal(storage.completed.length, 1);

  const aborted = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'abort', 'multipart-abort', { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size });
  await abortAdminUpload(prisma, storage, aborted.sessionId, admin, 'abort');
  await assert.rejects(() => finalizeAdminUpload(prisma, storage, config, aborted.sessionId, admin, 'abort', 'multipart-abort-finish', parts), (error) => expectCode(error, 'UPLOAD_SESSION_EXPIRED'));
  assert.ok(storage.aborted.length >= 1);
});

test('same create Idempotency-Key racing returns one logical asset/session', async () => {
  const videoId = `${prefix}idempotency`;
  await makeVideo(videoId);
  const input = { kind: AssetKind.COVER, mimeType: 'image/webp', size: 1024n };
  const [a, b] = await Promise.all([
    createAdminVideoUpload(prisma, storage, config, videoId, admin, 'idem-a', 'same-create-key', input),
    createAdminVideoUpload(prisma, storage, config, videoId, admin, 'idem-b', 'same-create-key', input),
  ]);
  assert.equal(a.assetId, b.assetId);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(await prisma.videoAsset.count({ where: { videoId, kind: AssetKind.COVER } }), 1);
});

test('profile avatar/banner slots remain independent across TikTok YouTube and Facebook', async () => {
  const channelId = `${prefix}profiles-channel`;
  await prisma.channel.create({ data: { id: channelId, displayName: 'Pausa con Fe', language: 'es-MX' } });
  const profiles = await Promise.all(['TIKTOK', 'YOUTUBE', 'FACEBOOK'].map((platform) => prisma.profile.create({ data: { id: `${prefix}${platform.toLowerCase()}`, channelId, platform: platform as 'TIKTOK' | 'YOUTUBE' | 'FACEBOOK' } })));
  const byPlatform = Object.fromEntries(profiles.map((profile) => [profile.platform, profile]));
  const uploads: Array<[string, AssetKind]> = [
    [byPlatform.TIKTOK!.id, AssetKind.AVATAR],
    [byPlatform.YOUTUBE!.id, AssetKind.AVATAR], [byPlatform.YOUTUBE!.id, AssetKind.BANNER],
    [byPlatform.FACEBOOK!.id, AssetKind.AVATAR], [byPlatform.FACEBOOK!.id, AssetKind.BANNER],
  ];
  for (const [profileId, kind] of uploads) {
    const key = `${profileId}-${kind}`;
    const session = await createAdminProfileUpload(prisma, storage, config, profileId, admin, key, key, { kind, mimeType: 'image/webp', size: 100n });
    const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
    storage.putObject(asset.objectKey!, 100n, 'image/webp');
    await finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, key, `${key}-finish`, []);
  }
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.TIKTOK!.id, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.YOUTUBE!.id, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.YOUTUBE!.id, kind: AssetKind.BANNER, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.FACEBOOK!.id, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.FACEBOOK!.id, kind: AssetKind.BANNER, status: AssetStatus.READY } }), 1);

  const youtube = byPlatform.YOUTUBE!;
  const replacement = await createAdminProfileUpload(prisma, storage, config, youtube.id, admin, 'yt-replace', 'yt-avatar-replace', { kind: AssetKind.AVATAR, mimeType: 'image/png', size: 120n });
  const newAsset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: replacement.assetId } });
  storage.putObject(newAsset.objectKey!, 120n, 'image/png');
  await finalizeAdminUpload(prisma, storage, config, replacement.sessionId, admin, 'yt-replace', 'yt-avatar-replace-finish', []);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: youtube.id, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
  assert.equal(await prisma.videoAsset.count({ where: { profileId: byPlatform.TIKTOK!.id, kind: AssetKind.AVATAR, status: AssetStatus.READY } }), 1);
});

test('worker QA-passed output becomes APPROVED only after current-attempt R2 asset is READY', async () => {
  const videoId = `${prefix}worker-video`;
  const workerId = `${prefix}worker`;
  await makeVideo(videoId, VideoStatus.QUEUED);
  await prisma.worker.create({ data: { id: workerId, status: WorkerStatus.ONLINE, secretVersion: 1 } });
  const job = await claimNextJob(prisma, workerId, 120);
  assert.ok(job);
  const session = await createWorkerVideoUpload(prisma, storage, config, workerId, videoId, job.leaseToken, 'worker-upload-key', { mimeType: 'video/mp4', size: 10_000n, sha256: 'b'.repeat(64), originalFilename: 'render.mp4' });
  const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: session.assetId } });
  storage.putObject(asset.objectKey!, 10_000n, 'video/mp4');
  const ready = await finalizeWorkerUpload(prisma, storage, config, session.sessionId, workerId, job.leaseToken, 'worker-finalize-key', []);
  await assertWorkerOutputAsset(prisma, storage, workerId, videoId, job.leaseToken, ready.id);
  const result = await completeJob(prisma, workerId, videoId, job.leaseToken, 'worker-complete-key', {
    rendererVideoId: 'renderer-phase5', localFile: 'worker-output/local.mp4', outputAssetId: ready.id, durationSeconds: 61, width: 1080, height: 1920, hasAudio: true,
    qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: {} },
  }, { requireDurableOutput: true });
  assert.equal(result.videoStatus, 'APPROVED');
  assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status, VideoStatus.APPROVED);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: ready.id } })).status, AssetStatus.READY);
  const attempt = await prisma.renderAttempt.findFirstOrThrow({ where: { videoId }, orderBy: { attempt: 'desc' } });
  assert.equal(attempt.status, 'SUCCEEDED');
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
