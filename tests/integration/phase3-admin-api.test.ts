import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { updatePublicationWithAudit } from '../../src/http/admin-service.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { createTestAuthFixture, TEST_ALLOWED_EMAIL, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const origin = 'http://admin.test';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: origin, appOrigin: origin,
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5', cloudflareAuthMode: 'test', adminAllowedEmails: [TEST_ALLOWED_EMAIL],
};
const fixture = await createTestAuthFixture();
const token = await fixture.sign();
const app = createApp(config, { prisma, auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, logger: { log() {} } });

function headers(extra: Record<string, string> = {}) { return { 'cf-access-jwt-assertion': token, origin, ...extra }; }
async function json(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } });
  return { response, body: await response.json() as Record<string, unknown> };
}

await importLegacy(prisma);

test('GET /api/admin/me derives identity from the verified JWT', async () => {
  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/admin/me`);
    assert.equal(missing.status, 401);
    const allowed = await json(baseUrl, '/api/admin/me');
    assert.equal(allowed.response.status, 200);
    assert.deepEqual(allowed.body, { email: TEST_ALLOWED_EMAIL });
  });
});

test('video detail DTO exposes useful admin data without raw legacy JSON', async () => {
  await withServer(app, async (baseUrl) => {
    const detail = await json(baseUrl, '/api/admin/videos/religion-000011');
    assert.equal(detail.response.status, 200);
    assert.ok(detail.body.channel);
    assert.ok(Array.isArray(detail.body.scenes));
    assert.ok(Array.isArray(detail.body.renderAttempts));
    assert.ok(Array.isArray(detail.body.qa));
    const serialized = JSON.stringify(detail.body);
    assert.equal(serialized.includes('performanceRaw'), false);
    assert.equal(serialized.includes('effectiveJson'), false);
  });
});

test('publication editorial metadata update is allowlisted, versioned and audited', async () => {
  const publication = await prisma.publication.findFirstOrThrow({ where: { videoId: 'religion-000011' }, orderBy: { platform: 'asc' } });
  await withServer(app, async (baseUrl) => {
    const title = `${publication.title ?? 'Editorial'} [phase3]`;
    const success = await json(baseUrl, `/api/admin/publications/${publication.id}`, {
      method: 'PATCH',
      headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ expectedVersion: publication.version, title, hashtags: ['#phase3', '#admin'] }),
    });
    assert.equal(success.response.status, 200);
    assert.equal(success.body.title, title);
    assert.equal(success.body.version, publication.version + 1);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PUBLICATION_EDIT', entityId: publication.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(audit.actor, TEST_ALLOWED_EMAIL);
    assert.equal((audit.afterData as Record<string, unknown>).title, title);
    assert.deepEqual((audit.metadata as Record<string, unknown>).videoId, 'religion-000011');

    const stale = await json(baseUrl, `/api/admin/publications/${publication.id}`, {
      method: 'PATCH', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: JSON.stringify({ expectedVersion: publication.version, title: 'stale' }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as Record<string, unknown>).code, 'PUBLICATION_VERSION_CONFLICT');

    const forbidden = await json(baseUrl, `/api/admin/publications/${publication.id}`, {
      method: 'PATCH', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: JSON.stringify({ expectedVersion: publication.version + 1, status: 'PUBLISHED' }),
    });
    assert.equal(forbidden.response.status, 400);

    const missing = await json(baseUrl, '/api/admin/publications/not-present', {
      method: 'PATCH', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: JSON.stringify({ expectedVersion: 1, title: 'missing' }),
    });
    assert.equal(missing.response.status, 404);
  });
});

test('publication mutation and audit roll back together', async () => {
  const publication = await prisma.publication.findFirstOrThrow({ where: { videoId: 'religion-000010' }, orderBy: { platform: 'asc' } });
  const before = await prisma.publication.findUniqueOrThrow({ where: { id: publication.id }, select: { title: true, version: true } });
  await assert.rejects(() => updatePublicationWithAudit(
    prisma,
    publication.id,
    { expectedVersion: before.version, changes: { title: 'must rollback' } },
    TEST_ALLOWED_EMAIL,
    'phase3-rollback',
    async () => { throw new Error('audit failure'); },
  ));
  const after = await prisma.publication.findUniqueOrThrow({ where: { id: publication.id }, select: { title: true, version: true } });
  assert.deepEqual(after, before);
});

test('video history combines audit and job events without token/header payloads', async () => {
  await withServer(app, async (baseUrl) => {
    const history = await json(baseUrl, '/api/admin/videos/religion-000011/history');
    assert.equal(history.response.status, 200);
    const items = history.body.items as Array<Record<string, unknown>>;
    assert.ok(items.length >= 1);
    const serialized = JSON.stringify(items).toLowerCase();
    assert.equal(serialized.includes('cf-access-jwt-assertion'), false);
    assert.equal(serialized.includes('authorization'), false);
    assert.equal(serialized.includes('refresh_token'), false);

    const missing = await json(baseUrl, '/api/admin/videos/not-present/history');
    assert.equal(missing.response.status, 404);
  });
});

test.after(async () => { await prisma.$disconnect(); });
