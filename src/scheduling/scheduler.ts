import { randomUUID } from 'node:crypto';
import {
  ActorType,
  AssetKind,
  AssetStatus,
  Prisma,
  PublicationDispatchStatus,
  PublicationStatus,
  ScheduleStatus,
  type PrismaClient,
} from '@prisma/client';
import type { AppConfig } from '../config.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { SchedulerItemLogFields, SchedulerLogger, SchedulerRunLogFields } from './logging.js';
import { evaluatePublicationPreflight } from './preflight.js';

const LEASE_NAME = 'publication-dispatcher';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface SchedulerTickResult {
  schedulerRunId: string;
  leaseOwner: string;
  leaseAcquired: boolean;
  startedAt: string;
  durationMs: number;
  dueFound: number;
  processed: number;
  dispatched: number;
  alreadyDispatched: number;
  late: number;
  skipped: number;
  failed: number;
}

function runLogFields(result: SchedulerTickResult): SchedulerRunLogFields {
  return {
    schedulerRunId: result.schedulerRunId,
    leaseOwner: result.leaseOwner,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    dueFound: result.dueFound,
    dispatched: result.dispatched,
    alreadyDispatched: result.alreadyDispatched,
    late: result.late,
    failed: result.failed,
  };
}

function safeRunLog(logger: SchedulerLogger | undefined, result: SchedulerTickResult): void {
  if (!logger) return;
  try { logger.logRun(runLogFields(result)); } catch { return; }
}

function safeItemLog(logger: SchedulerLogger | undefined, fields: SchedulerItemLogFields): void {
  if (!logger) return;
  try { logger.logItem(fields); } catch { return; }
}

function failureCode(payload: Prisma.JsonValue | null, schedulerRunId: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Prisma.JsonObject;
  return record.schedulerRunId === schedulerRunId && typeof record.errorCode === 'string' ? record.errorCode : undefined;
}

export async function acquireSchedulerLease(prisma: PrismaClient, owner: string, now: Date, leaseSeconds: number): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO scheduler_leases (name, owner, leaseExpiresAt, updatedAt)
    VALUES (${LEASE_NAME}, ${owner}, ${expiresAt}, ${now})
    ON DUPLICATE KEY UPDATE
      owner = IF(leaseExpiresAt <= ${now} OR owner = ${owner}, VALUES(owner), owner),
      leaseExpiresAt = IF(leaseExpiresAt <= ${now} OR owner = ${owner}, VALUES(leaseExpiresAt), leaseExpiresAt),
      updatedAt = IF(leaseExpiresAt <= ${now} OR owner = ${owner}, VALUES(updatedAt), updatedAt)
  `);
  const lease = await prisma.schedulerLease.findUnique({ where: { name: LEASE_NAME } });
  return lease?.owner === owner && lease.leaseExpiresAt.getTime() === expiresAt.getTime();
}

export async function releaseSchedulerLease(prisma: PrismaClient, owner: string): Promise<void> {
  await prisma.schedulerLease.deleteMany({ where: { name: LEASE_NAME, owner } });
}

async function lockSchedule(tx: Prisma.TransactionClient, scheduleId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM schedules WHERE id = ${scheduleId} FOR UPDATE`);
}

export type DispatchOutcome = 'dispatched' | 'alreadyDispatched' | 'skipped' | 'failed';

