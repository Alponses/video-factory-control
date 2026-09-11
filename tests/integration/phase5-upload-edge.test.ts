import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, AssetUploadStatus, PrismaClient, VideoStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { abortAdminUpload, createAdminVideoUpload, finalizeAdminUpload, presignAdminParts } from '../../src/http/asset-service.js';
import { ApiError } from '../../src/http/errors.js';
import { FakeR2Storage } from '../helpers/fake-r2.js';

const prisma = new PrismaClient();
const storage = new FakeR2Storage();
const prefix = 'phase5-upload-edge-';
const admin = 'admin@example.com';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', adminAllowedEmails: [admin],
  r2: { accountId: 'edge', accessKeyId: 'never-leak', secretAccessKey: 'never-leak-secret', bucket: storage.bucket, endpoint: storage.origin, origin: storage.origin, presignTtlSeconds: 300, singleUploadThresholdBytes: 100 * 1024 * 1024, multipartPartSizeBytes: 16 * 1024 * 1024 },
};

function expectCode(error: unknown, code: string) { assert.ok(error instanceof ApiError); assert.equal(error.code, code); return true; }

async function cleanup() {
  await prisma.videoAsset.deleteMany({ where: { videoId: { startsWith: prefix } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.channel.deleteMany({ where: { id: `${prefix}channel` } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: { contains: prefix } } });
  storage.objects.clear(); storage.aborted.length = 0; storage.completed.length = 0;
}

async function makeVideo(suffix: string) {
  const channelId = `${prefix}channel`;
  await prisma.channel.upsert({ where: { id: channelId }, create: { id: channelId, language: 'es-MX' }, update: {} });
  const id = `${prefix}${suffix}`;
  await prisma.video.create({ data: { id, channelId, slug: id, title: id, category: 'test', status: VideoStatus.DRAFT, version: 1, legacyIncomplete: false, renderConfig: {}, metadata: {}, createdAt: new Date() } });
  return id;
}

test.beforeEach(cleanup);

test('create idempotency reuses one asset/session and conflicts on different payload', async () => {
  const videoId = await makeVideo('idem');
  const first = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'r1', 'stable-edge-key', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 100n });
  const second = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'r2', 'stable-edge-key', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 100n });
  assert.equal(second.assetId, first.assetId); assert.equal(second.sessionId, first.sessionId);
  assert.equal(await prisma.videoAsset.count({ where: { videoId, kind: AssetKind.COVER } }), 1);
  await assert.rejects(() => createAdminVideoUpload(prisma, storage, config, videoId, admin, 'r3', 'stable-edge-key', { kind: AssetKind.COVER, mimeType: 'image/webp', size: 101n }), (e) => expectCode(e, 'IDEMPOTENCY_CONFLICT'));
});

test('HEAD MIME mismatch fails candidate without replacing current READY asset', async () => {
  const videoId = await makeVideo('mime');
  const oldSession = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'old', `${prefix}old`, { kind: AssetKind.COVER, mimeType: 'image/webp', size: 100n });
  const oldRow = await prisma.videoAsset.findUniqueOrThrow({ where: { id: oldSession.assetId } }); storage.putObject(oldRow.objectKey!, 100n, 'image/webp');
  const old = await finalizeAdminUpload(prisma, storage, config, oldSession.sessionId, admin, 'old', `${prefix}old-final`, []);
  const next = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'next', `${prefix}next`, { kind: AssetKind.COVER, mimeType: 'image/webp', size: 100n });
  const nextRow = await prisma.videoAsset.findUniqueOrThrow({ where: { id: next.assetId } }); storage.putObject(nextRow.objectKey!, 100n, 'image/png');
  await assert.rejects(() => finalizeAdminUpload(prisma, storage, config, next.sessionId, admin, 'next', `${prefix}next-final`, []), (e) => expectCode(e, 'R2_OBJECT_TYPE_MISMATCH'));
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: old.id } })).status, AssetStatus.READY);
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: next.assetId } })).status, AssetStatus.FAILED);
});

test('multipart persists uploadId, rejects invalid/duplicate parts and abort blocks further use', async () => {
  const videoId = await makeVideo('multipart');
  const size = 100n * 1024n * 1024n + 1n;
  const session = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'multi', `${prefix}multi`, { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size });
  const stored = await prisma.assetUploadSession.findUniqueOrThrow({ where: { id: session.sessionId } });
  assert.ok(stored.r2UploadId);
  for (const parts of [[0], [8], [1, 1]]) await assert.rejects(() => presignAdminParts(prisma, storage, config, session.sessionId, admin, parts), (e) => expectCode(e, 'MULTIPART_INVALID_PART'));
  await abortAdminUpload(prisma, storage, session.sessionId, admin, 'abort');
  assert.equal((await prisma.assetUploadSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status, AssetUploadStatus.ABORTED);
  await assert.rejects(() => presignAdminParts(prisma, storage, config, session.sessionId, admin, [1]), (e) => expectCode(e, 'UPLOAD_SESSION_EXPIRED'));
  await assert.rejects(() => finalizeAdminUpload(prisma, storage, config, session.sessionId, admin, 'multi', `${prefix}multi-final`, []), (e) => expectCode(e, 'UPLOAD_SESSION_EXPIRED'));
  assert.equal(storage.aborted.length, 1);
});

test('expired sessions cannot presign or finalize and are not revived', async () => {
  const videoId = await makeVideo('expired');
  const multi = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 'm', `${prefix}expired-m`, { kind: AssetKind.VIDEO, mimeType: 'video/mp4', size: 100n * 1024n * 1024n + 1n });
  await prisma.assetUploadSession.update({ where: { id: multi.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => presignAdminParts(prisma, storage, config, multi.sessionId, admin, [1]), (e) => expectCode(e, 'UPLOAD_SESSION_EXPIRED'));
  assert.equal((await prisma.assetUploadSession.findUniqueOrThrow({ where: { id: multi.sessionId } })).status, AssetUploadStatus.EXPIRED);

  const single = await createAdminVideoUpload(prisma, storage, config, videoId, admin, 's', `${prefix}expired-s`, { kind: AssetKind.THUMBNAIL, mimeType: 'image/webp', size: 100n });
  const row = await prisma.videoAsset.findUniqueOrThrow({ where: { id: single.assetId } }); storage.putObject(row.objectKey!, 100n, 'image/webp');
  await prisma.assetUploadSession.update({ where: { id: single.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => finalizeAdminUpload(prisma, storage, config, single.sessionId, admin, 's', `${prefix}expired-s-final`, []), (e) => expectCode(e, 'UPLOAD_SESSION_EXPIRED'));
  assert.equal((await prisma.videoAsset.findUniqueOrThrow({ where: { id: single.assetId } })).status, AssetStatus.FAILED);
});

test.after(async () => { await cleanup(); await prisma.$disconnect(); });
