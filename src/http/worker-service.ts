import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ActorType, Prisma, PrismaClient, RenderAttemptStatus, VideoStatus, WorkerStatus } from '@prisma/client';
import type {
  QueueRenderResultDto,
  WorkerCompletionResultDto,
  WorkerDto,
  WorkerFailureResultDto,
  WorkerHeartbeatResultDto,
  WorkerJobDto,
  WorkerListDto,
  WorkerMutationResultDto,
  WorkerProgressResultDto,
  WorkerRenewResultDto,
  WorkerSecretResultDto,
} from '../contracts/worker.js';
import { ApiError } from './errors.js';

export const WORKER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKER_SECRET_DOMAIN = 'video-factory-worker-secret:v1:';
const LEASE_SECRET_DOMAIN = 'video-factory-worker-lease:v1:';

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(authorization|cookie|jwt|token|secret|password|database.?url|refresh.?token|access.?token)/i.test(key)) output[key] = '[REDACTED]';
    else output[key] = sanitizeMetadata(child, depth + 1);
  }
  return output;
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(domain).update(value).digest('hex');
}

export function generateWorkerSecret(): string {
  return `vfws_${randomBytes(32).toString('base64url')}`;
}

export function hashWorkerSecret(secret: string): string {
  return digest(WORKER_SECRET_DOMAIN, secret);
}

function generateLeaseToken(): string {
  return `vfl_${randomBytes(32).toString('base64url')}`;
}

function hashLeaseToken(token: string): string {
  return digest(LEASE_SECRET_DOMAIN, token);
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface WorkerRowForDto {
  id: string;
  status: WorkerStatus;
  agentVersion: string | null;
  rendererVersion: string | null;
  lastHeartbeatAt: Date | null;
  currentVideoId: string | null;
  progress: number | null;
  lastError: string | null;
  secretVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export function effectiveWorkerStatus(worker: Pick<WorkerRowForDto, 'status' | 'lastHeartbeatAt' | 'currentVideoId'>, thresholdSeconds: number, now = new Date()): WorkerDto['effectiveStatus'] {
  if (worker.status === WorkerStatus.DISABLED) return 'DISABLED';
  if (worker.currentVideoId) return 'BUSY';
  if (!worker.lastHeartbeatAt || now.getTime() - worker.lastHeartbeatAt.getTime() > thresholdSeconds * 1000) return 'OFFLINE';
  return 'ONLINE';
}

function workerDto(worker: WorkerRowForDto, thresholdSeconds: number, now = new Date()): WorkerDto {
  return {
    id: worker.id,
    effectiveStatus: effectiveWorkerStatus(worker, thresholdSeconds, now),
    agentVersion: worker.agentVersion,
    rendererVersion: worker.rendererVersion,
    lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
    currentVideoId: worker.currentVideoId,
    progress: worker.progress,
    lastError: worker.lastError,
    secretVersion: worker.secretVersion,
    createdAt: worker.createdAt.toISOString(),
    updatedAt: worker.updatedAt.toISOString(),
  };
}

const workerSelect = {
  id: true,
  status: true,
  agentVersion: true,
  rendererVersion: true,
  lastHeartbeatAt: true,
  currentVideoId: true,
  progress: true,
  lastError: true,
  secretVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type WorkerAuditWriter = (tx: Prisma.TransactionClient, data: Prisma.AuditLogCreateInput) => Promise<unknown>;
const defaultAuditWriter: WorkerAuditWriter = (tx, data) => tx.auditLog.create({ data });

export function createWorkerSecretAuth(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const workerId = req.get('x-worker-id')?.trim();
    if (!workerId || workerId.length > 64 || !WORKER_ID_PATTERN.test(workerId)) return next(new ApiError(401, 'WORKER_ID_INVALID', 'Worker ID is missing or invalid'));
    const authorization = req.get('authorization');
    const match = authorization?.match(/^Bearer (vfws_[A-Za-z0-9_-]{40,})$/);
    if (!match) return next(new ApiError(401, 'WORKER_SECRET_MISSING', 'Worker secret is required'));
    const secret = match[1];
    if (!secret) return next(new ApiError(401, 'WORKER_SECRET_MISSING', 'Worker secret is required'));
    const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { id: true, status: true, secretHash: true, secretVersion: true } });
    if (!worker?.secretHash) return next(new ApiError(401, 'WORKER_CREDENTIALS_INVALID', 'Worker credentials are invalid'));
    if (worker.status === WorkerStatus.DISABLED) return next(new ApiError(403, 'WORKER_DISABLED', 'Worker is disabled'));
    const actual = hashWorkerSecret(secret);
    if (!constantTimeDigestEqual(worker.secretHash, actual)) return next(new ApiError(401, 'WORKER_CREDENTIALS_INVALID', 'Worker credentials are invalid'));
    req.worker = { id: worker.id, secretVersion: worker.secretVersion };
    next();
  };
}