export async function dispatchDueSchedule(prisma: PrismaClient, scheduleId: string, schedulerRunId: string, now: Date, maxLatenessSeconds?: number): Promise<DispatchOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockSchedule(tx, scheduleId);
    const existing = await tx.publicationDispatch.findUnique({ where: { scheduleId } });
    if (existing) return 'alreadyDispatched';

    const schedule = await tx.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        publication: {
          include: {
            video: {
              include: {
                assets: { where: { status: AssetStatus.READY, storageProvider: 'R2', kind: { in: [AssetKind.VIDEO, AssetKind.COVER, AssetKind.THUMBNAIL] } }, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }] },
                channel: { include: { profiles: true } },
              },
            },
          },
        },
      },
    });
    if (!schedule || schedule.status !== ScheduleStatus.SCHEDULED) return 'skipped';
    if (schedule.scheduledAt.getTime() > now.getTime()) return 'skipped';
    if (schedule.publication.status !== PublicationStatus.SCHEDULED) {
      await tx.publicationEvent.create({ data: { publicationId: schedule.publicationId, type: 'SCHEDULE_DISPATCH_FAILED', fromStatus: schedule.publication.status, toStatus: schedule.publication.status, payload: json({ scheduleId, schedulerRunId, errorCode: 'PUBLICATION_NOT_SCHEDULED' }) } });
      return 'failed';
    }

    const preflight = await evaluatePublicationPreflight(tx, schedule.publicationId, { ignoreScheduleId: schedule.id, allowActiveSchedule: true });
    if (!preflight.ready || !preflight.preview?.videoAssetId) {
      await tx.publicationEvent.create({ data: { publicationId: schedule.publicationId, type: 'SCHEDULE_DISPATCH_FAILED', fromStatus: schedule.publication.status, toStatus: schedule.publication.status, payload: json({ scheduleId, schedulerRunId, errorCode: 'PREFLIGHT_FAILED', blockers: preflight.blockers.map((item) => item.code) }) } });
      return 'failed';
    }

    const publication = schedule.publication;
    const videoAsset = publication.video.assets.find((asset) => asset.id === preflight.preview?.videoAssetId);
    if (!videoAsset) {
      await tx.publicationEvent.create({ data: { publicationId: schedule.publicationId, type: 'SCHEDULE_DISPATCH_FAILED', payload: json({ scheduleId, schedulerRunId, errorCode: 'DURABLE_ASSET_CHANGED' }) } });
      return 'failed';
    }
    const coverAsset = publication.video.assets.find((asset) => asset.kind === AssetKind.COVER) ?? null;
    const thumbnailAsset = publication.video.assets.find((asset) => asset.kind === AssetKind.THUMBNAIL) ?? null;
    const profile = publication.video.channel.profiles.find((item) => item.platform === publication.platform) ?? null;
    const hashtags = stringArray(publication.hashtags);
    const tags = stringArray(publication.tags);
    const payloadSnapshot = {
      schemaVersion: 2,
      publicationId: publication.id,
      publicationVersion: publication.version,
      videoId: publication.videoId,
      platform: publication.platform,
      profileId: profile?.id ?? null,
      title: publication.title,
      caption: publication.caption,
      description: publication.description,
      hashtags,
      tags,
      cta: publication.cta,
      pinnedComment: publication.pinnedComment,
      durationSeconds: preflight.preview.durationSeconds,
      tiktok: publication.platform === 'TIKTOK' ? {
        privacyLevel: publication.tiktokPrivacyLevel,
        allowComment: publication.tiktokAllowComment,
        allowDuet: publication.tiktokAllowDuet,
        allowStitch: publication.tiktokAllowStitch,
        isAigc: publication.tiktokIsAigc,
      } : null,
      youtube: publication.platform === 'YOUTUBE' ? {
        privacyStatus: publication.youtubePrivacyStatus,
        categoryId: publication.youtubeCategoryId,
        madeForKids: publication.youtubeMadeForKids,
        containsSyntheticMedia: publication.youtubeContainsSyntheticMedia,
      } : null,
      videoAssetId: videoAsset.id,
      coverAssetId: coverAsset?.id ?? null,
      thumbnailAssetId: thumbnailAsset?.id ?? null,
      scheduledAtUtc: schedule.scheduledAt.toISOString(),
      timezone: schedule.timezone,
    };

    let dispatch;
    try {
      dispatch = await tx.publicationDispatch.create({ data: {
        publicationId: publication.id,
        scheduleId: schedule.id,
        assetId: videoAsset.id,
        status: PublicationDispatchStatus.PENDING,
        notBefore: schedule.scheduledAt,
        payloadSnapshot: json(payloadSnapshot),
      } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'alreadyDispatched';
      throw error;
    }

    await tx.schedule.update({ where: { id: schedule.id }, data: { status: ScheduleStatus.DISPATCHED, version: { increment: 1 } } });
    await tx.publicationEvent.create({ data: {
      publicationId: publication.id,
      type: 'SCHEDULE_DISPATCHED',
      fromStatus: ScheduleStatus.SCHEDULED,
      toStatus: ScheduleStatus.DISPATCHED,
      dispatchId: dispatch.id,
      payload: json({ scheduleId: schedule.id, schedulerRunId, assetId: videoAsset.id }),
    } });
    await tx.auditLog.create({ data: {
      actorType: ActorType.SYSTEM,
      actor: `scheduler:${schedulerRunId}`,
      action: 'SCHEDULE_DISPATCHED',
      entityType: 'SCHEDULE',
      entityId: schedule.id,
      beforeData: json({ status: ScheduleStatus.SCHEDULED }),
      afterData: json({ status: ScheduleStatus.DISPATCHED, dispatchId: dispatch.id }),
      metadata: json({ publicationId: publication.id, videoId: publication.videoId, platform: publication.platform }),
    } });

    if (maxLatenessSeconds !== undefined && now.getTime() - schedule.scheduledAt.getTime() > maxLatenessSeconds * 1000) {
      await tx.publicationEvent.create({ data: {
        publicationId: publication.id,
        type: 'SCHEDULE_LATE',
        dispatchId: dispatch.id,
        payload: json({ scheduleId: schedule.id, schedulerRunId, lateBySeconds: Math.floor((now.getTime() - schedule.scheduledAt.getTime()) / 1000) }),
      } });
    }
    return 'dispatched';
  });
}

