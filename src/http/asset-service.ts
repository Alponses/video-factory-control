import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ActorType,
  AssetKind,
  AssetStatus,
  AssetUploadMode,
  AssetUploadStatus,
  Prisma,
  PrismaClient,
  RenderAttemptStatus,
} from '@prisma/client';
import type { AppConfig, R2Config } from '../config.js';
import type {
  AssetDto,
  ChannelAssetsDto,
  DownloadUrlDto,
  MultipartPartsDto,
  UploadSessionDto,
} from '../contracts/admin.js';
import {
  MAX_PART_PRESIGNS_PER_REQUEST,
  expectedPartCount,
  normalizeMime,
  profileObjectKey,
  safeOriginalFilename,
  validateAssetInput,
  videoObjectKey,
} from '../storage/asset-policy.js';
import type { R2CompletedPart, R2Storage } from '../storage/r2.js';
import { ApiError } from './errors.js';

const LEASE_SECRET_DOMAIN = 'video-factory-worker-lease:v1:';
const SESSION_TTL_MS = 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

type DbReader = PrismaClient | Prisma.TransactionClient;

type Owner =
  | { type: 'video'; id: string; channelId: string; platform: null }
  | { type: 'profile'; id: string; channelId: string; platform: 'TIKTOK' | 'YOUTUBE' | 'FACEBOOK' };

type UploadActor =
  | { type: 'admin'; id: string; requestId: string }
  | { type: 'worker'; id: string; videoId: string; leaseToken: string; renderAttemptId: string };

export interface AssetUploadInput {
  kind: AssetKind;
  mimeType: string;
  size: bigint;
  sha256?: string | null;
  originalFilename?: string | null;
}

function r2Config(config: AppConfig): R2Config {
  if (!config.r2) throw new ApiError(503, 'R2_NOT_CONFIGURED', 'Durable R2 storage is not configured');
  return config.r2;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as Prisma.InputJsonValue;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function leaseHash(token: string): string {
  return createHash('sha256').update(LEASE_SECRET_DOMAIN).update(token).digest('hex');
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function currentWorkerAttempt(db: DbReader, workerId: string, videoId: string, leaseToken: string) {
  const rows = await db.$queryRaw<Array<{ id: string; workerId: string; leaseTokenHash: string; leaseExpiresAt: Date }>>(Prisma.sql`
    SELECT id, workerId, leaseTokenHash, leaseExpiresAt
    FROM worker_leases
    WHERE videoId = ${videoId} AND releasedAt IS NULL
    ORDER BY claimedAt DESC
    LIMIT 1
  `);
  const lease = rows[0];
  if (!lease) throw new ApiError(409, 'LEASE_INVALID', 'No active lease exists for this video');
  if (lease.workerId !== workerId) throw new ApiError(403, 'LEASE_NOT_OWNER', 'Lease belongs to another worker');
  if (!safeDigestEqual(lease.leaseTokenHash, leaseHash(leaseToken))) throw new ApiError(403, 'LEASE_INVALID', 'Lease token is invalid');
  if (new Date(lease.leaseExpiresAt).getTime() <= Date.now()) throw new ApiError(409, 'LEASE_EXPIRED', 'Lease has expired');
  const attempt = await db.renderAttempt.findFirst({
    where: { videoId },
    orderBy: { attempt: 'desc' },
    select: { id: true, attempt: true, workerId: true, status: true },
  });
  if (!attempt || attempt.workerId !== workerId || ![RenderAttemptStatus.RUNNING, RenderAttemptStatus.QA].includes(attempt.status)) {
    throw new ApiError(409, 'LEASE_STALE', 'Lease no longer owns the current render attempt');
  }
  return attempt;
}

async function videoOwner(prisma: PrismaClient, videoId: string): Promise<Owner> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, channelId: true } });
  if (!video) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
  return { type: 'video', id: video.id, channelId: video.channelId, platform: null };
}

async function profileOwner(prisma: PrismaClient, profileId: string): Promise<Owner> {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { id: true, channelId: true, platform: true } });
  if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profile was not found');
  return { type: 'profile', id: profile.id, channelId: profile.channelId, platform: profile.platform };
}

