import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { importLegacy } from '../../src/legacy/importer.js';
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
};
const fixture = await createTestAuthFixture();
const token = await fixture.sign();
const app = createApp(config, {
  prisma,
  auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE },
  logger: { log() {} },
});

await importLegacy(prisma);

test('admin namespace is protected and dashboard uses real MariaDB data', async () => {
  await withServer(app, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/admin/dashboard`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { 'cf-access-jwt-assertion': token, origin },
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as {
      totalsByStatus: Record<string, number>;
      recentVideos: unknown[];
      legacyIncomplete: number;
    };
    const total = Object.values(body.totalsByStatus).reduce((sum, count) => sum + count, 0);
    assert.equal(total, 11);
    assert.equal(body.legacyIncomplete, 1);
    assert.ok(body.recentVideos.length > 0);
  });
});

test.after(async () => {
  await prisma.$disconnect();
});
