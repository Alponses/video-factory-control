import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient, VideoStatus, WorkerStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { claimNextJob, hashWorkerSecret } from '../../src/http/worker-service.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { createTestAuthFixture, TEST_ADMIN_AUDIENCE, TEST_ALLOWED_EMAIL, TEST_ISSUER, TEST_WORKER_AUDIENCE } from '../helpers/auth.js';
import { FakeR2Storage } from '../helpers/fake-r2.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const storage = new FakeR2Storage();
const origin = 'http://admin.test';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: origin, appOrigin: origin, databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', cloudflareAdminAccessAud: TEST_ADMIN_AUDIENCE, cloudflareWorkerAccessAud: TEST_WORKER_AUDIENCE, adminAllowedEmails: [TEST_ALLOWED_EMAIL], workerOfflineThresholdSeconds: 60, leaseDurationSeconds: 120,
  r2: { accountId: 'phase5-account', accessKeyId: 'PERMANENT_KEY_NOT_RESPONSE', secretAccessKey: 'PERMANENT_SECRET_NOT_RESPONSE', bucket: storage.bucket, endpoint: storage.origin, origin: storage.origin, presignTtlSeconds: 300, singleUploadThresholdBytes: 104857600, multipartPartSizeBytes: 16777216 },
};
const fixture = await createTestAuthFixture();
const adminToken = await fixture.sign({ audience: TEST_ADMIN_AUDIENCE });
const workerToken = await fixture.sign({ audience: TEST_WORKER_AUDIENCE, subject: 'phase5-worker-service-token' });
const app = createApp(config, { prisma, storage, auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_ADMIN_AUDIENCE }, workerAuth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_WORKER_AUDIENCE }, logger: { log() {} } });

await importLegacy(prisma);

function adminHeaders(extra: Record<string, string> = {}) {
  return { 'cf-access-jwt-assertion': adminToken, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function cleanup() {
  await prisma.videoAsset.deleteMany({ where: { videoId: { startsWith: 'phase5-http-' } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: 'phase5-http-' } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: 'phase5-http-' } } });
  await prisma.channel.deleteMany({ where: { id: 'phase5-http-channel' } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: { contains: 'phase5-http-' } } });
}

test.beforeEach(cleanup);

test('Admin presign endpoints require verified Admin JWT and never expose permanent R2 credentials', async () => {
  await prisma.channel.create({ data: { id: 'phase5-http-channel', language: 'es-MX' } });
  await prisma.video.create({ data: { id: 'phase5-http-video', channelId: 'phase5-http-channel', slug: 'phase5-http-video', title: 'Phase5', category: 'test', status: VideoStatus.DRAFT, version: 1, legacyIncomplete: false, renderConfig: {}, metadata: {}, createdAt: new Date() } });
  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/admin/assets/policy`, { headers: { origin } });
    assert.equal(missing.status, 401);

    const created = await fetch(`${baseUrl}/api/admin/videos/phase5-http-video/assets/uploads`, {
      method: 'POST', headers: adminHeaders({ 'idempotency-key': 'phase5-http-create-key' }),
      body: JSON.stringify({ kind: 'VIDEO', mimeType: 'video/mp4', size: '1024', originalFilename: '../../evil.mp4' }),
    });
    assert.equal(created.status, 201);
    const json = await body(created);
    const serialized = JSON.stringify(json);
    assert.match(String(json.uploadUrl), /X-Amz-Signature=/);
    assert.equal(serialized.includes(config.r2!.accessKeyId), false);
    assert.equal(serialized.includes(config.r2!.secretAccessKey), false);
    assert.equal(serialized.includes('objectKey'), false);

    const bad = await fetch(`${baseUrl}/api/admin/videos/phase5-http-video/assets/uploads`, {
      method: 'POST', headers: adminHeaders({ 'idempotency-key': 'phase5-http-bad-mime' }),
      body: JSON.stringify({ kind: 'VIDEO', mimeType: 'text/html', size: '10' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await body(bad)).error as Record<string, unknown>).code, 'ASSET_INVALID_TYPE');
  });
});

test('Worker asset routes require Worker JWT + secret + current lease and reject another video', async () => {
  const workerId = 'phase5-http-worker';
  const secret = `vfws_${'q'.repeat(43)}`;
  await prisma.channel.create({ data: { id: 'phase5-http-channel', language: 'es-MX' } });
  for (const id of ['phase5-http-video-a', 'phase5-http-video-b']) await prisma.video.create({ data: { id, channelId: 'phase5-http-channel', slug: id, title: id, category: 'test', status: id.endsWith('-a') ? VideoStatus.QUEUED : VideoStatus.DRAFT, version: 1, legacyIncomplete: false, renderConfig: {}, metadata: {}, createdAt: new Date() } });
  await prisma.worker.create({ data: { id: workerId, status: WorkerStatus.ONLINE, secretHash: hashWorkerSecret(secret), secretVersion: 1 } });
  const job = await claimNextJob(prisma, workerId, 120);
  assert.ok(job);
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/worker/jobs/phase5-http-video-a/assets/uploads`;
    const missing = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 401);

    const headers = { 'cf-access-jwt-assertion': workerToken, 'x-worker-id': workerId, authorization: `Bearer ${secret}`, 'x-worker-lease': job.leaseToken, 'idempotency-key': 'phase5-http-worker-upload', 'content-type': 'application/json' };
    const valid = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ mimeType: 'video/mp4', size: '1024', sha256: 'a'.repeat(64), originalFilename: 'render.mp4' }) });
    assert.equal(valid.status, 201);

    const other = await fetch(`${baseUrl}/api/worker/jobs/phase5-http-video-b/assets/uploads`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'phase5-http-worker-other' }, body: JSON.stringify({ mimeType: 'video/mp4', size: '1024', sha256: 'a'.repeat(64) }) });
    assert.ok([403, 409].includes(other.status));
  });
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