function assertOwnerKind(owner: Owner, kind: AssetKind): void {
  const valid = owner.type === 'video'
    ? [AssetKind.VIDEO, AssetKind.COVER, AssetKind.THUMBNAIL, AssetKind.AUDIO].includes(kind)
    : [AssetKind.AVATAR, AssetKind.BANNER].includes(kind);
  if (!valid) throw new ApiError(400, 'ASSET_INVALID_TYPE', 'Asset kind is not valid for this owner');
}

function assetDto(asset: {
  id: string; videoId: string | null; profileId: string | null; kind: AssetKind; status: AssetStatus; platform: string | null;
  storageProvider: string; mimeType: string | null; size: bigint | null; sha256: string | null; metadata: unknown; createdAt: Date; updatedAt: Date;
}): AssetDto {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) ? asset.metadata as Record<string, unknown> : null;
  return {
    id: asset.id,
    videoId: asset.videoId,
    profileId: asset.profileId,
    kind: asset.kind,
    status: asset.status,
    platform: asset.platform as AssetDto['platform'],
    storageProvider: asset.storageProvider,
    mimeType: asset.mimeType,
    size: asset.size?.toString() ?? null,
    sha256: asset.sha256,
    source: typeof metadata?.source === 'string' ? metadata.source : null,
    hashSource: typeof metadata?.hashSource === 'string' ? metadata.hashSource : null,
    originalFilename: typeof metadata?.originalFilename === 'string' ? metadata.originalFilename : null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

async function existingLogicalCreate(prisma: PrismaClient, scope: string, key: string, hash: string): Promise<{ assetId: string; sessionId: string } | null> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } }, select: { result: true } });
  if (!existing?.result || typeof existing.result !== 'object' || Array.isArray(existing.result)) return null;
  const result = existing.result as Record<string, unknown>;
  if (result.requestHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different upload request');
  if (typeof result.assetId !== 'string' || typeof result.sessionId !== 'string') throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Stored idempotency result is invalid');
  return { assetId: result.assetId, sessionId: result.sessionId };
}

function createScope(actor: UploadActor, owner: Owner, kind: AssetKind): string {
  return `asset-create:${actor.type}:${actor.id}:${owner.type}:${owner.id}:${kind}`.slice(0, 191);
}

