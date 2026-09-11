import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createTestAuthFixture, TEST_ALLOWED_EMAIL, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const fixture = await createTestAuthFixture();
const config: AppConfig = {
  nodeEnv: 'production',
  port: 3000,
  appBaseUrl: 'https://factory.norvian.io',
  appOrigin: 'https://factory.norvian.io',
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'remote',
  cloudflareTeamDomain: TEST_ISSUER,
  cloudflareAdminAccessAud: TEST_AUDIENCE,
  adminAllowedEmails: [TEST_ALLOWED_EMAIL],
};
const app = createApp(config, {
  prisma,
  auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE },
  logger: { log() {} },
  adminDistPath: path.resolve('admin/dist'),
});

test('production server serves SPA deep links but never converts /api errors to HTML', async () => {
  await withServer(app, async (baseUrl) => {
    for (const route of ['/', '/videos/religion-000011']) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      const html = await response.text();
      assert.match(html, /id="root"/);
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /style-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(csp.includes("'unsafe-inline'"), false);
      assert.equal(csp.includes("'unsafe-eval'"), false);
    }

    const live = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });

    const missingApi = await fetch(`${baseUrl}/api/not-real`);
    assert.equal(missingApi.status, 404);
    assert.match(missingApi.headers.get('content-type') ?? '', /application\/json/);
    const body = await missingApi.json() as Record<string, unknown>;
    assert.equal((body.error as Record<string, unknown>).code, 'ROUTE_NOT_FOUND');
  });
});

test.after(async () => { await prisma.$disconnect(); });
