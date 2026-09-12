import {
  ActorType,
  Platform,
  PublicationStatus,
  ScheduleStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { AppConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { evaluatePublicationPreflight } from './preflight.js';
import { formatInstantInTimeZone, localDateTimeToUtc, TimeZoneError } from './timezone.js';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function lockPublication(tx: Prisma.TransactionClient, publicationId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM publications WHERE id = ${publicationId} FOR UPDATE`);
}

async function lockSchedule(tx: Prisma.TransactionClient, scheduleId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM schedules WHERE id = ${scheduleId} FOR UPDATE`);
}

function mapTimeZoneError(error: unknown): never {
  if (error instanceof TimeZoneError) throw new ApiError(400, error.code, error.message);
  throw error;
}

function scheduleInstant(localDateTime: string, timezone: string, config: AppConfig, clock: Clock): Date {
  let scheduledAt: Date;
  try {
    scheduledAt = localDateTimeToUtc(localDateTime, timezone);
  } catch (error) {
    mapTimeZoneError(error);
  }
  const now = clock.now();
  const pastToleranceMs = (config.schedulePastToleranceSeconds ?? 60) * 1000;
  if (scheduledAt!.getTime() < now.getTime() - pastToleranceMs) throw new ApiError(400, 'SCHEDULE_IN_PAST', 'Scheduled time is too far in the past');
  const minLeadMs = (config.scheduleMinLeadSeconds ?? 0) * 1000;
  if (minLeadMs > 0 && scheduledAt!.getTime() < now.getTime() + minLeadMs) throw new ApiError(400, 'SCHEDULE_TOO_SOON', 'Scheduled time does not meet the configured minimum lead time');
  return scheduledAt!;
}

function scheduleDto(schedule: { id: string; publicationId: string; scheduledAt: Date; timezone: string; status: ScheduleStatus; version: number; createdAt: Date; updatedAt: Date }) {
  return {
    id: schedule.id,
    publicationId: schedule.publicationId,
    status: schedule.status,
    version: schedule.version,
    scheduledAtUtc: schedule.scheduledAt.toISOString(),
    localDateTime: formatInstantInTimeZone(schedule.scheduledAt, schedule.timezone),
    timezone: schedule.timezone,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export interface ScheduleMutationInput {
  localDateTime: string;
  timezone: string;
  expectedVersion: number;
}

export async function createPublicationSchedule(prisma: PrismaClient, publicationId: string, input: ScheduleMutationInput, config: AppConfig, actorEmail: string, requestId: string, clock: Clock = systemClock) {
  const scheduledAt = scheduleInstant(input.localDateTime, input.timezone, config, clock);
  return prisma.$transaction(async (tx) => {
    await lockPublication(tx, publicationId);
    const publication = await tx.publication.findUnique({ where: { id: publicationId }, select: { id: true, videoId: true, platform: true, status: true, version: true, scheduledAt: true } });
    if (!publication) throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Publication was not found');
    if (publication.version !== input.expectedVersion) throw new ApiError(409, 'PUBLICATION_VERSION_CONFLICT', 'Publication changed since it was loaded');

    const preflight = await evaluatePublicationPreflight(tx, publicationId);
    if (!preflight.ready) throw new ApiError(422, 'PUBLICATION_NOT_READY', 'Publication preflight has blockers', { blockers: preflight.blockers });
    const existing = await tx.schedule.count({ where: { publicationId, status: ScheduleStatus.SCHEDULED } });
    if (existing > 0) throw new ApiError(409, 'ACTIVE_SCHEDULE_EXISTS', 'Publication already has an active schedule');

    const schedule = await tx.schedule.create({ data: { publicationId, scheduledAt, timezone: input.timezone, status: ScheduleStatus.SCHEDULED } });
    const updatedPublication = await tx.publication.update({ where: { id: publicationId }, data: { status: PublicationStatus.SCHEDULED, scheduledAt, version: { increment: 1 } }, select: { version: true } });
    await tx.auditLog.create({ data: {
      actorType: ActorType.ADMIN, actor: actorEmail, action: 'PUBLICATION_SCHEDULED', entityType: 'SCHEDULE', entityId: schedule.id, requestId,
      beforeData: json({ publicationStatus: publication.status, scheduledAt: publication.scheduledAt }),
      afterData: json({ publicationStatus: PublicationStatus.SCHEDULED, scheduledAt: scheduledAt.toISOString(), timezone: input.timezone, scheduleId: schedule.id }),
      metadata: json({ publicationId, videoId: publication.videoId, platform: publication.platform }),
    } });
    await tx.publicationEvent.create({ data: { publicationId, type: 'PUBLICATION_SCHEDULED', fromStatus: publication.status, toStatus: PublicationStatus.SCHEDULED, payload: json({ scheduleId: schedule.id, scheduledAtUtc: scheduledAt.toISOString(), timezone: input.timezone }) } });
    return { schedule: scheduleDto(schedule), publicationVersion: updatedPublication.version, preflight };
  });
}

export async function reschedulePublication(prisma: PrismaClient, scheduleId: string, input: ScheduleMutationInput, config: AppConfig, actorEmail: string, requestId: string, clock: Clock = systemClock) {
  const scheduledAt = scheduleInstant(input.localDateTime, input.timezone, config, clock);
  return prisma.$transaction(async (tx) => {
    await lockSchedule(tx, scheduleId);
    const current = await tx.schedule.findUnique({ where: { id: scheduleId }, include: { publication: { select: { id: true, videoId: true, platform: true, status: true, version: true } } } });
    if (!current) throw new ApiError(404, 'SCHEDULE_NOT_FOUND', 'Schedule was not found');
    if (current.version !== input.expectedVersion) throw new ApiError(409, 'SCHEDULE_VERSION_CONFLICT', 'Schedule changed since it was loaded');
    if (current.status === ScheduleStatus.DISPATCHED) throw new ApiError(409, 'SCHEDULE_ALREADY_DISPATCHED', 'Dispatched schedules cannot be edited in Phase 6');
    if (current.status !== ScheduleStatus.SCHEDULED) throw new ApiError(409, 'SCHEDULE_NOT_ACTIVE', 'Only active schedules can be rescheduled');
    await lockPublication(tx, current.publicationId);

    const preflight = await evaluatePublicationPreflight(tx, current.publicationId, { ignoreScheduleId: current.id });
    if (!preflight.ready) throw new ApiError(422, 'PUBLICATION_NOT_READY', 'Publication preflight has blockers', { blockers: preflight.blockers });
    const competing = await tx.schedule.count({ where: { publicationId: current.publicationId, status: ScheduleStatus.SCHEDULED, id: { not: current.id } } });
    if (competing > 0) throw new ApiError(409, 'ACTIVE_SCHEDULE_EXISTS', 'Publication already has another active schedule');

    const superseded = await tx.schedule.update({ where: { id: current.id }, data: { status: ScheduleStatus.SUPERSEDED, version: { increment: 1 } } });
    const replacement = await tx.schedule.create({ data: { publicationId: current.publicationId, scheduledAt, timezone: input.timezone, status: ScheduleStatus.SCHEDULED } });
    const publication = await tx.publication.update({ where: { id: current.publicationId }, data: { status: PublicationStatus.SCHEDULED, scheduledAt, version: { increment: 1 } }, select: { version: true } });
    await tx.auditLog.create({ data: {
      actorType: ActorType.ADMIN, actor: actorEmail, action: 'PUBLICATION_RESCHEDULED', entityType: 'SCHEDULE', entityId: replacement.id, requestId,
      beforeData: json(scheduleDto(superseded)), afterData: json(scheduleDto(replacement)), metadata: json({ publicationId: current.publicationId, videoId: current.publication.videoId, platform: current.publication.platform, supersededScheduleId: current.id }),
    } });
    await tx.publicationEvent.create({ data: { publicationId: current.publicationId, type: 'PUBLICATION_RESCHEDULED', fromStatus: ScheduleStatus.SCHEDULED, toStatus: ScheduleStatus.SCHEDULED, payload: json({ supersededScheduleId: current.id, scheduleId: replacement.id, scheduledAtUtc: scheduledAt.toISOString(), timezone: input.timezone }) } });
    return { schedule: scheduleDto(replacement), supersededScheduleId: current.id, publicationVersion: publication.version, preflight };
  });
}

export async function cancelSchedule(prisma: PrismaClient, scheduleId: string, expectedVersion: number, actorEmail: string, requestId: string) {
  return prisma.$transaction(async (tx) => {
    await lockSchedule(tx, scheduleId);
    const current = await tx.schedule.findUnique({ where: { id: scheduleId }, include: { publication: { select: { id: true, videoId: true, platform: true, status: true, version: true } } } });
    if (!current) throw new ApiError(404, 'SCHEDULE_NOT_FOUND', 'Schedule was not found');
    if (current.version !== expectedVersion) throw new ApiError(409, 'SCHEDULE_VERSION_CONFLICT', 'Schedule changed since it was loaded');
    if (current.status === ScheduleStatus.DISPATCHED) throw new ApiError(409, 'SCHEDULE_ALREADY_DISPATCHED', 'Dispatched schedules cannot be cancelled in Phase 6');
    if (current.status !== ScheduleStatus.SCHEDULED) throw new ApiError(409, 'SCHEDULE_NOT_ACTIVE', 'Schedule is not active');
    await lockPublication(tx, current.publicationId);

    const cancelled = await tx.schedule.update({ where: { id: current.id }, data: { status: ScheduleStatus.CANCELLED, version: { increment: 1 } } });
    const remaining = await tx.schedule.count({ where: { publicationId: current.publicationId, status: ScheduleStatus.SCHEDULED } });
    const publication = remaining === 0
      ? await tx.publication.update({ where: { id: current.publicationId }, data: { status: PublicationStatus.READY, scheduledAt: null, version: { increment: 1 } }, select: { version: true, status: true } })
      : await tx.publication.findUniqueOrThrow({ where: { id: current.publicationId }, select: { version: true, status: true } });
    await tx.auditLog.create({ data: {
      actorType: ActorType.ADMIN, actor: actorEmail, action: 'PUBLICATION_SCHEDULE_CANCELLED', entityType: 'SCHEDULE', entityId: current.id, requestId,
      beforeData: json(scheduleDto(current)), afterData: json(scheduleDto(cancelled)), metadata: json({ publicationId: current.publicationId, videoId: current.publication.videoId, platform: current.publication.platform }),
    } });
    await tx.publicationEvent.create({ data: { publicationId: current.publicationId, type: 'PUBLICATION_SCHEDULE_CANCELLED', fromStatus: ScheduleStatus.SCHEDULED, toStatus: ScheduleStatus.CANCELLED, payload: json({ scheduleId: current.id }) } });
    return { schedule: scheduleDto(cancelled), publicationStatus: publication.status, publicationVersion: publication.version };
  });
}

export async function cancelPublication(prisma: PrismaClient, publicationId: string, expectedVersion: number, actorEmail: string, requestId: string) {
  return prisma.$transaction(async (tx) => {
    await lockPublication(tx, publicationId);
    const publication = await tx.publication.findUnique({ where: { id: publicationId }, select: { id: true, videoId: true, platform: true, status: true, version: true } });
    if (!publication) throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Publication was not found');
    if (publication.version !== expectedVersion) throw new ApiError(409, 'PUBLICATION_VERSION_CONFLICT', 'Publication changed since it was loaded');
    if (publication.status === PublicationStatus.PUBLISHED) throw new ApiError(409, 'PUBLICATION_ALREADY_PUBLISHED', 'Published publication cannot be cancelled');
    const dispatched = await tx.schedule.count({ where: { publicationId, status: ScheduleStatus.DISPATCHED } });
    if (dispatched > 0) throw new ApiError(409, 'PUBLICATION_ALREADY_DISPATCHED', 'Publication already has dispatched work; cancellation belongs to Phase 7');
    await tx.schedule.updateMany({ where: { publicationId, status: ScheduleStatus.SCHEDULED }, data: { status: ScheduleStatus.CANCELLED, version: { increment: 1 } } });
    const updated = await tx.publication.update({ where: { id: publicationId }, data: { status: PublicationStatus.CANCELLED, scheduledAt: null, version: { increment: 1 } }, select: { version: true, status: true } });
    await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actorEmail, action: 'PUBLICATION_CANCELLED', entityType: 'PUBLICATION', entityId: publicationId, requestId, beforeData: json({ status: publication.status }), afterData: json({ status: updated.status }), metadata: json({ videoId: publication.videoId, platform: publication.platform }) } });
    await tx.publicationEvent.create({ data: { publicationId, type: 'PUBLICATION_CANCELLED', fromStatus: publication.status, toStatus: PublicationStatus.CANCELLED } });
    return { publicationId, status: updated.status, version: updated.version };
  });
}

