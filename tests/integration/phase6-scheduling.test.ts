import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssetKind,
  AssetStatus,
  Platform,
  Prisma,
  PrismaClient,
  PublicationStatus,
  RenderAttemptStatus,
  ScheduleStatus,
  VideoStatus,
} from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { ApiError } from '../../src/http/errors.js';
import { fixedClock } from '../../src/scheduling/clock.js';
import { evaluatePublicationPreflight } from '../../src/scheduling/preflight.js';
import { acquireSchedulerLease, dispatchDueSchedule, releaseSchedulerLease, runSchedulerTick } from '../../src/scheduling/scheduler.js';
import { cancelSchedule, createPublicationSchedule, listCalendar, reschedulePublication } from '../../src/scheduling/service.js';

const prisma = new PrismaClient();
const prefix = 'phase6-';
const admin = 'admin@example.com';
const baseConfig: AppConfig = {
  nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: process.env.DATABASE_URL ?? 'mysql://example.invalid/v5',
  cloudflareAuthMode: 'test', adminAllowedEmails: [admin], workerOfflineThresholdSeconds: 60, leaseDurationSeconds: 120,
  appTimezone: 'America/Mexico_City', schedulerLeaseSeconds: 55, schedulerBatchSize: 50, schedulerMaxLatenessSeconds: 300, schedulePastToleranceSeconds: 60,
};

async function cleanup() {
  await prisma.publicationEvent.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.publicationDispatch.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.schedule.deleteMany({ where: { publication: { videoId: { startsWith: prefix } } } });
  await prisma.videoAsset.deleteMany({ where: { videoId: { startsWith: prefix } } });
  await prisma.video.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.channel.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.schedulerLease.deleteMany({ where: { name: 'publication-dispatcher' } });
}

test.beforeEach(cleanup);
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

function metadata(platform: Platform) {
  if (platform === Platform.TIKTOK) return { title: null, caption: 'Una reflexión completa para esta noche.', description: null, hashtags: ['#Fe', '#Paz', '#Esperanza', '#PausaConFe'], cta: 'Guárdalo para volver después.' };
  if (platform === Platform.YOUTUBE) return { title: 'Una reflexión para cerrar el día', caption: null, description: 'Una descripción completa y humana para YouTube.', hashtags: ['#Fe', '#Paz', '#PausaConFe'], cta: 'Comparte si te acompañó.' };
  return { title: null, caption: null, description: 'Una reflexión completa para Facebook.', hashtags: ['#Fe', '#Paz', '#PausaConFe'], cta: 'Guárdalo si quieres volver.' };
}

async function makeReadyPublication(id: string, platform: Platform = Platform.TIKTOK, options: { asset?: boolean; qaPass?: boolean; publicationStatus?: PublicationStatus; duration?: number } = {}) {
  const channelId = `${id}-channel`;
  await prisma.channel.create({ data: { id: channelId, displayName: id, language: 'es-MX' } });
  await Promise.all(Object.values(Platform).map((item) => prisma.profile.create({ data: { id: `${id}-${item.toLowerCase()}`, channelId, platform: item } })));
  await prisma.video.create({ data: { id, channelId, slug: id, title: `Video ${id}`, category: 'phase6', status: VideoStatus.APPROVED, version: 1, legacyIncomplete: false, metadata: {}, renderConfig: {}, createdAt: new Date('2026-09-01T00:00:00Z') } });
  await prisma.renderAttempt.create({ data: { videoId: id, attempt: 1, status: RenderAttemptStatus.SUCCEEDED, durationSeconds: options.duration ?? 75, width: 1080, height: 1920, hasAudio: true, raw: {} } });
  await prisma.qaResult.create({ data: { videoId: id, attempt: 1, passed: options.qaPass ?? true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, raw: {} } });
  let assetId: string | null = null;
  if (options.asset !== false) {
    const asset = await prisma.videoAsset.create({ data: { videoId: id, kind: AssetKind.VIDEO, status: AssetStatus.READY, storageProvider: 'R2', bucket: 'test-bucket', objectKey: `phase6/${id}/video.mp4`, mimeType: 'video/mp4', size: 1024n, metadata: { source: 'PHASE6_TEST' } } });
    assetId = asset.id;
  }
  const copy = metadata(platform);
  const publication = await prisma.publication.create({ data: { videoId: id, platform, status: options.publicationStatus ?? PublicationStatus.READY, version: 1, ...copy, raw: {} } });
  return { publication, assetId, channelId };
}

