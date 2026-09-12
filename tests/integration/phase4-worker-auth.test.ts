import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { createTestAuthFixture, TEST_ADMIN_AUDIENCE, TEST_ALLOWED_EMAIL, TEST_ISSUER, TEST_WORKER_AUDIENCE } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const origin = 'http://admin.test';
const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  appBaseUrl: origin,
  appOrigin: origin,
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test',
  cloudflareAdminAccessAud: TEST_ADMIN_AUDIENCE,
  cloudflareWorkerAccessAud: TEST_WORKER_AUDIENCE,
  adminAllowedEmails: [TEST_ALLOWED_EMAIL],
  workerOfflineThresholdSeconds: 60,
  leaseDurationSeconds: 120,
};
const fixture = await createTestAuthFixture();
const badFixture = await createTestAuthFixture();
const adminToken = await fixture.sign({ audience: TEST_ADMIN_AUDIENCE });
const workerToken = await fixture.sign({ audience: TEST_WORKER_AUDIENCE, subject: 'service-token-test' });
const app = createApp(config, {
  prisma,
  auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_ADMIN_AUDIENCE },
  workerAuth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_WORKER_AUDIENCE },
  logger: { log() {} },
});

function adminHeaders(): Record<string, string> {
  return {
    'cf-access-jwt-assertion': adminToken,
    origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
}

function workerHeaders(token = workerToken, workerId?: string, secret?: string): Record<string, string> {
  return {
    'cf-access-jwt-assertion': token,
    'content-type': 'application/json',
    ...(workerId ? { 'x-worker-id': workerId } : {}),
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
}

async function json(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

async function createWorker(baseUrl: string, id: string): Promise<string> {
  const created = await json(baseUrl, '/api/admin/workers', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ workerId: id }) });
  assert.equal(created.response.status, 201);
  assert.equal(typeof created.body?.secret, 'string');
  return created.body?.secret as string;
}

async function workerHeartbeat(baseUrl: string, headers: Record<string, string>) {
  return json(baseUrl, '/api/worker/heartbeat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentVersion: 'phase4-test', rendererVersion: 'local', currentVideoId: null, progress: null, lastError: null }),
  });
}

await importLegacy(prisma);
await prisma.workerLease.deleteMany({ where: { workerId: { startsWith: 'phase4-auth-' } } });
await prisma.worker.deleteMany({ where: { id: { startsWith: 'phase4-auth-' } } });
await prisma.auditLog.deleteMany({ where: { entityType: 'WORKER', entityId: { startsWith: 'phase4-auth-' } } });

test('worker Access JWT matrix fails closed before internal worker secret auth', async () => {
  await withServer(app, async (baseUrl) => {
    const missing = await workerHeartbeat(baseUrl, { 'content-type': 'application/json' });
    assert.equal(missing.response.status, 401);
    assert.equal((missing.body?.error as Record<string, unknown>).code, 'WORKER_ACCESS_JWT_MISSING');

    const malformed = await workerHeartbeat(baseUrl, workerHeaders('not-a-jwt'));
    assert.equal(malformed.response.status, 401);

    const badSignature = await badFixture.sign({ audience: TEST_WORKER_AUDIENCE, subject: 'bad-signature' });
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(badSignature))).response.status, 401);

    const expired = await fixture.sign({ audience: TEST_WORKER_AUDIENCE, expiresInSeconds: -30 });
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(expired))).response.status, 401);

    const wrongIssuer = await fixture.sign({ audience: TEST_WORKER_AUDIENCE, issuer: 'https://wrong.cloudflareaccess.com' });
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(wrongIssuer))).response.status, 401);

    const wrongWorkerAud = await fixture.sign({ audience: 'wrong-worker-audience' });
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(wrongWorkerAud))).response.status, 401);

    const adminAudOnWorkerRoute = await fixture.sign({ audience: TEST_ADMIN_AUDIENCE });
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(adminAudOnWorkerRoute))).response.status, 401);

    const workerAudOnAdminRoute = await json(baseUrl, '/api/admin/workers', { headers: { 'cf-access-jwt-assertion': workerToken, origin } });
    assert.equal(workerAudOnAdminRoute.response.status, 401);
  });
});