export async function listWorkers(prisma: PrismaClient, thresholdSeconds: number): Promise<WorkerListDto> {
  const rows = await prisma.worker.findMany({ orderBy: { id: 'asc' }, select: workerSelect });
  const now = new Date();
  return { items: rows.map((row) => workerDto(row, thresholdSeconds, now)), offlineThresholdSeconds: thresholdSeconds };
}

export async function createWorker(prisma: PrismaClient, workerId: string, actorEmail: string, requestId: string, thresholdSeconds: number, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<WorkerSecretResultDto> {
  const secret = generateWorkerSecret();
  const secretHash = hashWorkerSecret(secret);
  try {
    const worker = await prisma.$transaction(async (tx) => {
      const created = await tx.worker.create({ data: { id: workerId, status: WorkerStatus.OFFLINE, secretHash, secretVersion: 1 }, select: workerSelect });
      await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'WORKER_CREATED', entityType: 'WORKER', entityId: workerId, requestId, afterData: auditJson({ id: workerId, status: created.status, secretVersion: created.secretVersion }) });
      return created;
    });
    return { worker: workerDto(worker, thresholdSeconds), secret };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'WORKER_EXISTS', 'Worker ID already exists');
    throw error;
  }
}

export async function rotateWorkerSecret(prisma: PrismaClient, workerId: string, actorEmail: string, requestId: string, thresholdSeconds: number, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<WorkerSecretResultDto> {
  const secret = generateWorkerSecret();
  const secretHash = hashWorkerSecret(secret);
  const worker = await prisma.$transaction(async (tx) => {
    const before = await tx.worker.findUnique({ where: { id: workerId }, select: workerSelect });
    if (!before) throw new ApiError(404, 'WORKER_NOT_FOUND', 'Worker was not found');
    const after = await tx.worker.update({ where: { id: workerId }, data: { secretHash, secretVersion: { increment: 1 } }, select: workerSelect });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'WORKER_SECRET_ROTATED', entityType: 'WORKER', entityId: workerId, requestId, beforeData: auditJson({ secretVersion: before.secretVersion }), afterData: auditJson({ secretVersion: after.secretVersion }) });
    return after;
  });
  return { worker: workerDto(worker, thresholdSeconds), secret };
}

export async function revokeWorker(prisma: PrismaClient, workerId: string, actorEmail: string, requestId: string, thresholdSeconds: number, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<WorkerMutationResultDto> {
  const worker = await prisma.$transaction(async (tx) => {
    const before = await tx.worker.findUnique({ where: { id: workerId }, select: workerSelect });
    if (!before) throw new ApiError(404, 'WORKER_NOT_FOUND', 'Worker was not found');
    const after = await tx.worker.update({ where: { id: workerId }, data: { status: WorkerStatus.DISABLED }, select: workerSelect });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'WORKER_REVOKED', entityType: 'WORKER', entityId: workerId, requestId, beforeData: auditJson({ status: before.status }), afterData: auditJson({ status: after.status }) });
    return after;
  });
  return { worker: workerDto(worker, thresholdSeconds) };
}

export async function enableWorker(prisma: PrismaClient, workerId: string, actorEmail: string, requestId: string, thresholdSeconds: number, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<WorkerMutationResultDto> {
  const worker = await prisma.$transaction(async (tx) => {
    const before = await tx.worker.findUnique({ where: { id: workerId }, select: workerSelect });
    if (!before) throw new ApiError(404, 'WORKER_NOT_FOUND', 'Worker was not found');
    const after = await tx.worker.update({ where: { id: workerId }, data: { status: WorkerStatus.OFFLINE, lastError: null }, select: workerSelect });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'WORKER_ENABLED', entityType: 'WORKER', entityId: workerId, requestId, beforeData: auditJson({ status: before.status }), afterData: auditJson({ status: after.status }) });
    return after;
  });
  return { worker: workerDto(worker, thresholdSeconds) };
}