async function recordItemFailure(prisma: PrismaClient, scheduleId: string, schedulerRunId: string, error: unknown): Promise<void> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId }, select: { publicationId: true } });
  if (!schedule) return;
  const errorCode = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'SCHEDULER_ITEM_ERROR';
  await prisma.publicationEvent.create({ data: { publicationId: schedule.publicationId, type: 'SCHEDULE_DISPATCH_FAILED', payload: json({ scheduleId, schedulerRunId, errorCode }) } });
}

async function logProcessedItem(
  prisma: PrismaClient,
  logger: SchedulerLogger | undefined,
  item: { id: string; publicationId: string; scheduledAt: Date; publication: { platform: import('@prisma/client').Platform } },
  schedulerRunId: string,
  now: Date,
  outcome: DispatchOutcome,
): Promise<number> {
  const latenessSeconds = Math.max(0, Math.floor((now.getTime() - item.scheduledAt.getTime()) / 1000));
  let dispatchId: string | undefined;
  let errorCode: string | undefined;

  if (outcome === 'dispatched' || outcome === 'alreadyDispatched') {
    const dispatch = await prisma.publicationDispatch.findUnique({ where: { scheduleId: item.id }, select: { id: true } });
    dispatchId = dispatch?.id;
  }
  if (outcome === 'failed') {
    const failure = await prisma.publicationEvent.findFirst({
      where: { publicationId: item.publicationId, type: 'SCHEDULE_DISPATCH_FAILED' },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    errorCode = failureCode(failure?.payload ?? null, schedulerRunId);
  }

  safeItemLog(logger, {
    publicationId: item.publicationId,
    scheduleId: item.id,
    platform: item.publication.platform,
    latenessSeconds,
    ...(dispatchId ? { dispatchId } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
  return latenessSeconds;
}

export async function runSchedulerTick(prisma: PrismaClient, config: AppConfig, options: { clock?: Clock; schedulerRunId?: string; logger?: SchedulerLogger } = {}): Promise<SchedulerTickResult> {
  const clock = options.clock ?? systemClock;
  const started = clock.now();
  const schedulerRunId = options.schedulerRunId ?? randomUUID();
  const leaseOwner = schedulerRunId;
  const leaseSeconds = config.schedulerLeaseSeconds ?? 55;
  const batchSize = config.schedulerBatchSize ?? 50;
  const acquired = await acquireSchedulerLease(prisma, leaseOwner, started, leaseSeconds);
  const result: SchedulerTickResult = { schedulerRunId, leaseOwner, leaseAcquired: acquired, startedAt: started.toISOString(), durationMs: 0, dueFound: 0, processed: 0, dispatched: 0, alreadyDispatched: 0, late: 0, skipped: 0, failed: 0 };
  if (!acquired) {
    result.durationMs = Math.max(0, clock.now().getTime() - started.getTime());
    safeRunLog(options.logger, result);
    return result;
  }

  try {
    const due = await prisma.schedule.findMany({
      where: { status: ScheduleStatus.SCHEDULED, scheduledAt: { lte: started } },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: batchSize,
      select: { id: true, publicationId: true, scheduledAt: true, publication: { select: { platform: true } } },
    });
    result.dueFound = due.length;
    for (const item of due) {
      result.processed += 1;
      let outcome: DispatchOutcome;
      try {
        outcome = await dispatchDueSchedule(prisma, item.id, schedulerRunId, started, config.schedulerMaxLatenessSeconds);
        if (outcome === 'dispatched') result.dispatched += 1;
        else if (outcome === 'alreadyDispatched') result.alreadyDispatched += 1;
        else if (outcome === 'skipped') result.skipped += 1;
        else result.failed += 1;
      } catch (error) {
        outcome = 'failed';
        result.failed += 1;
        await recordItemFailure(prisma, item.id, schedulerRunId, error).catch(() => undefined);
      }

      try {
        const latenessSeconds = await logProcessedItem(prisma, options.logger, item, schedulerRunId, started, outcome);
        if (outcome === 'dispatched' && config.schedulerMaxLatenessSeconds !== undefined && latenessSeconds > config.schedulerMaxLatenessSeconds) result.late += 1;
      } catch {
        safeItemLog(options.logger, { publicationId: item.publicationId, scheduleId: item.id, platform: item.publication.platform, errorCode: 'LOG_CONTEXT_UNAVAILABLE' });
      }
    }
    return result;
  } finally {
    await releaseSchedulerLease(prisma, leaseOwner).catch(() => undefined);
    result.durationMs = Math.max(0, clock.now().getTime() - started.getTime());
    safeRunLog(options.logger, result);
  }
}