export interface CalendarQuery {
  start: Date;
  end: Date;
  platform?: Platform;
  status?: ScheduleStatus;
  channelId?: string;
}

export async function listCalendar(prisma: PrismaClient, query: CalendarQuery) {
  const rows = await prisma.schedule.findMany({
    where: {
      scheduledAt: { gte: query.start, lt: query.end },
      ...(query.status ? { status: query.status } : {}),
      publication: {
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.channelId ? { video: { channelId: query.channelId } } : {}),
      },
    },
    orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    include: { publication: { select: { id: true, platform: true, status: true, title: true, video: { select: { id: true, title: true, channelId: true } } } }, dispatch: { select: { id: true, status: true } } },
  });
  return {
    items: rows.map((row) => ({
      scheduleId: row.id,
      publicationId: row.publicationId,
      videoId: row.publication.video.id,
      channelId: row.publication.video.channelId,
      title: row.publication.title ?? row.publication.video.title,
      platform: row.publication.platform,
      status: row.status,
      scheduledAtUtc: row.scheduledAt.toISOString(),
      localDateTime: formatInstantInTimeZone(row.scheduledAt, row.timezone),
      timezone: row.timezone,
      publicationStatus: row.publication.status,
      version: row.version,
      dispatch: row.dispatch ? { id: row.dispatch.id, status: row.dispatch.status } : null,
    })),
  };
}