export interface HeartbeatInput {
  agentVersion?: string | null;
  rendererVersion?: string | null;
  currentVideoId?: string | null;
  progress?: number | null;
  lastError?: string | null;
}

export async function heartbeatWorker(prisma: PrismaClient, workerId: string, input: HeartbeatInput): Promise<WorkerHeartbeatResultDto> {
  const current = await prisma.worker.findUnique({ where: { id: workerId }, select: { currentVideoId: true } });
  if (!current) throw new ApiError(401, 'WORKER_CREDENTIALS_INVALID', 'Worker credentials are invalid');
  if (input.currentVideoId !== undefined && input.currentVideoId !== current.currentVideoId) throw new ApiError(409, 'WORKER_JOB_CONTEXT_MISMATCH', 'Heartbeat job context does not match the server lease state');
  const now = new Date();
  const data: Prisma.WorkerUpdateInput = {
    lastHeartbeatAt: now,
    status: current.currentVideoId ? WorkerStatus.BUSY : WorkerStatus.ONLINE,
  };
  if (input.agentVersion !== undefined) data.agentVersion = input.agentVersion;
  if (input.rendererVersion !== undefined) data.rendererVersion = input.rendererVersion;
  if (input.lastError !== undefined) data.lastError = input.lastError;
  if (current.currentVideoId) {
    if (input.progress !== undefined) data.progress = input.progress;
  } else {
    data.progress = null;
  }
  await prisma.worker.update({ where: { id: workerId }, data });
  return { workerId, acceptedAt: now.toISOString() };
}

async function expireOneAbandonedLease(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; videoId: string; workerId: string }>>(Prisma.sql`
    SELECT l.id, l.videoId, l.workerId
    FROM worker_leases l
    INNER JOIN videos v ON v.id = l.videoId
    WHERE l.releasedAt IS NULL
      AND l.leaseExpiresAt <= ${now}
      AND v.status IN ('RENDERING', 'QA')
    ORDER BY l.leaseExpiresAt ASC
    LIMIT 1
    FOR UPDATE
  `);
  const expired = rows[0];
  if (!expired) return;
  const video = await tx.video.findUniqueOrThrow({ where: { id: expired.videoId }, select: { status: true } });
  await tx.workerLease.update({ where: { id: expired.id }, data: { releasedAt: now } });
  const attempt = await tx.renderAttempt.findFirst({ where: { videoId: expired.videoId }, orderBy: { attempt: 'desc' } });
  if (attempt && (attempt.status === RenderAttemptStatus.RUNNING || attempt.status === RenderAttemptStatus.QA)) {
    await tx.renderAttempt.update({ where: { id: attempt.id }, data: { status: RenderAttemptStatus.FAILED, finishedAt: now, error: 'LEASE_EXPIRED' } });
  }
  await tx.video.update({ where: { id: expired.videoId }, data: { status: VideoStatus.QUEUED, version: { increment: 1 } } });
  await tx.jobEvent.create({ data: { videoId: expired.videoId, type: 'LEASE_EXPIRED_REQUEUED', fromStatus: video.status, toStatus: VideoStatus.QUEUED, workerId: expired.workerId, payload: auditJson({ reason: 'LEASE_EXPIRED' }) } });
  await tx.worker.updateMany({ where: { id: expired.workerId, currentVideoId: expired.videoId }, data: { currentVideoId: null, progress: null, status: WorkerStatus.OFFLINE, lastError: 'LEASE_EXPIRED' } });
}

