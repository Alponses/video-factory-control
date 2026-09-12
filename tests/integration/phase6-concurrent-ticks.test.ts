import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind, AssetStatus, Platform, PrismaClient, PublicationDispatchStatus, PublicationStatus, RenderAttemptStatus, ScheduleStatus, VideoStatus } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { fixedClock } from '../../src/scheduling/clock.js';
import { runSchedulerTick } from '../../src/scheduling/scheduler.js';

const prisma = new PrismaClient();
const prefix = 'phase6-concurrent-ticks-';
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

test('two simultaneous scheduler ticks have one lease winner and still create at most one PENDING dispatch per schedule', async () => {
  await prisma.channel.create({ data: { id: channelId, language: 'es-MX' } });
  await prisma.profile.create({ data: { id: `${prefix}facebook`, channelId, platform: Platform.FACEBOOK } });

  for (let index = 0; index < 10; index += 1) {
    const videoId = `${prefix}${index}`;
    await prisma.video.create({ data: { id: videoId, channelId, slug: videoId, title: videoId, category: 'phase6', status: VideoStatus.APPROVED, metadata: {}, createdAt: new Date('2026-09-01T00:00:00Z') } });
    await prisma.renderAttempt.create({ data: { videoId, attempt: 1, status: RenderAttemptStatus.SUCCEEDED, durationSeconds: 75, width: 1080, height: 1920, hasAudio: true, raw: {} } });
    await prisma.qaResult.create({ data: { videoId, attempt: 1, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, raw: {} } });
    await prisma.videoAsset.create({ data: { videoId, kind: AssetKind.VIDEO, status: AssetStatus.READY, storageProvider: 'R2', bucket: 'test', objectKey: `${prefix}${index}.mp4`, mimeType: 'video/mp4', size: 1024n } });
    const publication = await prisma.publication.create({ data: { videoId, platform: Platform.FACEBOOK, status: PublicationStatus.SCHEDULED, description: 'Ready Facebook description', hashtags: ['#Fe', '#Paz', '#PausaConFe'], cta: 'Comparte', raw: {} } });
    await prisma.schedule.create({ data: { publicationId: publication.id, scheduledAt: new Date('2026-09-15T19:00:00Z'), timezone: 'America/Mexico_City', status: ScheduleStatus.SCHEDULED } });
  }

  const [a, b] = await Promise.all([
    runSchedulerTick(prisma, config, { clock: fixedClock(now), schedulerRunId: 'concurrent-tick-a' }),
    runSchedulerTick(prisma, config, { clock: fixedClock(now), schedulerRunId: 'concurrent-tick-b' }),
  ]);

  assert.equal([a.leaseAcquired, b.leaseAcquired].filter(Boolean).length, 1);
  assert.equal(a.dispatched + b.dispatched, 10);

  const dispatches = await prisma.publicationDispatch.findMany({ where: { publication: { videoId: { startsWith: prefix } } }, select: { scheduleId: true, status: true } });
  assert.equal(dispatches.length, 10);
  assert.ok(dispatches.every((dispatch) => dispatch.status === PublicationDispatchStatus.PENDING));
  assert.equal(new Set(dispatches.map((dispatch) => dispatch.scheduleId)).size, 10);

  const schedules = await prisma.schedule.findMany({ where: { publication: { videoId: { startsWith: prefix } } }, select: { status: true } });
  assert.ok(schedules.every((schedule) => schedule.status === ScheduleStatus.DISPATCHED));
  const publications = await prisma.publication.findMany({ where: { videoId: { startsWith: prefix } }, select: { status: true } });
  assert.ok(publications.every((publication) => publication.status === PublicationStatus.SCHEDULED));
});
