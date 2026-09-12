import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, Platform, PrismaClient, PublicationStatus, RenderAttemptStatus, ScheduleStatus, VideoStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { fixedClock } from '../../src/scheduling/clock.js';
import { runSchedulerTick } from '../../src/scheduling/scheduler.js';

const prisma = new PrismaClient();
const prefix = 'phase6-batch50-';
const channelId = `${prefix}channel`;
const now = new Date('2026-09-15T20:00:00.000Z');
const config: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5', cloudflareAuthMode: 'test', adminAllowedEmails: ['admin@example.com'],
  schedulerLeaseSeconds: 55, schedulerBatchSize: 50, schedulePastToleranceSeconds: 60,
};

async function cleanup() {
  await prisma.publicationEvent.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.publicationDispatch.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.schedule.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.videoAsset.deleteMany({ where: { videoId: { startsWith: prefix } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { channelId } });
  await prisma.channel.deleteMany({ where: { id: channelId } });
  await prisma.schedulerLease.deleteMany({ where: { name: 'publication-dispatcher' } });
}

test.before(cleanup);
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

test('default scheduler batch processes exactly 50 of 51 due schedules and next tick continues', async () => {
  await prisma.channel.create({ data: { id: channelId, language: 'es-MX' } });
  await prisma.profile.create({ data: { id: `${prefix}facebook`, channelId, platform: Platform.FACEBOOK } });
  for (let index = 0; index < 51; index += 1) {
    const videoId = `${prefix}${String(index).padStart(2, '0')}`;
    await prisma.video.create({ data: { id: videoId, channelId, slug: videoId, title: videoId, category: 'phase6', status: VideoStatus.APPROVED, metadata: {}, createdAt: new Date('2026-09-01T00:00:00Z') } });
    await prisma.renderAttempt.create({ data: { videoId, attempt: 1, status: RenderAttemptStatus.SUCCEEDED, durationSeconds: 75, width: 1080, height: 1920, hasAudio: true, raw: {} } });
    await prisma.qaResult.create({ data: { videoId, attempt: 1, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, raw: {} } });
    await prisma.videoAsset.create({ data: { videoId, kind: AssetKind.VIDEO, status: AssetStatus.READY, storageProvider: 'R2', bucket: 'test', objectKey: `${prefix}${index}.mp4`, mimeType: 'video/mp4', size: 1024n } });
    const publication = await prisma.publication.create({ data: { videoId, platform: Platform.FACEBOOK, status: PublicationStatus.SCHEDULED, description: 'Ready Facebook description', hashtags: ['#Fe', '#Paz', '#PausaConFe'], cta: 'Comparte', scheduledAt: new Date('2026-09-15T19:00:00Z'), raw: {} } });
    await prisma.schedule.create({ data: { publicationId: publication.id, scheduledAt: new Date('2026-09-15T19:00:00Z'), timezone: 'America/Mexico_City', status: ScheduleStatus.SCHEDULED } });
  }
  const first = await runSchedulerTick(prisma, config, { clock: fixedClock(now), schedulerRunId: 'batch-50-first' });
  assert.equal(first.dueFound, 50);
  assert.equal(first.dispatched, 50);
  assert.equal(await prisma.publicationDispatch.count({ where: { publication: { videoId: { startsWith: prefix } } } }), 50);
  const second = await runSchedulerTick(prisma, config, { clock: fixedClock(now), schedulerRunId: 'batch-50-second' });
  assert.equal(second.dueFound, 1);
  assert.equal(second.dispatched, 1);
  assert.equal(await prisma.publicationDispatch.count({ where: { publication: { videoId: { startsWith: prefix } } } }), 51);
});