export async function claimNextJob(prisma: PrismaClient, workerId: string, leaseDurationSeconds: number): Promise<WorkerJobDto | null> {
  let leaseToken = '';
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    await expireOneAbandonedLease(tx, now);
    const workerRows = await tx.$queryRaw<Array<{ id: string; currentVideoId: string | null; status: WorkerStatus }>>(Prisma.sql`SELECT id, currentVideoId, status FROM workers WHERE id = ${workerId} FOR UPDATE`);
    const worker = workerRows[0];
    if (!worker) throw new ApiError(401, 'WORKER_CREDENTIALS_INVALID', 'Worker credentials are invalid');
    if (worker.status === WorkerStatus.DISABLED) throw new ApiError(403, 'WORKER_DISABLED', 'Worker is disabled');
    if (worker.currentVideoId) throw new ApiError(409, 'WORKER_BUSY', 'Worker already owns an active job');

    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM videos
      WHERE status = 'QUEUED'
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
      FOR UPDATE
    `);
    const candidate = candidates[0];
    if (!candidate) return null;
    const activeLease = await tx.workerLease.count({ where: { videoId: candidate.id, releasedAt: null, leaseExpiresAt: { gt: now } } });
    if (activeLease > 0) return null;
    const video = await tx.video.findUniqueOrThrow({
      where: { id: candidate.id },
      select: {
        id: true,
        title: true,
        category: true,
        renderConfig: true,
        scenes: { orderBy: { position: 'asc' }, select: { position: true, text: true, searchTerms: true } },
      },
    });
    const aggregate = await tx.renderAttempt.aggregate({ where: { videoId: video.id }, _max: { attempt: true } });
    const attemptNumber = (aggregate._max.attempt ?? 0) + 1;
    const expiresAt = new Date(now.getTime() + leaseDurationSeconds * 1000);
    leaseToken = generateLeaseToken();
    await tx.renderAttempt.create({ data: { videoId: video.id, workerId, workerLabel: workerId, attempt: attemptNumber, status: RenderAttemptStatus.RUNNING, startedAt: now, raw: {} } });
    await tx.workerLease.create({ data: { videoId: video.id, workerId, leaseTokenHash: hashLeaseToken(leaseToken), claimedAt: now, leaseExpiresAt: expiresAt } });
    await tx.video.update({ where: { id: video.id }, data: { status: VideoStatus.RENDERING, version: { increment: 1 } } });
    await tx.jobEvent.create({ data: { videoId: video.id, type: 'RENDER_CLAIMED', fromStatus: VideoStatus.QUEUED, toStatus: VideoStatus.RENDERING, workerId, payload: auditJson({ attempt: attemptNumber }) } });
    await tx.worker.update({ where: { id: workerId }, data: { currentVideoId: video.id, progress: 0, status: WorkerStatus.BUSY, lastError: null } });
    return {
      video: { id: video.id, title: video.title, category: video.category },
      scenes: video.scenes.map((scene) => ({ ...scene, searchTerms: stringArray(scene.searchTerms) })),
      renderConfig: video.renderConfig,
      attempt: attemptNumber,
      leaseToken,
      leaseExpiresAt: expiresAt.toISOString(),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

interface LockedLease { id: string; workerId: string; leaseTokenHash: string; leaseExpiresAt: Date }
interface LeaseContext { lease: LockedLease; attempt: { id: string; attempt: number; status: RenderAttemptStatus; workerId: string | null } }

async function requireLease(tx: Prisma.TransactionClient, workerId: string, videoId: string, leaseToken: string, now: Date): Promise<LeaseContext> {
  const leases = await tx.$queryRaw<LockedLease[]>(Prisma.sql`
    SELECT id, workerId, leaseTokenHash, leaseExpiresAt
    FROM worker_leases
    WHERE videoId = ${videoId} AND releasedAt IS NULL
    ORDER BY claimedAt DESC
    LIMIT 1
    FOR UPDATE
  `);
  const lease = leases[0];
  if (!lease) throw new ApiError(409, 'LEASE_INVALID', 'No active lease exists for this video');
  if (lease.workerId !== workerId) throw new ApiError(403, 'LEASE_NOT_OWNER', 'Lease belongs to another worker');
  if (!constantTimeDigestEqual(lease.leaseTokenHash, hashLeaseToken(leaseToken))) throw new ApiError(403, 'LEASE_INVALID', 'Lease token is invalid');
  if (new Date(lease.leaseExpiresAt).getTime() <= now.getTime()) throw new ApiError(409, 'LEASE_EXPIRED', 'Lease has expired');
  const attempt = await tx.renderAttempt.findFirst({ where: { videoId }, orderBy: { attempt: 'desc' }, select: { id: true, attempt: true, status: true, workerId: true } });
  if (!attempt || attempt.workerId !== workerId || ![RenderAttemptStatus.RUNNING, RenderAttemptStatus.QA].includes(attempt.status)) throw new ApiError(409, 'LEASE_STALE', 'Lease no longer owns the current render attempt');
  return { lease, attempt };
}

export async function renewLease(prisma: PrismaClient, workerId: string, videoId: string, leaseToken: string, leaseDurationSeconds: number): Promise<WorkerRenewResultDto> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const context = await requireLease(tx, workerId, videoId, leaseToken, now);
    const expiresAt = new Date(now.getTime() + leaseDurationSeconds * 1000);
    await tx.workerLease.update({ where: { id: context.lease.id }, data: { leaseExpiresAt: expiresAt } });
    return { videoId, leaseExpiresAt: expiresAt.toISOString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function reportProgress(prisma: PrismaClient, workerId: string, videoId: string, leaseToken: string, progress: number, phase: 'RENDERING' | 'QA'): Promise<WorkerProgressResultDto> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const context = await requireLease(tx, workerId, videoId, leaseToken, now);
    if (phase === 'QA' && context.attempt.status !== RenderAttemptStatus.QA) {
      const video = await tx.video.findUniqueOrThrow({ where: { id: videoId }, select: { status: true } });
      await tx.renderAttempt.update({ where: { id: context.attempt.id }, data: { status: RenderAttemptStatus.QA } });
      if (video.status !== VideoStatus.QA) {
        await tx.video.update({ where: { id: videoId }, data: { status: VideoStatus.QA, version: { increment: 1 } } });
        await tx.jobEvent.create({ data: { videoId, type: 'QA_STARTED', fromStatus: video.status, toStatus: VideoStatus.QA, workerId, payload: auditJson({ attempt: context.attempt.attempt }) } });
      }
    }
    await tx.worker.updateMany({ where: { id: workerId, currentVideoId: videoId }, data: { progress } });
    return { videoId, progress, phase };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export interface CompleteInput {
  rendererVideoId: string;
  localFile: string;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  qa: {
    durationPassed: boolean;
    resolutionPassed: boolean;
    audioPassed: boolean;
    captionsPassed: boolean | null;
    passed: boolean;
    raw: Record<string, unknown>;
  };
}

export interface FailInput { errorCode: string; safeErrorMessage: string }

function idempotencyEnvelope(value: unknown): { requestHash: string; response: unknown } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.requestHash !== 'string' || !Object.hasOwn(record, 'response')) return null;
  return { requestHash: record.requestHash, response: record.response };
}

async function existingIdempotency(prisma: PrismaClient, scope: string, key: string, requestHash: string): Promise<unknown | undefined> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } }, select: { result: true } });
  if (!existing) return undefined;
  const envelope = idempotencyEnvelope(existing.result);
  if (!envelope || envelope.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
  return envelope.response;
}

function completionScope(workerId: string, videoId: string, operation: 'complete' | 'fail'): string {
  return `worker:${workerId}:video:${videoId}:${operation}`;
}

export async function completeJob(prisma: PrismaClient, workerId: string, videoId: string, leaseToken: string, idempotencyKey: string, input: CompleteInput): Promise<WorkerCompletionResultDto> {
  const scope = completionScope(workerId, videoId, 'complete');
  const requestHash = payloadHash(input);
  const prior = await existingIdempotency(prisma, scope, idempotencyKey, requestHash);
  if (prior) return prior as WorkerCompletionResultDto;
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const priorTx = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key: idempotencyKey } }, select: { result: true } });
      if (priorTx) {
        const envelope = idempotencyEnvelope(priorTx.result);
        if (!envelope || envelope.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
        return envelope.response as unknown as WorkerCompletionResultDto;
      }
      const context = await requireLease(tx, workerId, videoId, leaseToken, now);
      const beforeVideo = await tx.video.findUniqueOrThrow({ where: { id: videoId }, select: { status: true } });
      await tx.renderAttempt.update({ where: { id: context.attempt.id }, data: {
        status: RenderAttemptStatus.SUCCEEDED,
        rendererVideoId: input.rendererVideoId,
        finishedAt: now,
        durationSeconds: input.durationSeconds,
        width: input.width,
        height: input.height,
        hasAudio: input.hasAudio,
        localFile: input.localFile,
        error: null,
        raw: auditJson({ storage: 'WORKER_LOCAL' }),
      } });
      await tx.qaResult.upsert({
        where: { videoId_attempt: { videoId, attempt: context.attempt.attempt } },
        create: { videoId, attempt: context.attempt.attempt, passed: input.qa.passed, durationPassed: input.qa.durationPassed, resolutionPassed: input.qa.resolutionPassed, audioPassed: input.qa.audioPassed, captionsPassed: input.qa.captionsPassed, raw: auditJson(sanitizeMetadata(input.qa.raw)) },
        update: { passed: input.qa.passed, durationPassed: input.qa.durationPassed, resolutionPassed: input.qa.resolutionPassed, audioPassed: input.qa.audioPassed, captionsPassed: input.qa.captionsPassed, raw: auditJson(sanitizeMetadata(input.qa.raw)) },
      });
      const nextStatus = input.qa.passed ? VideoStatus.APPROVED : VideoStatus.FAILED;
      await tx.workerLease.update({ where: { id: context.lease.id }, data: { releasedAt: now } });
      await tx.video.update({ where: { id: videoId }, data: { status: nextStatus, version: { increment: 1 } } });
      await tx.jobEvent.create({ data: { videoId, type: input.qa.passed ? 'RENDER_COMPLETED' : 'QA_FAILED', fromStatus: beforeVideo.status, toStatus: nextStatus, workerId, payload: auditJson({ attempt: context.attempt.attempt, qaPassed: input.qa.passed }) } });
      await tx.worker.updateMany({ where: { id: workerId, currentVideoId: videoId }, data: { currentVideoId: null, progress: null, status: WorkerStatus.ONLINE, lastError: input.qa.passed ? null : 'QA_FAILED' } });
      const response: WorkerCompletionResultDto = { videoId, attempt: context.attempt.attempt, videoStatus: nextStatus === VideoStatus.APPROVED ? 'APPROVED' : 'FAILED', renderStatus: 'SUCCEEDED', qaPassed: input.qa.passed };
      await tx.idempotencyKey.create({ data: { scope, key: idempotencyKey, result: auditJson({ requestHash, response }) } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    const retry = await existingIdempotency(prisma, scope, idempotencyKey, requestHash);
    if (retry) return retry as WorkerCompletionResultDto;
    throw error;
  }
}

export async function failJob(prisma: PrismaClient, workerId: string, videoId: string, leaseToken: string, idempotencyKey: string, input: FailInput): Promise<WorkerFailureResultDto> {
  const scope = completionScope(workerId, videoId, 'fail');
  const requestHash = payloadHash(input);
  const prior = await existingIdempotency(prisma, scope, idempotencyKey, requestHash);
  if (prior) return prior as WorkerFailureResultDto;
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const priorTx = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key: idempotencyKey } }, select: { result: true } });
      if (priorTx) {
        const envelope = idempotencyEnvelope(priorTx.result);
        if (!envelope || envelope.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
        return envelope.response as unknown as WorkerFailureResultDto;
      }
      const context = await requireLease(tx, workerId, videoId, leaseToken, now);
      const beforeVideo = await tx.video.findUniqueOrThrow({ where: { id: videoId }, select: { status: true } });
      await tx.renderAttempt.update({ where: { id: context.attempt.id }, data: { status: RenderAttemptStatus.FAILED, finishedAt: now, error: `${input.errorCode}: ${input.safeErrorMessage}`.slice(0, 1200) } });
      await tx.workerLease.update({ where: { id: context.lease.id }, data: { releasedAt: now } });
      await tx.video.update({ where: { id: videoId }, data: { status: VideoStatus.FAILED, version: { increment: 1 } } });
      await tx.jobEvent.create({ data: { videoId, type: 'RENDER_FAILED', fromStatus: beforeVideo.status, toStatus: VideoStatus.FAILED, workerId, payload: auditJson({ attempt: context.attempt.attempt, errorCode: input.errorCode }) } });
      await tx.worker.updateMany({ where: { id: workerId, currentVideoId: videoId }, data: { currentVideoId: null, progress: null, status: WorkerStatus.ONLINE, lastError: `${input.errorCode}: ${input.safeErrorMessage}`.slice(0, 1000) } });
      const response: WorkerFailureResultDto = { videoId, attempt: context.attempt.attempt, videoStatus: 'FAILED', renderStatus: 'FAILED' };
      await tx.idempotencyKey.create({ data: { scope, key: idempotencyKey, result: auditJson({ requestHash, response }) } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    const retry = await existingIdempotency(prisma, scope, idempotencyKey, requestHash);
    if (retry) return retry as WorkerFailureResultDto;
    throw error;
  }
}

async function assertRenderCanQueue(tx: Prisma.TransactionClient, videoId: string, now: Date): Promise<void> {
  const activeLease = await tx.workerLease.count({ where: { videoId, releasedAt: null, leaseExpiresAt: { gt: now } } });
  const activeAttempt = await tx.renderAttempt.count({ where: { videoId, status: { in: [RenderAttemptStatus.RUNNING, RenderAttemptStatus.QA] } } });
  if (activeLease > 0 || activeAttempt > 0) throw new ApiError(409, 'VIDEO_RENDER_ACTIVE', 'Video already has an active render or lease');
}

async function queueTransition(prisma: PrismaClient, videoId: string, expectedVersion: number, actorEmail: string, requestId: string, mode: 'queue' | 'rerender', auditWriter: WorkerAuditWriter): Promise<QueueRenderResultDto> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const before = await tx.video.findUnique({ where: { id: videoId }, select: { id: true, status: true, version: true } });
    if (!before) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
    if (before.version !== expectedVersion) throw new ApiError(409, 'VIDEO_VERSION_CONFLICT', 'Video changed since it was loaded');
    await assertRenderCanQueue(tx, videoId, now);
    if (mode === 'queue' && ![VideoStatus.DRAFT, VideoStatus.READY].includes(before.status)) throw new ApiError(409, 'VIDEO_NOT_QUEUEABLE', 'Video must be DRAFT or READY before initial render queueing');
    if (mode === 'rerender' && before.status === VideoStatus.PUBLISHED) throw new ApiError(409, 'VIDEO_ALREADY_PUBLISHED', 'Published videos cannot be re-rendered by default');
    if (mode === 'rerender' && ![VideoStatus.FAILED, VideoStatus.APPROVED].includes(before.status)) throw new ApiError(409, 'VIDEO_NOT_RERENDERABLE', 'Only FAILED or APPROVED videos can be re-rendered');
    const updated = await tx.video.updateMany({ where: { id: videoId, version: expectedVersion, status: before.status }, data: { status: VideoStatus.QUEUED, version: { increment: 1 } } });
    if (updated.count !== 1) throw new ApiError(409, 'VIDEO_VERSION_CONFLICT', 'Video changed since it was loaded');
    const after = await tx.video.findUniqueOrThrow({ where: { id: videoId }, select: { id: true, status: true, version: true } });
    const action = mode === 'queue' ? 'VIDEO_QUEUE_RENDER' : 'VIDEO_RERENDER';
    await tx.jobEvent.create({ data: { videoId, type: mode === 'queue' ? 'RENDER_QUEUED' : 'RERENDER_QUEUED', fromStatus: before.status, toStatus: VideoStatus.QUEUED } });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action, entityType: 'VIDEO', entityId: videoId, requestId, beforeData: auditJson(before), afterData: auditJson(after) });
    return { id: after.id, status: 'QUEUED', version: after.version };
  });
}

export function queueRender(prisma: PrismaClient, videoId: string, expectedVersion: number, actorEmail: string, requestId: string, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<QueueRenderResultDto> {
  return queueTransition(prisma, videoId, expectedVersion, actorEmail, requestId, 'queue', auditWriter);
}

export function rerenderVideo(prisma: PrismaClient, videoId: string, expectedVersion: number, actorEmail: string, requestId: string, auditWriter: WorkerAuditWriter = defaultAuditWriter): Promise<QueueRenderResultDto> {
  return queueTransition(prisma, videoId, expectedVersion, actorEmail, requestId, 'rerender', auditWriter);
}