function expectApi(error: unknown, code: string) { assert.ok(error instanceof ApiError); assert.equal(error.code, code); return true; }

const now = new Date('2026-09-15T20:00:00.000Z');
const clock = fixedClock(now);
const creationClock = fixedClock('2026-09-15T18:00:00.000Z');

async function schedule(publicationId: string, expectedVersion = 1, localDateTime = '2026-09-15T15:00:00', timezone = 'America/Mexico_City') {
  return createPublicationSchedule(prisma, publicationId, { localDateTime, timezone, expectedVersion }, baseConfig, admin, `${prefix}req`, creationClock);
}

test('preflight enforces durable R2 asset, QA, publication status and internal TikTok 61s rule', async () => {
  const ready = await makeReadyPublication(`${prefix}preflight-ready`);
  assert.equal((await evaluatePublicationPreflight(prisma, ready.publication.id)).ready, true);
  const noAsset = await makeReadyPublication(`${prefix}preflight-noasset`, Platform.TIKTOK, { asset: false });
  assert.ok((await evaluatePublicationPreflight(prisma, noAsset.publication.id)).blockers.some((item) => item.code === 'DURABLE_VIDEO_MISSING'));
  const qaFail = await makeReadyPublication(`${prefix}preflight-qafail`, Platform.TIKTOK, { qaPass: false });
  assert.ok((await evaluatePublicationPreflight(prisma, qaFail.publication.id)).blockers.some((item) => item.code === 'QA_NOT_APPROVED'));
  const short = await makeReadyPublication(`${prefix}preflight-short`, Platform.TIKTOK, { duration: 60.9 });
  assert.ok((await evaluatePublicationPreflight(prisma, short.publication.id)).blockers.some((item) => item.code === 'TIKTOK_INTERNAL_61S_RULE'));
  const published = await makeReadyPublication(`${prefix}preflight-published`, Platform.YOUTUBE, { publicationStatus: PublicationStatus.PUBLISHED });
  assert.ok((await evaluatePublicationPreflight(prisma, published.publication.id)).blockers.some((item) => item.code === 'PUBLICATION_ALREADY_PUBLISHED'));
  const cancelled = await makeReadyPublication(`${prefix}preflight-cancelled`, Platform.FACEBOOK, { publicationStatus: PublicationStatus.CANCELLED });
  assert.ok((await evaluatePublicationPreflight(prisma, cancelled.publication.id)).blockers.some((item) => item.code === 'PUBLICATION_CANCELLED'));
});