async function ensureUploadReady(prisma: PrismaClient, storage: R2Storage, sessionId: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM asset_upload_sessions WHERE id = ${sessionId} FOR UPDATE`);
    if (!locked[0]) throw new ApiError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session was not found');
    const session = await tx.assetUploadSession.findUniqueOrThrow({ where: { id: sessionId }, include: { asset: true } });
    if (session.status === AssetUploadStatus.ABORTED || session.status === AssetUploadStatus.FAILED || session.status === AssetUploadStatus.EXPIRED) {
      throw new ApiError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session is no longer active');
    }
    if (session.expiresAt.getTime() <= Date.now() && session.status !== AssetUploadStatus.COMPLETED) {
      await tx.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.EXPIRED, failedAt: new Date() } });
      await tx.videoAsset.updateMany({ where: { id: session.assetId, status: AssetStatus.PENDING }, data: { status: AssetStatus.FAILED } });
      throw new ApiError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
    }
    if (session.status === AssetUploadStatus.COMPLETED) return session;
    if (session.mode === AssetUploadMode.MULTIPART && !session.r2UploadId) {
      let uploadId: string;
      try {
        uploadId = await storage.createMultipart(session.asset.objectKey!, session.expectedMimeType);
      } catch {
        throw new ApiError(502, 'R2_UPLOAD_FAILED', 'R2 multipart upload could not be created');
      }
      return tx.assetUploadSession.update({ where: { id: session.id }, data: { r2UploadId: uploadId, status: AssetUploadStatus.UPLOADING }, include: { asset: true } });
    }
    if (session.status === AssetUploadStatus.CREATED) {
      return tx.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.UPLOADING }, include: { asset: true } });
    }
    return session;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function uploadResponse(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string): Promise<UploadSessionDto> {
  const r2 = r2Config(config);
  const session = await ensureUploadReady(prisma, storage, sessionId);
  const expiresAt = new Date(Date.now() + r2.presignTtlSeconds * 1000).toISOString();
  const common = {
    sessionId: session.id,
    assetId: session.assetId,
    mode: session.mode,
    status: session.status,
    requiredHeaders: { 'Content-Type': session.expectedMimeType },
    expiresAt,
    sessionExpiresAt: session.expiresAt.toISOString(),
    partSizeBytes: session.mode === AssetUploadMode.MULTIPART ? r2.multipartPartSizeBytes : null,
  } as const;
  if (session.status === AssetUploadStatus.COMPLETED) return { ...common, uploadUrl: null };
  if (session.mode === AssetUploadMode.SINGLE) {
    const uploadUrl = await storage.presignPut(session.asset.objectKey!, session.expectedMimeType, r2.presignTtlSeconds);
    return { ...common, uploadUrl };
  }
  return { ...common, uploadUrl: null };
}

async function createUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, owner: Owner, actor: UploadActor, key: string, input: AssetUploadInput): Promise<UploadSessionDto> {
  assertOwnerKind(owner, input.kind);
  const r2 = r2Config(config);
  const validated = validateAssetInput(input.kind, input.mimeType, input.size);
  const sha256 = input.sha256?.toLowerCase() ?? null;
  if (sha256 && !SHA256_PATTERN.test(sha256)) throw new ApiError(400, 'VALIDATION_ERROR', 'SHA-256 must be a 64 character hex digest');
  const normalizedFilename = safeOriginalFilename(input.originalFilename);
  const mode = input.size <= BigInt(r2.singleUploadThresholdBytes) ? AssetUploadMode.SINGLE : AssetUploadMode.MULTIPART;
  if (mode === AssetUploadMode.MULTIPART) expectedPartCount(input.size, r2.multipartPartSizeBytes);
  const hash = requestHash({ owner: { type: owner.type, id: owner.id }, kind: input.kind, mimeType: validated.mimeType, size: input.size.toString(), sha256, originalFilename: normalizedFilename });
  const scope = createScope(actor, owner, input.kind);
  const prior = await existingLogicalCreate(prisma, scope, key, hash);
  if (prior) return uploadResponse(prisma, storage, config, prior.sessionId);

  const assetId = randomUUID();
  const sessionId = randomUUID();
  const objectKey = owner.type === 'video'
    ? videoObjectKey(owner.channelId, owner.id, assetId, input.kind, validated.mimeType)
    : profileObjectKey(owner.channelId, owner.id, assetId, input.kind, validated.mimeType);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const metadata = {
    source: actor.type === 'worker' ? 'WORKER' : 'ADMIN',
    hashSource: sha256 ? (actor.type === 'worker' ? 'WORKER' : 'BROWSER_ASSERTED') : null,
    originalFilename: normalizedFilename,
  };

  try {
    await prisma.$transaction(async (tx) => {
      const priorTx = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      if (priorTx) throw new ApiError(409, 'IDEMPOTENCY_RACE', 'Concurrent idempotent upload creation is resolving');
      await tx.videoAsset.create({ data: {
        id: assetId,
        videoId: owner.type === 'video' ? owner.id : null,
        profileId: owner.type === 'profile' ? owner.id : null,
        kind: input.kind,
        status: AssetStatus.PENDING,
        platform: owner.platform,
        storageProvider: 'R2',
        bucket: r2.bucket,
        objectKey,
        localPath: null,
        mimeType: validated.mimeType,
        size: null,
        sha256: null,
        metadata: json(metadata),
      } });
      await tx.assetUploadSession.create({ data: {
        id: sessionId,
        assetId,
        actorType: actor.type === 'worker' ? ActorType.WORKER : ActorType.ADMIN,
        actor: actor.id,
        workerId: actor.type === 'worker' ? actor.id : null,
        renderAttemptId: actor.type === 'worker' ? actor.renderAttemptId : null,
        mode,
        status: AssetUploadStatus.CREATED,
        expectedMimeType: validated.mimeType,
        expectedSize: input.size,
        expectedSha256: sha256,
        expiresAt,
        metadata: json({ originalFilename: normalizedFilename }),
      } });
      await tx.idempotencyKey.create({ data: { scope, key, result: json({ requestHash: hash, assetId, sessionId }) } });
      if (actor.type === 'admin') {
        await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'ASSET_UPLOAD_CREATED', entityType: 'VIDEO_ASSET', entityId: assetId, requestId: actor.requestId, afterData: json({ assetId, ownerType: owner.type, ownerId: owner.id, kind: input.kind, mode, storageProvider: 'R2', size: input.size.toString() }) } });
      } else if (owner.type === 'video') {
        await tx.jobEvent.create({ data: { videoId: owner.id, type: 'R2_UPLOAD_STARTED', workerId: actor.id, payload: json({ assetId, attemptId: actor.renderAttemptId, mode, size: input.size.toString() }) } });
      }
    });
  } catch (error) {
    const retry = await existingLogicalCreate(prisma, scope, key, hash);
    if (retry) return uploadResponse(prisma, storage, config, retry.sessionId);
    throw error;
  }
  return uploadResponse(prisma, storage, config, sessionId);
}

export async function createAdminVideoUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, videoId: string, actorEmail: string, requestId: string, key: string, input: AssetUploadInput): Promise<UploadSessionDto> {
  return createUpload(prisma, storage, config, await videoOwner(prisma, videoId), { type: 'admin', id: actorEmail, requestId }, key, input);
}

export async function createAdminProfileUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, profileId: string, actorEmail: string, requestId: string, key: string, input: AssetUploadInput): Promise<UploadSessionDto> {
  return createUpload(prisma, storage, config, await profileOwner(prisma, profileId), { type: 'admin', id: actorEmail, requestId }, key, input);
}

export async function createWorkerVideoUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, workerId: string, videoId: string, leaseToken: string, key: string, input: Omit<AssetUploadInput, 'kind'>): Promise<UploadSessionDto> {
  const attempt = await currentWorkerAttempt(prisma, workerId, videoId, leaseToken);
  return createUpload(prisma, storage, config, await videoOwner(prisma, videoId), { type: 'worker', id: workerId, videoId, leaseToken, renderAttemptId: attempt.id }, key, { ...input, kind: AssetKind.VIDEO });
}

async function sessionForActor(prisma: PrismaClient, sessionId: string, actor: { type: 'admin'; id: string } | { type: 'worker'; id: string; leaseToken: string }) {
  const session = await prisma.assetUploadSession.findUnique({ where: { id: sessionId }, include: { asset: true } });
  if (!session) throw new ApiError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session was not found');
  if (actor.type === 'admin') {
    if (session.actorType !== ActorType.ADMIN || session.actor !== actor.id) throw new ApiError(403, 'UPLOAD_NOT_OWNER', 'Upload session belongs to another actor');
  } else {
    if (session.actorType !== ActorType.WORKER || session.workerId !== actor.id || !session.asset.videoId) throw new ApiError(403, 'UPLOAD_NOT_OWNER', 'Upload session belongs to another worker');
    const attempt = await currentWorkerAttempt(prisma, actor.id, session.asset.videoId, actor.leaseToken);
    if (session.renderAttemptId !== attempt.id) throw new ApiError(409, 'LEASE_STALE', 'Upload session belongs to a stale render attempt');
  }
  if (session.status !== AssetUploadStatus.COMPLETED && session.expiresAt.getTime() <= Date.now()) {
    await prisma.$transaction([
      prisma.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.EXPIRED, failedAt: new Date() } }),
      prisma.videoAsset.updateMany({ where: { id: session.assetId, status: AssetStatus.PENDING }, data: { status: AssetStatus.FAILED } }),
    ]);
    throw new ApiError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
  }
  return session;
}

async function presignParts(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, partNumbers: number[], actor: { type: 'admin'; id: string } | { type: 'worker'; id: string; leaseToken: string }): Promise<MultipartPartsDto> {
  const session = await sessionForActor(prisma, sessionId, actor);
  if (session.mode !== AssetUploadMode.MULTIPART || !session.r2UploadId) throw new ApiError(409, 'MULTIPART_INVALID_PART', 'Upload session is not an active multipart upload');
  if (![AssetUploadStatus.UPLOADING, AssetUploadStatus.CREATED].includes(session.status)) throw new ApiError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session cannot accept more parts');
  if (partNumbers.length < 1 || partNumbers.length > MAX_PART_PRESIGNS_PER_REQUEST) throw new ApiError(400, 'MULTIPART_INVALID_PART', 'Invalid number of multipart presign requests');
  const expected = expectedPartCount(session.expectedSize, r2Config(config).multipartPartSizeBytes);
  const unique = [...new Set(partNumbers)];
  if (unique.length !== partNumbers.length || unique.some((part) => !Number.isInteger(part) || part < 1 || part > expected)) throw new ApiError(400, 'MULTIPART_INVALID_PART', 'Invalid multipart part number');
  const r2 = r2Config(config);
  const expiresAt = new Date(Date.now() + r2.presignTtlSeconds * 1000).toISOString();
  const parts = await Promise.all(unique.map(async (partNumber) => ({ partNumber, uploadUrl: await storage.presignPart(session.asset.objectKey!, session.r2UploadId!, partNumber, r2.presignTtlSeconds), expiresAt })));
  return { sessionId, partSizeBytes: r2.multipartPartSizeBytes, parts };
}

export function presignAdminParts(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, actorEmail: string, partNumbers: number[]): Promise<MultipartPartsDto> {
  return presignParts(prisma, storage, config, sessionId, partNumbers, { type: 'admin', id: actorEmail });
}

export function presignWorkerParts(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, workerId: string, leaseToken: string, partNumbers: number[]): Promise<MultipartPartsDto> {
  return presignParts(prisma, storage, config, sessionId, partNumbers, { type: 'worker', id: workerId, leaseToken });
}

function finalizeScope(sessionId: string): string {
  return `asset-finalize:${sessionId}`;
}

async function priorFinalize(prisma: PrismaClient, sessionId: string, key: string, hash: string): Promise<AssetDto | null> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope: finalizeScope(sessionId), key } }, select: { result: true } });
  if (!existing?.result || typeof existing.result !== 'object' || Array.isArray(existing.result)) return null;
  const result = existing.result as Record<string, unknown>;
  if (result.requestHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different multipart completion data');
  const assetId = typeof result.assetId === 'string' ? result.assetId : null;
  if (!assetId) return null;
  const asset = await prisma.videoAsset.findUnique({ where: { id: assetId } });
  return asset ? assetDto(asset) : null;
}

async function markFinalizeFailure(prisma: PrismaClient, sessionId: string, errorCode: string): Promise<void> {
  const session = await prisma.assetUploadSession.findUnique({ where: { id: sessionId }, include: { asset: true } });
  if (!session || session.status === AssetUploadStatus.COMPLETED) return;
  await prisma.$transaction(async (tx) => {
    await tx.assetUploadSession.update({ where: { id: sessionId }, data: { status: AssetUploadStatus.FAILED, failedAt: new Date() } });
    await tx.videoAsset.updateMany({ where: { id: session.assetId, status: AssetStatus.PENDING }, data: { status: AssetStatus.FAILED } });
    if (session.actorType === ActorType.WORKER && session.workerId && session.asset.videoId) {
      await tx.jobEvent.create({ data: { videoId: session.asset.videoId, type: 'R2_UPLOAD_FAILED', workerId: session.workerId, payload: json({ assetId: session.assetId, errorCode }) } });
    }
  });
}

async function finalizeUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, key: string, parts: R2CompletedPart[], actor: { type: 'admin'; id: string; requestId: string } | { type: 'worker'; id: string; leaseToken: string }): Promise<AssetDto> {
  const hash = requestHash({ parts: parts.map((part) => ({ partNumber: part.partNumber, eTag: part.eTag })) });
  const prior = await priorFinalize(prisma, sessionId, key, hash);
  if (prior) return prior;
  let session = await sessionForActor(prisma, sessionId, actor.type === 'admin' ? { type: 'admin', id: actor.id } : { type: 'worker', id: actor.id, leaseToken: actor.leaseToken });
  if (session.status === AssetUploadStatus.COMPLETED) return assetDto(session.asset);
  if (session.status === AssetUploadStatus.ABORTED || session.status === AssetUploadStatus.FAILED || session.status === AssetUploadStatus.EXPIRED) throw new ApiError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session cannot be finalized');

  if (session.mode === AssetUploadMode.MULTIPART) {
    if (!session.r2UploadId) throw new ApiError(409, 'MULTIPART_INVALID_PART', 'Multipart upload is not initialized');
    const expected = expectedPartCount(session.expectedSize, r2Config(config).multipartPartSizeBytes);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (sorted.length !== expected || sorted.some((part, index) => part.partNumber !== index + 1 || !part.eTag || part.eTag.length > 255)) throw new ApiError(400, 'MULTIPART_INVALID_PART', 'Multipart completion list is incomplete or invalid');
    await prisma.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.FINALIZING } });
    try {
      await storage.completeMultipart(session.asset.objectKey!, session.r2UploadId, sorted);
    } catch {
      try { await storage.headObject(session.asset.objectKey!); } catch {
        await markFinalizeFailure(prisma, sessionId, 'R2_FINALIZE_FAILED');
        throw new ApiError(502, 'R2_FINALIZE_FAILED', 'R2 multipart upload could not be completed');
      }
    }
  } else if (parts.length > 0) {
    throw new ApiError(400, 'MULTIPART_INVALID_PART', 'Single uploads do not accept multipart ETags');
  }

  let head;
  try {
    head = await storage.headObject(session.asset.objectKey!);
  } catch {
    await markFinalizeFailure(prisma, sessionId, 'R2_OBJECT_MISSING');
    throw new ApiError(502, 'R2_OBJECT_MISSING', 'Uploaded R2 object could not be found');
  }
  if (head.size !== session.expectedSize) {
    await markFinalizeFailure(prisma, sessionId, 'R2_OBJECT_SIZE_MISMATCH');
    throw new ApiError(409, 'R2_OBJECT_SIZE_MISMATCH', 'Uploaded object size does not match the expected size');
  }
  if (normalizeMime(head.contentType ?? '') !== normalizeMime(session.expectedMimeType)) {
    await markFinalizeFailure(prisma, sessionId, 'R2_OBJECT_TYPE_MISMATCH');
    throw new ApiError(409, 'R2_OBJECT_TYPE_MISMATCH', 'Uploaded object MIME type does not match the signed MIME type');
  }

  const now = new Date();
  try {
    const result = await prisma.$transaction(async (tx) => {
      session = await tx.assetUploadSession.findUniqueOrThrow({ where: { id: sessionId }, include: { asset: true } });
      if (session.status === AssetUploadStatus.COMPLETED) return assetDto(session.asset);
      if (session.asset.videoId) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM videos WHERE id = ${session.asset.videoId} FOR UPDATE`);
      } else if (session.asset.profileId) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM profiles WHERE id = ${session.asset.profileId} FOR UPDATE`);
      } else {
        throw new ApiError(409, 'ASSET_REPLACEMENT_CONFLICT', 'Asset has no valid owner');
      }
      const slotWhere: Prisma.VideoAssetWhereInput = session.asset.videoId
        ? { videoId: session.asset.videoId, kind: session.asset.kind, platform: session.asset.platform, status: AssetStatus.READY, id: { not: session.asset.id } }
        : { profileId: session.asset.profileId, kind: session.asset.kind, status: AssetStatus.READY, id: { not: session.asset.id } };
      const previous = await tx.videoAsset.findMany({ where: slotWhere, select: { id: true } });
      if (previous.length) await tx.videoAsset.updateMany({ where: { id: { in: previous.map((item) => item.id) } }, data: { status: AssetStatus.REPLACED } });
      const current = await tx.videoAsset.update({ where: { id: session.asset.id }, data: { status: AssetStatus.READY, mimeType: session.expectedMimeType, size: head.size, sha256: session.expectedSha256 }, });
      await tx.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.COMPLETED, completedAt: now } });
      if (actor.type === 'admin') {
        await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'ASSET_UPLOAD_COMPLETED', entityType: 'VIDEO_ASSET', entityId: current.id, requestId: actor.requestId, afterData: json({ status: current.status, kind: current.kind, storageProvider: current.storageProvider, size: current.size?.toString() ?? null }) } });
        if (previous.length) await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'ASSET_REPLACED', entityType: 'VIDEO_ASSET', entityId: current.id, requestId: actor.requestId, metadata: json({ replacedAssetIds: previous.map((item) => item.id) }) } });
        if (current.profileId && current.kind === AssetKind.AVATAR) await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'PROFILE_AVATAR_CHANGED', entityType: 'PROFILE', entityId: current.profileId, requestId: actor.requestId, metadata: json({ assetId: current.id }) } });
        if (current.profileId && current.kind === AssetKind.BANNER) await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'PROFILE_BANNER_CHANGED', entityType: 'PROFILE', entityId: current.profileId, requestId: actor.requestId, metadata: json({ assetId: current.id }) } });
      } else if (current.videoId) {
        await tx.jobEvent.create({ data: { videoId: current.videoId, type: 'R2_UPLOAD_COMPLETED', workerId: actor.id, payload: json({ assetId: current.id, renderAttemptId: session.renderAttemptId, size: head.size.toString() }) } });
      }
      await tx.idempotencyKey.create({ data: { scope: finalizeScope(session.id), key, result: json({ requestHash: hash, assetId: current.id }) } });
      return assetDto(current);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return result;
  } catch (error) {
    const retry = await priorFinalize(prisma, sessionId, key, hash);
    if (retry) return retry;
    throw error;
  }
}

export function finalizeAdminUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, actorEmail: string, requestId: string, key: string, parts: R2CompletedPart[]): Promise<AssetDto> {
  return finalizeUpload(prisma, storage, config, sessionId, key, parts, { type: 'admin', id: actorEmail, requestId });
}

export function finalizeWorkerUpload(prisma: PrismaClient, storage: R2Storage, config: AppConfig, sessionId: string, workerId: string, leaseToken: string, key: string, parts: R2CompletedPart[]): Promise<AssetDto> {
  return finalizeUpload(prisma, storage, config, sessionId, key, parts, { type: 'worker', id: workerId, leaseToken });
}

async function abortUpload(prisma: PrismaClient, storage: R2Storage, sessionId: string, actor: { type: 'admin'; id: string; requestId: string } | { type: 'worker'; id: string; leaseToken: string }): Promise<{ sessionId: string; status: 'ABORTED' }> {
  const session = await sessionForActor(prisma, sessionId, actor.type === 'admin' ? { type: 'admin', id: actor.id } : { type: 'worker', id: actor.id, leaseToken: actor.leaseToken });
  if (session.status === AssetUploadStatus.ABORTED) return { sessionId, status: 'ABORTED' };
  if (session.status === AssetUploadStatus.COMPLETED) throw new ApiError(409, 'UPLOAD_ALREADY_COMPLETED', 'Completed upload cannot be aborted');
  if (session.mode === AssetUploadMode.MULTIPART && session.r2UploadId) {
    try { await storage.abortMultipart(session.asset.objectKey!, session.r2UploadId); } catch { throw new ApiError(502, 'R2_UPLOAD_FAILED', 'R2 multipart upload could not be aborted'); }
  }
  await prisma.$transaction(async (tx) => {
    await tx.assetUploadSession.update({ where: { id: session.id }, data: { status: AssetUploadStatus.ABORTED, failedAt: new Date() } });
    await tx.videoAsset.updateMany({ where: { id: session.assetId, status: AssetStatus.PENDING }, data: { status: AssetStatus.FAILED } });
    if (actor.type === 'admin') {
      await tx.auditLog.create({ data: { actorType: ActorType.ADMIN, actor: actor.id, action: 'ASSET_UPLOAD_ABORTED', entityType: 'VIDEO_ASSET', entityId: session.assetId, requestId: actor.requestId, metadata: json({ sessionId: session.id }) } });
    } else if (session.asset.videoId) {
      await tx.jobEvent.create({ data: { videoId: session.asset.videoId, type: 'R2_UPLOAD_FAILED', workerId: actor.id, payload: json({ assetId: session.assetId, errorCode: 'UPLOAD_ABORTED' }) } });
    }
  });
  return { sessionId, status: 'ABORTED' };
}

export function abortAdminUpload(prisma: PrismaClient, storage: R2Storage, sessionId: string, actorEmail: string, requestId: string) {
  return abortUpload(prisma, storage, sessionId, { type: 'admin', id: actorEmail, requestId });
}

export function abortWorkerUpload(prisma: PrismaClient, storage: R2Storage, sessionId: string, workerId: string, leaseToken: string) {
  return abortUpload(prisma, storage, sessionId, { type: 'worker', id: workerId, leaseToken });
}

export async function listVideoAssets(prisma: PrismaClient, videoId: string): Promise<{ items: AssetDto[] }> {
  if (!await prisma.video.count({ where: { id: videoId } })) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
  const assets = await prisma.videoAsset.findMany({ where: { videoId }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }] });
  return { items: assets.map(assetDto) };
}

export async function listChannelsWithAssets(prisma: PrismaClient): Promise<ChannelAssetsDto> {
  const channels = await prisma.channel.findMany({
    orderBy: { id: 'asc' },
    include: { profiles: { orderBy: { platform: 'asc' }, include: { assets: { where: { kind: { in: [AssetKind.AVATAR, AssetKind.BANNER] } }, orderBy: { createdAt: 'desc' } } } } },
  });
  return { items: channels.map((channel) => ({
    id: channel.id,
    displayName: channel.displayName,
    language: channel.language,
    profiles: channel.profiles.map((profile) => ({
      id: profile.id,
      platform: profile.platform,
      displayName: profile.displayName,
      username: profile.username,
      assets: profile.assets.map(assetDto),
    })),
  })) };
}

export async function createDownloadUrl(prisma: PrismaClient, storage: R2Storage, config: AppConfig, assetId: string): Promise<DownloadUrlDto> {
  const asset = await prisma.videoAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset was not found');
  if (![AssetStatus.READY, AssetStatus.REPLACED].includes(asset.status)) throw new ApiError(409, 'ASSET_NOT_READY', 'Only ready or replaced assets can be downloaded');
  if (asset.storageProvider !== 'R2' || !asset.objectKey || asset.bucket !== storage.bucket) throw new ApiError(409, 'ASSET_NOT_DURABLE', 'Asset is not stored in configured R2 storage');
  const ttl = Math.min(r2Config(config).presignTtlSeconds, 300);
  const downloadUrl = await storage.presignGet(asset.objectKey, ttl);
  return { assetId, downloadUrl, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

export async function assertWorkerOutputAsset(prisma: PrismaClient, storage: R2Storage, workerId: string, videoId: string, leaseToken: string, assetId: string): Promise<void> {
  const attempt = await currentWorkerAttempt(prisma, workerId, videoId, leaseToken);
  const asset = await prisma.videoAsset.findUnique({
    where: { id: assetId },
    include: { uploadSessions: { where: { status: AssetUploadStatus.COMPLETED }, orderBy: { completedAt: 'desc' }, take: 1 } },
  });
  const session = asset?.uploadSessions[0];
  if (!asset || asset.videoId !== videoId || asset.kind !== AssetKind.VIDEO || asset.status !== AssetStatus.READY || asset.storageProvider !== 'R2' || !asset.objectKey || !asset.size || !asset.mimeType) {
    throw new ApiError(409, 'OUTPUT_ASSET_NOT_READY', 'Worker output asset is not a durable READY R2 video');
  }
  if (!session || session.workerId !== workerId || session.renderAttemptId !== attempt.id) throw new ApiError(409, 'OUTPUT_ASSET_NOT_READY', 'Worker output asset does not belong to the current render attempt');
  let head;
  try { head = await storage.headObject(asset.objectKey); } catch { throw new ApiError(502, 'R2_OBJECT_MISSING', 'Durable worker output is missing from R2'); }
  if (head.size !== asset.size) throw new ApiError(409, 'R2_OBJECT_SIZE_MISMATCH', 'Durable worker output size changed after finalization');
  if (normalizeMime(head.contentType ?? '') !== normalizeMime(asset.mimeType)) throw new ApiError(409, 'R2_OBJECT_TYPE_MISMATCH', 'Durable worker output MIME type changed after finalization');
}
