import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, Platform, PrismaClient, PublicationStatus, RenderAttemptStatus, VideoStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createTestAuthFixture, TEST_ALLOWED_EMAIL, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const prisma = new PrismaClient();
const prefix = 'phase6-http-';
const origin = 'http://admin.test';
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: origin, appOrigin: origin, databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', adminAllowedEmails: [TEST_ALLOWED_EMAIL], appTimezone: 'America/Mexico_City', schedulePastToleranceSeconds: 60,
};
const auth = await createTestAuthFixture();
const token = await auth.sign();
const app = createApp(config, { prisma, auth: { keyResolver: auth.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, logger: { log() {} } });

function headers(extra: Record<string, string> = {}) { return { 'cf-access-jwt-assertion': token, origin, ...extra }; }
async function call(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function cleanup() {
  await prisma.publicationEvent.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.publicationDispatch.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.schedule.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.videoAsset.deleteMany({ where: { videoId: { startsWith: prefix } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.channel.deleteMany({ where: { id: { startsWith: prefix } } });
}

async function fixture() {
  const videoId = `${prefix}video`;
  const channelId = `${prefix}channel`;
  await prisma.channel.create({ data: { id: channelId, language: 'es-MX' } });
  await prisma.profile.create({ data: { id: `${prefix}youtube`, channelId, platform: Platform.YOUTUBE } });
  await prisma.video.create({ data: { id: videoId, channelId, slug: videoId, title: 'Phase 6 HTTP', category: 'phase6', status: VideoStatus.APPROVED, metadata: {}, createdAt: new Date() } });
  await prisma.renderAttempt.create({ data: { videoId, attempt: 1, status: RenderAttemptStatus.SUCCEEDED, durationSeconds: 75, width: 1080, height: 1920, hasAudio: true, raw: {} } });
  await prisma.qaResult.create({ data: { videoId, attempt: 1, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, raw: {} } });
  await prisma.videoAsset.create({ data: { videoId, kind: AssetKind.VIDEO, status: AssetStatus.READY, storageProvider: 'R2', bucket: 'test', objectKey: `${prefix}video.mp4`, mimeType: 'video/mp4', size: 1024n } });
  return prisma.publication.create({ data: { videoId, platform: Platform.YOUTUBE, status: PublicationStatus.READY, title: 'Phase 6 title', description: 'Phase 6 description', hashtags: ['#Fe', '#Paz', '#PausaConFe'], cta: 'Comparte', raw: {} } });
}

test.beforeEach(async () => { await cleanup(); });
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

test('Phase 6 Admin HTTP exposes preflight, schedule and range calendar without a run-scheduler endpoint', async () => {
  const publication = await fixture();
  await withServer(app, async (baseUrl) => {
    const preflight = await call(baseUrl, `/api/admin/publications/${publication.id}/preflight`);
    assert.equal(preflight.response.status, 200);
    assert.equal(preflight.body.ready, true);

    const scheduled = await call(baseUrl, `/api/admin/publications/${publication.id}/schedule`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
      body: JSON.stringify({ localDateTime: '2026-09-15T20:30:00', timezone: 'America/Mexico_City', expectedVersion: publication.version }),
    });
    assert.equal(scheduled.response.status, 201);
    const schedule = scheduled.body.schedule as Record<string, unknown>;
    assert.equal(schedule.scheduledAtUtc, '2026-09-16T02:30:00.000Z');

    const calendar = await call(baseUrl, '/api/admin/calendar?start=2026-09-16T00%3A00%3A00.000Z&end=2026-09-17T00%3A00%3A00.000Z&platform=YOUTUBE');
    assert.equal(calendar.response.status, 200);
    assert.equal((calendar.body.items as unknown[]).length, 1);

    const forbiddenConvenience = await call(baseUrl, '/api/admin/run-scheduler', { method: 'POST', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: '{}' });
    assert.equal(forbiddenConvenience.response.status, 404);
  });
});

test('Phase 6 schedule HTTP rejects invalid IANA timezone and stale publication version', async () => {
  const publication = await fixture();
  await withServer(app, async (baseUrl) => {
    const invalidZone = await call(baseUrl, `/api/admin/publications/${publication.id}/schedule`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: JSON.stringify({ localDateTime: '2026-09-15T20:30:00', timezone: 'GMT-6', expectedVersion: publication.version }),
    });
    assert.equal(invalidZone.response.status, 400);
    assert.equal((invalidZone.body.error as Record<string, unknown>).code, 'INVALID_TIMEZONE');

    const stale = await call(baseUrl, `/api/admin/publications/${publication.id}/schedule`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), body: JSON.stringify({ localDateTime: '2026-09-15T20:30:00', timezone: 'America/Mexico_City', expectedVersion: 999 }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as Record<string, unknown>).code, 'PUBLICATION_VERSION_CONFLICT');
  });
});