test('internal worker ID and secret matrix denies missing, unknown and wrong credentials', async () => {
  await withServer(app, async (baseUrl) => {
    const knownId = 'phase4-auth-matrix';
    const secret = await createWorker(baseUrl, knownId);

    const missingId = await workerHeartbeat(baseUrl, workerHeaders(workerToken, undefined, secret));
    assert.equal(missingId.response.status, 401);
    assert.equal((missingId.body?.error as Record<string, unknown>).code, 'WORKER_ID_INVALID');

    const unknown = await workerHeartbeat(baseUrl, workerHeaders(workerToken, 'phase4-auth-unknown', `vfws_${'x'.repeat(43)}`));
    assert.equal(unknown.response.status, 401);

    const missingSecret = await workerHeartbeat(baseUrl, workerHeaders(workerToken, knownId));
    assert.equal(missingSecret.response.status, 401);
    assert.equal((missingSecret.body?.error as Record<string, unknown>).code, 'WORKER_SECRET_MISSING');

    const wrongSecret = await workerHeartbeat(baseUrl, workerHeaders(workerToken, knownId, `vfws_${'y'.repeat(43)}`));
    assert.equal(wrongSecret.response.status, 401);
  });
});

test('worker create and list expose plaintext secret only at provisioning time', async () => {
  await withServer(app, async (baseUrl) => {
    const id = 'phase4-auth-onetime';
    const secret = await createWorker(baseUrl, id);
    assert.match(secret, /^vfws_[A-Za-z0-9_-]{40,}$/);

    const listed = await json(baseUrl, '/api/admin/workers', { headers: { 'cf-access-jwt-assertion': adminToken, origin } });
    assert.equal(listed.response.status, 200);
    const serialized = JSON.stringify(listed.body);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('secretHash'), false);
    assert.equal(serialized.includes('"secret"'), false);
  });
});

test('rotation invalidates old worker secret; current secret survives revoke/enable', async () => {
  await withServer(app, async (baseUrl) => {
    const id = 'phase4-auth-rotate';
    const oldSecret = await createWorker(baseUrl, id);
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, oldSecret))).response.status, 200);

    const rotated = await json(baseUrl, `/api/admin/workers/${id}/rotate-secret`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    assert.equal(rotated.response.status, 200);
    const newSecret = rotated.body?.secret as string;
    assert.notEqual(newSecret, oldSecret);
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, oldSecret))).response.status, 401);
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, newSecret))).response.status, 200);

    const revoked = await json(baseUrl, `/api/admin/workers/${id}/revoke`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    assert.equal(revoked.response.status, 200);
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, newSecret))).response.status, 403);

    const enabled = await json(baseUrl, `/api/admin/workers/${id}/enable`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    assert.equal(enabled.response.status, 200);
    assert.equal((await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, newSecret))).response.status, 200);
  });
});

test('valid worker JWT + ID + current secret is allowed', async () => {
  await withServer(app, async (baseUrl) => {
    const id = 'phase4-auth-valid';
    const secret = await createWorker(baseUrl, id);
    const response = await workerHeartbeat(baseUrl, workerHeaders(workerToken, id, secret));
    assert.equal(response.response.status, 200);
    assert.equal(response.body?.workerId, id);
  });
});

test('worker provisioning audit records contain no secret material', async () => {
  await withServer(app, async (baseUrl) => {
    const id = 'phase4-auth-audit';
    const secret = await createWorker(baseUrl, id);
    const rotated = await json(baseUrl, `/api/admin/workers/${id}/rotate-secret`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    const rotatedSecret = rotated.body?.secret as string;
    await json(baseUrl, `/api/admin/workers/${id}/revoke`, { method: 'POST', headers: adminHeaders(), body: '{}' });

    const logs = await prisma.auditLog.findMany({ where: { entityType: 'WORKER', entityId: id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(logs.map((entry) => entry.action), ['WORKER_CREATED', 'WORKER_SECRET_ROTATED', 'WORKER_REVOKED']);
    const serialized = JSON.stringify(logs);
    for (const forbidden of [secret, rotatedSecret, 'secretHash', 'authorization', workerToken, 'CF-Access-Client-Secret']) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
    }
  });
});

test.after(async () => {
  await prisma.workerLease.deleteMany({ where: { workerId: { startsWith: 'phase4-auth-' } } });
  await prisma.worker.deleteMany({ where: { id: { startsWith: 'phase4-auth-' } } });
  await prisma.$disconnect();
});
