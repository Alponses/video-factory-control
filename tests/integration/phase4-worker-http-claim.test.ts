import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient, VideoStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createWorker } from '../../src/http/worker-service.js';
import { importLegacy } from '../../src/legacy/importer.js';
import { createTestAuthFixture, TEST_ADMIN_AUDIENCE, TEST_ALLOWED_EMAIL, TEST_ISSUER, TEST_WORKER_AUDIENCE } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const origin = 'http://admin.test';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: origin, appOrigin: origin,
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5', cloudflareAuthMode: 'test',
  cloudflareAdminAccessAud: TEST_ADMIN_AUDIENCE, cloudflareWorkerAccessAud: TEST_WORKER_AUDIENCE,
  adminAllowedEmails: [TEST_ALLOWED_EMAIL], workerOfflineThresholdSeconds: 60, leaseDurationSeconds: 120,
};
const fixture = await createTestAuthFixture();
const workerToken = await fixture.sign({ audience: TEST_WORKER_AUDIENCE, subject: 'phase4-http-claim' });
const app = createApp(config, {
  prisma,
  auth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_ADMIN_AUDIENCE },
  workerAuth: { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_WORKER_AUDIENCE },
  logger: { log() {} },
});

await importLegacy(prisma);

test('POST /api/worker/jobs/claim returns 204 when no video is QUEUED', async () => {
  assert.equal(await prisma.video.count({ where: { status: VideoStatus.QUEUED } }), 0);
  const id = 'phase4-http-empty-worker';
  await prisma.worker.deleteMany({ where: { id } });
  const created = await createWorker(prisma, id, TEST_ALLOWED_EMAIL, 'phase4-http-empty', 60);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/worker/jobs/claim`, {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': workerToken,
        'x-worker-id': id,
        authorization: `Bearer ${created.secret}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
  await prisma.worker.delete({ where: { id } });
});

test.after(async () => prisma.$disconnect());
