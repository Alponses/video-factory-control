import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { updateVideoWithAudit } from '../../src/http/admin-service.js';
import { createTestAuthFixture, TEST_ALLOWED_EMAIL, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/auth.js';
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
  adminAllowedEmails: [TEST_ALLOWED_EMAIL],
  workerOfflineThresholdSeconds: 60,
  leaseDurationSeconds: 120,
};

const fixture = await createTestAuthFixture();
const token = await fixture.sign();
const app = createApp(config, {
  prisma,
  auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE },
  logger: { log() {} },
});

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'cf-access-jwt-assertion': token,
    origin,
    ...extra,
  };
}

async function adminJson(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

await importLegacy(prisma);

test('health live and ready use the running process and MariaDB', async () => {
  await withServer(app, async (baseUrl) => {
    const live = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    const ready = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ok' });
  });
});

test('video list paginates and filters real MariaDB data', async () => {
  await withServer(app, async (baseUrl) => {
    const first = await adminJson(baseUrl, '/api/admin/videos?page=1&pageSize=3');
    assert.equal(first.response.status, 200);
    assert.equal((first.body.items as unknown[]).length, 3);
    assert.equal(first.body.total, 11);

    const search = await adminJson(baseUrl, '/api/admin/videos?search=religion-000011');
    assert.equal(search.response.status, 200);
    assert.equal(search.body.total, 1);

    const source = await prisma.video.findUniqueOrThrow({ where: { id: 'religion-000011' }, select: { status: true, category: true } });
    const byStatus = await adminJson(baseUrl, `/api/admin/videos?status=${encodeURIComponent(source.status)}`);
    assert.equal(byStatus.response.status, 200);
    assert.ok(Number(byStatus.body.total) >= 1);
    const byCategory = await adminJson(baseUrl, `/api/admin/videos?category=${encodeURIComponent(source.category)}`);
    assert.equal(byCategory.response.status, 200);
    assert.ok(Number(byCategory.body.total) >= 1);
  });
});

test('video detail is real and preserves religion-000001 as incomplete', async () => {
  await withServer(app, async (baseUrl) => {
    const missing = await adminJson(baseUrl, '/api/admin/videos/not-present');
    assert.equal(missing.response.status, 404);
    assert.equal((missing.body.error as Record<string, unknown>).code, 'VIDEO_NOT_FOUND');

    const detail = await adminJson(baseUrl, '/api/admin/videos/religion-000001');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.legacyIncomplete, true);
    assert.equal((detail.body.scenes as unknown[]).length, 0);
    assert.equal((detail.body.publications as unknown[]).length, 3);
  });
});

test('PATCH video validates allowlist, version and audit atomically', async () => {
  await withServer(app, async (baseUrl) => {
    const before = await prisma.video.findUniqueOrThrow({ where: { id: 'religion-000011' }, select: { title: true, version: true } });
    const title = `${before.title} [phase2]`;
    const success = await adminJson(baseUrl, '/api/admin/videos/religion-000011', {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: before.version, title }),
    });
    assert.equal(success.response.status, 200);
    assert.equal(success.body.title, title);
    assert.equal(success.body.version, before.version + 1);

    const audit = await prisma.auditLog.findFirst({ where: { entityId: 'religion-000011', action: 'VIDEO_EDIT' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
    assert.equal(audit.actor, TEST_ALLOWED_EMAIL);
    assert.equal((audit.beforeData as Record<string, unknown>).title, before.title);
    assert.equal((audit.afterData as Record<string, unknown>).title, title);
    assert.ok(audit.requestId);

    const stale = await adminJson(baseUrl, '/api/admin/videos/religion-000011', {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: before.version, title: 'stale edit' }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as Record<string, unknown>).code, 'VIDEO_VERSION_CONFLICT');

    const invalid = await adminJson(baseUrl, '/api/admin/videos/religion-000011', {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: 0, title: 'invalid' }),
    });
    assert.equal(invalid.response.status, 400);

    const forbidden = await adminJson(baseUrl, '/api/admin/videos/religion-000011', {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: before.version + 1, id: 'changed' }),
    });
    assert.equal(forbidden.response.status, 400);
  });
});

test('PATCH scene updates only an existing scene and enforces version', async () => {
  const scene = await prisma.videoScene.findFirstOrThrow({ where: { videoId: 'religion-000011' }, orderBy: { position: 'asc' } });
  await withServer(app, async (baseUrl) => {
    const changedText = `${scene.text} [phase2]`;
    const success = await adminJson(baseUrl, `/api/admin/videos/religion-000011/scenes/${scene.position}`, {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: scene.version, text: changedText, searchTerms: ['phase2', 'security'] }),
    });
    assert.equal(success.response.status, 200);
    assert.equal(success.body.text, changedText);
    assert.equal(success.body.version, scene.version + 1);

    const stale = await adminJson(baseUrl, `/api/admin/videos/religion-000011/scenes/${scene.position}`, {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: scene.version, text: 'stale' }),
    });
    assert.equal(stale.response.status, 409);

    const missing = await adminJson(baseUrl, '/api/admin/videos/religion-000001/scenes/1', {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: 1, text: 'must not create' }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(await prisma.videoScene.count({ where: { videoId: 'religion-000001' } }), 0);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'SCENE_EDIT', entityId: scene.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
    assert.equal((audit.beforeData as Record<string, unknown>).text, scene.text);
    assert.equal((audit.afterData as Record<string, unknown>).text, changedText);
  });
});

test('mutation and audit rollback together when audit fails', async () => {
  const before = await prisma.video.findUniqueOrThrow({ where: { id: 'religion-000010' }, select: { title: true, version: true } });
  await assert.rejects(() => updateVideoWithAudit(
    prisma,
    'religion-000010',
    { expectedVersion: before.version, changes: { title: 'must rollback' } },
    TEST_ALLOWED_EMAIL,
    'rollback-test',
    async () => { throw new Error('audit failure'); },
  ));
  const after = await prisma.video.findUniqueOrThrow({ where: { id: 'religion-000010' }, select: { title: true, version: true } });
  assert.deepEqual(after, before);
});

test('CORS, CSRF, content type, body limits and security headers are enforced', async () => {
  await withServer(app, async (baseUrl) => {
    const forbiddenOrigin = await fetch(`${baseUrl}/api/admin/videos`, { headers: { origin: 'https://evil.example' } });
    assert.equal(forbiddenOrigin.status, 403);
    assert.notEqual(forbiddenOrigin.headers.get('access-control-allow-origin'), '*');

    const csrf = await fetch(`${baseUrl}/api/admin/videos/religion-000011`, {
      method: 'PATCH',
      headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, title: 'blocked' }),
    });
    assert.equal(csrf.status, 403);

    const media = await fetch(`${baseUrl}/api/admin/videos/religion-000011`, {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: 1, title: 'blocked' }),
    });
    assert.equal(media.status, 415);

    const oversized = await fetch(`${baseUrl}/api/admin/videos/religion-000011`, {
      method: 'PATCH',
      headers: adminHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: 1, title: 'x'.repeat(1_100_000) }),
    });
    assert.equal(oversized.status, 413);

    const health = await fetch(`${baseUrl}/api/health/live`);
    assert.match(health.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  });
});

test.after(async () => {
  await prisma.$disconnect();
});