test('schedule stores UTC + IANA timezone, rejects stale/past/duplicate and reschedule preserves history', async () => {
  const { publication } = await makeReadyPublication(`${prefix}lifecycle`);
  const created = await schedule(publication.id, 1, '2026-09-15T15:00:00');
  assert.equal(created.schedule.scheduledAtUtc, '2026-09-15T21:00:00.000Z');
  assert.equal(created.schedule.timezone, 'America/Mexico_City');
  assert.equal((await prisma.publication.findUniqueOrThrow({ where: { id: publication.id } })).status, PublicationStatus.SCHEDULED);
  await assert.rejects(() => schedule(publication.id, 1, '2026-09-15T16:00:00'), (error) => expectApi(error, 'PUBLICATION_VERSION_CONFLICT'));
  await assert.rejects(() => createPublicationSchedule(prisma, publication.id, { localDateTime: '2026-09-15T16:00:00', timezone: 'America/Mexico_City', expectedVersion: created.publicationVersion }, baseConfig, admin, 'dup', creationClock), (error) => expectApi(error, 'PUBLICATION_NOT_READY'));
  await assert.rejects(() => reschedulePublication(prisma, created.schedule.id, { localDateTime: '2026-09-15T13:00:00', timezone: 'America/Mexico_City', expectedVersion: created.schedule.version }, baseConfig, admin, 'past', clock), (error) => expectApi(error, 'SCHEDULE_IN_PAST'));
  const rescheduled = await reschedulePublication(prisma, created.schedule.id, { localDateTime: '2026-09-15T16:30:00', timezone: 'America/Mexico_City', expectedVersion: created.schedule.version }, baseConfig, admin, 'reschedule', creationClock);
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: created.schedule.id } })).status, ScheduleStatus.SUPERSEDED);
  assert.equal(rescheduled.schedule.status, ScheduleStatus.SCHEDULED);
  assert.notEqual(rescheduled.schedule.id, created.schedule.id);
  await assert.rejects(() => cancelSchedule(prisma, rescheduled.schedule.id, 99, admin, 'stale'), (error) => expectApi(error, 'SCHEDULE_VERSION_CONFLICT'));
  const cancelled = await cancelSchedule(prisma, rescheduled.schedule.id, rescheduled.schedule.version, admin, 'cancel');
  assert.equal(cancelled.schedule.status, ScheduleStatus.CANCELLED);
  assert.equal(cancelled.publicationStatus, PublicationStatus.READY);
});

test('concurrent schedule creation leaves only one active schedule per publication', async () => {
  const { publication } = await makeReadyPublication(`${prefix}schedule-race`, Platform.YOUTUBE);
  const input = { localDateTime: '2026-09-15T17:00:00', timezone: 'America/Mexico_City', expectedVersion: publication.version };
  const outcomes = await Promise.allSettled([
    createPublicationSchedule(prisma, publication.id, input, baseConfig, admin, 'race-a', creationClock),
    createPublicationSchedule(prisma, publication.id, input, baseConfig, admin, 'race-b', creationClock),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(await prisma.schedule.count({ where: { publicationId: publication.id, status: ScheduleStatus.SCHEDULED } }), 1);
});

test('calendar range and platform/status/channel filters are server-side', async () => {
  const a = await makeReadyPublication(`${prefix}calendar-a`, Platform.TIKTOK);
  const b = await makeReadyPublication(`${prefix}calendar-b`, Platform.YOUTUBE);
  await schedule(a.publication.id, 1, '2026-09-15T15:00:00');
  await schedule(b.publication.id, 1, '2026-09-16T15:00:00');
  const result = await listCalendar(prisma, { start: new Date('2026-09-15T00:00:00Z'), end: new Date('2026-09-17T00:00:00Z'), platform: Platform.TIKTOK, status: ScheduleStatus.SCHEDULED, channelId: a.channelId });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.platform, Platform.TIKTOK);
  assert.equal(result.items[0]?.timezone, 'America/Mexico_City');
  const outside = await listCalendar(prisma, { start: new Date('2026-09-18T00:00:00Z'), end: new Date('2026-09-19T00:00:00Z') });
  assert.equal(outside.items.length, 0);
});

test('scheduler ignores future work, recovers late schedules and produces exactly one durable PENDING dispatch', async () => {
  const due = await makeReadyPublication(`${prefix}scheduler-due`, Platform.YOUTUBE);
  const future = await makeReadyPublication(`${prefix}scheduler-future`, Platform.FACEBOOK);
  const dueSchedule = await schedule(due.publication.id, 1, '2026-09-15T13:00:00');
  const futureSchedule = await schedule(future.publication.id, 1, '2026-09-15T16:00:00');
  const result = await runSchedulerTick(prisma, { ...baseConfig, schedulerMaxLatenessSeconds: 300 }, { clock, schedulerRunId: 'phase6-run-one' });
  assert.equal(result.dispatched, 1);
  assert.equal(await prisma.publicationDispatch.count({ where: { scheduleId: dueSchedule.schedule.id } }), 1);
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: dueSchedule.schedule.id } })).status, ScheduleStatus.DISPATCHED);
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: futureSchedule.schedule.id } })).status, ScheduleStatus.SCHEDULED);
  assert.equal((await prisma.publication.findUniqueOrThrow({ where: { id: due.publication.id } })).status, PublicationStatus.SCHEDULED);
  assert.equal(await prisma.publicationEvent.count({ where: { publicationId: due.publication.id, type: 'SCHEDULE_LATE' } }), 1);
  await assert.rejects(() => cancelSchedule(prisma, dueSchedule.schedule.id, 2, admin, 'cancel-dispatched'), (error) => expectApi(error, 'SCHEDULE_ALREADY_DISPATCHED'));
  const again = await runSchedulerTick(prisma, baseConfig, { clock, schedulerRunId: 'phase6-run-two' });
  assert.equal(again.dispatched, 0);
  assert.equal(await prisma.publicationDispatch.count({ where: { scheduleId: dueSchedule.schedule.id } }), 1);
});

test('scheduler lease has one winner and scheduleId unique remains the exactly-once DB invariant', async () => {
  const outcomes = await Promise.all([acquireSchedulerLease(prisma, 'lease-a', now, 55), acquireSchedulerLease(prisma, 'lease-b', now, 55)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  await releaseSchedulerLease(prisma, outcomes[0] ? 'lease-a' : 'lease-b');
  const { publication } = await makeReadyPublication(`${prefix}unique-dispatch`, Platform.FACEBOOK);
  const scheduled = await schedule(publication.id, 1, '2026-09-15T13:30:00');
  assert.equal(await dispatchDueSchedule(prisma, scheduled.schedule.id, 'unique-run', now), 'dispatched');
  assert.equal(await dispatchDueSchedule(prisma, scheduled.schedule.id, 'unique-run-2', now), 'alreadyDispatched');
  const dispatch = await prisma.publicationDispatch.findUniqueOrThrow({ where: { scheduleId: scheduled.schedule.id } });
  await assert.rejects(() => prisma.publicationDispatch.create({ data: { publicationId: publication.id, scheduleId: scheduled.schedule.id, assetId: dispatch.assetId, notBefore: now, payloadSnapshot: {} } }), (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
});

test('crash recovery does not duplicate committed dispatch and continues remaining due work after lease expiry', async () => {
  const first = await makeReadyPublication(`${prefix}crash-a`, Platform.YOUTUBE);
  const second = await makeReadyPublication(`${prefix}crash-b`, Platform.FACEBOOK);
  const a = await schedule(first.publication.id, 1, '2026-09-15T13:00:00');
  const b = await schedule(second.publication.id, 1, '2026-09-15T13:05:00');
  assert.equal(await acquireSchedulerLease(prisma, 'crashed-run', now, 55), true);
  assert.equal(await dispatchDueSchedule(prisma, a.schedule.id, 'crashed-run', now), 'dispatched');
  await prisma.schedulerLease.update({ where: { name: 'publication-dispatcher' }, data: { leaseExpiresAt: new Date(now.getTime() - 1) } });
  const recovered = await runSchedulerTick(prisma, baseConfig, { clock, schedulerRunId: 'recovery-run' });
  assert.equal(recovered.dispatched, 1);
  assert.equal(await prisma.publicationDispatch.count({ where: { scheduleId: a.schedule.id } }), 1);
  assert.equal(await prisma.publicationDispatch.count({ where: { scheduleId: b.schedule.id } }), 1);
});

test('dispatch freezes latest editorial metadata and asset; later edits/replacements cannot mutate its snapshot', async () => {
  const fixture = await makeReadyPublication(`${prefix}snapshot`, Platform.YOUTUBE);
  const scheduled = await schedule(fixture.publication.id, 1, '2026-09-15T13:00:00');
  await prisma.publication.update({ where: { id: fixture.publication.id }, data: { caption: 'latest-before-dispatch', version: { increment: 1 } } });
  const oldAsset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: fixture.assetId! } });
  await runSchedulerTick(prisma, baseConfig, { clock, schedulerRunId: 'snapshot-run' });
  const dispatch = await prisma.publicationDispatch.findUniqueOrThrow({ where: { scheduleId: scheduled.schedule.id } });
  const snapshot = dispatch.payloadSnapshot as Record<string, unknown>;
  assert.equal(snapshot.caption, 'latest-before-dispatch');
  assert.equal(snapshot.videoAssetId, oldAsset.id);
  await prisma.publication.update({ where: { id: fixture.publication.id }, data: { caption: 'edited-after-dispatch' } });
  const replacement = await prisma.videoAsset.create({ data: { videoId: fixture.publication.videoId, kind: AssetKind.VIDEO, status: AssetStatus.READY, storageProvider: 'R2', bucket: 'test-bucket', objectKey: `phase6/${fixture.publication.videoId}/replacement.mp4`, mimeType: 'video/mp4', size: 2048n, metadata: {} } });
  await prisma.videoAsset.update({ where: { id: oldAsset.id }, data: { status: AssetStatus.REPLACED } });
  const unchanged = await prisma.publicationDispatch.findUniqueOrThrow({ where: { id: dispatch.id } });
  const unchangedSnapshot = unchanged.payloadSnapshot as Record<string, unknown>;
  assert.equal(unchangedSnapshot.caption, 'latest-before-dispatch');
  assert.equal(unchangedSnapshot.videoAssetId, oldAsset.id);
  assert.notEqual(unchangedSnapshot.videoAssetId, replacement.id);
});

test('same video schedules TikTok YouTube Facebook independently', async () => {
  const id = `${prefix}multi`;
  const base = await makeReadyPublication(id, Platform.TIKTOK);
  const youtube = await prisma.publication.create({ data: { videoId: id, platform: Platform.YOUTUBE, status: PublicationStatus.READY, version: 1, ...metadata(Platform.YOUTUBE), raw: {} } });
  const facebook = await prisma.publication.create({ data: { videoId: id, platform: Platform.FACEBOOK, status: PublicationStatus.READY, version: 1, ...metadata(Platform.FACEBOOK), raw: {} } });
  const tik = await schedule(base.publication.id, 1, '2026-09-15T13:30:00');
  const yt = await schedule(youtube.id, 1, '2026-09-15T16:00:00');
  const fb = await schedule(facebook.id, 1, '2026-09-15T18:00:00');
  await runSchedulerTick(prisma, baseConfig, { clock, schedulerRunId: 'multi-run' });
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: tik.schedule.id } })).status, ScheduleStatus.DISPATCHED);
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: yt.schedule.id } })).status, ScheduleStatus.SCHEDULED);
  assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: fb.schedule.id } })).status, ScheduleStatus.SCHEDULED);
  assert.equal(await prisma.publicationDispatch.count({ where: { publicationId: base.publication.id } }), 1);
  assert.equal(await prisma.publicationDispatch.count({ where: { publicationId: { in: [youtube.id, facebook.id] } } }), 0);
});

test('batch size caps one tick and the next tick continues remaining due schedules', async () => {
  const publications = [];
  for (let index = 0; index < 4; index += 1) publications.push(await makeReadyPublication(`${prefix}batch-${index}`, Platform.FACEBOOK));
  for (const fixture of publications) await schedule(fixture.publication.id, 1, '2026-09-15T13:00:00');
  const first = await runSchedulerTick(prisma, { ...baseConfig, schedulerBatchSize: 3 }, { clock, schedulerRunId: 'batch-one' });
  assert.equal(first.dueFound, 3); assert.equal(first.dispatched, 3);
  const second = await runSchedulerTick(prisma, { ...baseConfig, schedulerBatchSize: 3 }, { clock, schedulerRunId: 'batch-two' });
  assert.equal(second.dispatched, 1);
});
