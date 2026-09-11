import { Router, type NextFunction, type Request, type Response } from 'express';
import { AssetKind, VideoStatus, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { isCriticalConfigReady } from '../config.js';
import type { R2Storage } from '../storage/r2.js';
import { AUDIO_MAX_BYTES, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES } from '../storage/asset-policy.js';
import { ApiError } from './errors.js';
import {
  abortAdminUpload,
  abortWorkerUpload,
  assertWorkerOutputAsset,
  createAdminProfileUpload,
  createAdminVideoUpload,
  createDownloadUrl,
  createWorkerVideoUpload,
  finalizeAdminUpload,
  finalizeWorkerUpload,
  listChannelsWithAssets,
  listVideoAssets,
  presignAdminParts,
  presignWorkerParts,
} from './asset-service.js';
import {
  getDashboard,
  getVideoDetail,
  getVideoHistory,
  listVideos,
  updatePublicationWithAudit,
  updateSceneWithAudit,
  updateVideoWithAudit,
} from './admin-service.js';
import {
  WORKER_ID_PATTERN,
  claimNextJob,
  completeJob,
  createWorker,
  enableWorker,
  failJob,
  heartbeatWorker,
  listWorkers,
  queueRender,
  renewLease,
  reportProgress,
  rerenderVideo,
  revokeWorker,
  rotateWorkerSecret,
} from './worker-service.js';
import { idSchema, paginationSchema, parseRequest, positiveVersionSchema } from './validation.js';

const videoPatchSchema = z.object({
  expectedVersion: positiveVersionSchema,
  title: z.string().trim().min(1).max(500).optional(),
  category: z.string().trim().min(1).max(191).optional(),
  primaryKeyword: z.string().trim().max(500).nullable().optional(),
  searchIntent: z.string().trim().max(10000).nullable().optional(),
  hookText: z.string().trim().max(10000).nullable().optional(),
  hookType: z.string().trim().max(64).nullable().optional(),
  closing: z.string().trim().max(10000).nullable().optional(),
  cta: z.string().trim().max(10000).nullable().optional(),
  question: z.string().trim().max(10000).nullable().optional(),
  pinnedComment: z.string().trim().max(10000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'At least one editable field is required');

const scenePatchSchema = z.object({
  expectedVersion: positiveVersionSchema,
  text: z.string().min(1).max(20000).optional(),
  searchTerms: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
}).strict().refine((value) => value.text !== undefined || value.searchTerms !== undefined, 'At least one editable field is required');

const publicationPatchSchema = z.object({
  expectedVersion: positiveVersionSchema,
  title: z.string().trim().max(500).nullable().optional(),
  caption: z.string().trim().max(20000).nullable().optional(),
  description: z.string().trim().max(30000).nullable().optional(),
  hashtags: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  cta: z.string().trim().max(10000).nullable().optional(),
  pinnedComment: z.string().trim().max(10000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'At least one editable field is required');

const workerIdSchema = z.string().min(3).max(64).regex(WORKER_ID_PATTERN);
const queueSchema = z.object({ expectedVersion: positiveVersionSchema }).strict();
const heartbeatSchema = z.object({
  agentVersion: z.string().trim().min(1).max(64).nullable().optional(),
  rendererVersion: z.string().trim().min(1).max(64).nullable().optional(),
  currentVideoId: idSchema.nullable().optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  lastError: z.string().trim().max(1000).nullable().optional(),
}).strict();
const progressSchema = z.object({ progress: z.number().int().min(0).max(100), phase: z.enum(['RENDERING', 'QA']).default('RENDERING') }).strict();
const completeSchema = z.object({
  rendererVideoId: z.string().trim().min(1).max(255),
  localFile: z.string().trim().min(1).max(2048),
  outputAssetId: idSchema.optional(),
  durationSeconds: z.number().finite().nonnegative().max(86400),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  hasAudio: z.boolean(),
  qa: z.object({
    durationPassed: z.boolean(),
    resolutionPassed: z.boolean(),
    audioPassed: z.boolean(),
    captionsPassed: z.boolean().nullable(),
    passed: z.boolean(),
    raw: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const expected = value.qa.durationPassed && value.qa.resolutionPassed && value.qa.audioPassed && value.qa.captionsPassed !== false;
  if (value.qa.passed !== expected) ctx.addIssue({ code: 'custom', path: ['qa', 'passed'], message: 'QA passed value is inconsistent with individual checks' });
  if (value.qa.passed && !value.outputAssetId) ctx.addIssue({ code: 'custom', path: ['outputAssetId'], message: 'Durable outputAssetId is required when QA passes' });
});
const failSchema = z.object({ errorCode: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_:-]+$/), safeErrorMessage: z.string().trim().min(1).max(1000) }).strict();
const idempotencySchema = z.string().trim().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/);
const assetKindSchema = z.enum(['VIDEO', 'COVER', 'THUMBNAIL', 'AUDIO', 'AVATAR', 'BANNER']);
const byteSizeSchema = z.union([
  z.string().regex(/^[1-9][0-9]{0,19}$/),
  z.number().int().positive().safe(),
]).transform((value) => BigInt(value));
const assetUploadSchema = z.object({
  kind: assetKindSchema,
  mimeType: z.string().trim().min(1).max(191),
  size: byteSizeSchema,
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  originalFilename: z.string().trim().max(500).nullable().optional(),
}).strict();
const workerAssetUploadSchema = assetUploadSchema.omit({ kind: true });
const partsRequestSchema = z.object({ partNumbers: z.array(z.number().int()).min(1).max(100) }).strict();
const completedPartSchema = z.object({ partNumber: z.number().int().min(1).max(10000), eTag: z.string().trim().min(1).max(255) }).strict();
const finalizeUploadSchema = z.object({ parts: z.array(completedPartSchema).max(10000).default([]) }).strict();
const emptyBodySchema = z.object({}).strict();

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

function requireAdmin(req: Request) {
  if (!req.actor) throw new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing');
  return req.actor;
}

function requireWorker(req: Request) {
  if (!req.worker) throw new ApiError(401, 'WORKER_CONTEXT_MISSING', 'Worker context is missing');
  return req.worker;
}

function requireStorage(storage?: R2Storage): R2Storage {
  if (!storage) throw new ApiError(503, 'R2_NOT_CONFIGURED', 'Durable R2 storage is not configured');
  return storage;
}

function leaseHeader(req: Request): string {
  const value = req.get('x-worker-lease');
  if (!value || value.length > 255) throw new ApiError(401, 'LEASE_MISSING', 'Worker lease token is required');
  return value;
}

function idempotencyHeader(req: Request): string {
  const value = req.get('idempotency-key');
  if (!value) throw new ApiError(400, 'IDEMPOTENCY_KEY_MISSING', 'Idempotency-Key is required');
  return parseRequest(idempotencySchema, value);
}

export function createHealthRouter(prisma: PrismaClient, config: AppConfig) {
  const router = Router();
  router.get('/live', (_req, res) => res.json({ status: 'ok' }));
  router.get('/ready', asyncRoute(async (_req, res) => {
    if (!isCriticalConfigReady(config)) throw new ApiError(503, 'SERVICE_NOT_READY', 'Service is not ready');
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      throw new ApiError(503, 'SERVICE_NOT_READY', 'Service is not ready');
    }
  }));
  return router;
}

export function createAdminRouter(prisma: PrismaClient, config: AppConfig, storage?: R2Storage) {
  const router = Router();
  const workerOfflineThresholdSeconds = config.workerOfflineThresholdSeconds ?? 60;
  router.get('/me', (req, res, next) => {
    if (!req.actor) return next(new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing'));
    res.json({ email: req.actor.email });
  });
  router.get('/dashboard', asyncRoute(async (_req, res) => res.json(await getDashboard(prisma))));
  router.get('/channels', asyncRoute(async (_req, res) => res.json(await listChannelsWithAssets(prisma))));
  router.get('/assets/policy', asyncRoute(async (_req, res) => {
    const r2 = config.r2;
    if (!r2) throw new ApiError(503, 'R2_NOT_CONFIGURED', 'Durable R2 storage is not configured');
    res.json({
      presignTtlSeconds: r2.presignTtlSeconds,
      singleUploadThresholdBytes: String(r2.singleUploadThresholdBytes),
      multipartPartSizeBytes: r2.multipartPartSizeBytes,
      limits: { videoBytes: VIDEO_MAX_BYTES.toString(), imageBytes: IMAGE_MAX_BYTES.toString(), audioBytes: AUDIO_MAX_BYTES.toString() },
      mimeTypes: { VIDEO: ['video/mp4'], IMAGE: ['image/jpeg', 'image/png', 'image/webp'], AUDIO: ['audio/mpeg', 'audio/wav', 'audio/x-wav'] },
    });
  }));
  router.get('/workers', asyncRoute(async (_req, res) => res.json(await listWorkers(prisma, workerOfflineThresholdSeconds))));
  router.post('/workers', asyncRoute(async (req, res) => {
    const body = parseRequest(z.object({ workerId: workerIdSchema }).strict(), req.body);
    const actor = requireAdmin(req);
    res.status(201).json(await createWorker(prisma, body.workerId, actor.email, req.requestId, workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/rotate-secret', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await rotateWorkerSecret(prisma, workerId, actor.email, req.requestId, workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/revoke', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await revokeWorker(prisma, workerId, actor.email, req.requestId, workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/enable', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await enableWorker(prisma, workerId, actor.email, req.requestId, workerOfflineThresholdSeconds));
  }));
  router.get('/videos', asyncRoute(async (req, res) => {
    const query = parseRequest(paginationSchema, req.query);
    let status: VideoStatus | undefined;
    if (query.status) {
      if (!Object.values(VideoStatus).includes(query.status as VideoStatus)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status filter');
      status = query.status as VideoStatus;
    }
    res.json(await listVideos(prisma, { ...query, status }));
  }));
  router.get('/videos/:id/history', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    res.json(await getVideoHistory(prisma, id));
  }));
  router.get('/videos/:id/assets', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    res.json(await listVideoAssets(prisma, id));
  }));
  router.post('/videos/:id/assets/uploads', asyncRoute(async (req, res) => {
    const videoId = parseRequest(idSchema, req.params.id);
    const body = parseRequest(assetUploadSchema, req.body);
    const actor = requireAdmin(req);
    res.status(201).json(await createAdminVideoUpload(prisma, requireStorage(storage), config, videoId, actor.email, req.requestId, idempotencyHeader(req), { ...body, kind: body.kind as AssetKind }));
  }));
  router.post('/profiles/:profileId/assets/uploads', asyncRoute(async (req, res) => {
    const profileId = parseRequest(idSchema, req.params.profileId);
    const body = parseRequest(assetUploadSchema, req.body);
    const actor = requireAdmin(req);
    res.status(201).json(await createAdminProfileUpload(prisma, requireStorage(storage), config, profileId, actor.email, req.requestId, idempotencyHeader(req), { ...body, kind: body.kind as AssetKind }));
  }));
  router.post('/assets/uploads/:sessionId/parts', asyncRoute(async (req, res) => {
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    const body = parseRequest(partsRequestSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await presignAdminParts(prisma, requireStorage(storage), config, sessionId, actor.email, body.partNumbers));
  }));
  router.post('/assets/uploads/:sessionId/complete', asyncRoute(async (req, res) => {
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    const body = parseRequest(finalizeUploadSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await finalizeAdminUpload(prisma, requireStorage(storage), config, sessionId, actor.email, req.requestId, idempotencyHeader(req), body.parts));
  }));
  router.post('/assets/uploads/:sessionId/abort', asyncRoute(async (req, res) => {
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    parseRequest(emptyBodySchema, req.body);
    const actor = requireAdmin(req);
    res.json(await abortAdminUpload(prisma, requireStorage(storage), sessionId, actor.email, req.requestId));
  }));
  router.post('/assets/:assetId/download-url', asyncRoute(async (req, res) => {
    const assetId = parseRequest(idSchema, req.params.assetId);
    parseRequest(emptyBodySchema, req.body);
    requireAdmin(req);
    res.json(await createDownloadUrl(prisma, requireStorage(storage), config, assetId));
  }));
  router.get('/videos/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const detail = await getVideoDetail(prisma, id);
    res.json({ ...detail, legacyIncomplete: detail.video.legacyIncomplete });
  }));
  router.post('/videos/:id/queue-render', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(queueSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await queueRender(prisma, id, body.expectedVersion, actor.email, req.requestId));
  }));
  router.post('/videos/:id/rerender', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(queueSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await rerenderVideo(prisma, id, body.expectedVersion, actor.email, req.requestId));
  }));
  router.patch('/videos/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(videoPatchSchema, req.body);
    const { expectedVersion, ...changes } = body;
    const actor = requireAdmin(req);
    res.json(await updateVideoWithAudit(prisma, id, { expectedVersion, changes }, actor.email, req.requestId));
  }));
  router.patch('/videos/:id/scenes/:position', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const position = parseRequest(z.coerce.number().int().min(0).max(1000), req.params.position);
    const body = parseRequest(scenePatchSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await updateSceneWithAudit(prisma, id, position, body, actor.email, req.requestId));
  }));
  router.patch('/publications/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(publicationPatchSchema, req.body);
    const { expectedVersion, ...changes } = body;
    const actor = requireAdmin(req);
    res.json(await updatePublicationWithAudit(prisma, id, { expectedVersion, changes }, actor.email, req.requestId));
  }));
  return router;
}

export function createWorkerRouter(prisma: PrismaClient, config: AppConfig, storage?: R2Storage) {
  const router = Router();
  const leaseDurationSeconds = config.leaseDurationSeconds ?? 120;
  router.post('/heartbeat', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const body = parseRequest(heartbeatSchema, req.body);
    const heartbeat = {
      ...(body.agentVersion !== undefined ? { agentVersion: body.agentVersion } : {}),
      ...(body.rendererVersion !== undefined ? { rendererVersion: body.rendererVersion } : {}),
      ...(body.currentVideoId !== undefined ? { currentVideoId: body.currentVideoId } : {}),
      ...(body.progress !== undefined ? { progress: body.progress } : {}),
      ...(body.lastError !== undefined ? { lastError: body.lastError } : {}),
    };
    res.json(await heartbeatWorker(prisma, worker.id, heartbeat));
  }));
  router.post('/jobs/claim', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const job = await claimNextJob(prisma, worker.id, leaseDurationSeconds);
    if (!job) return void res.status(204).end();
    res.json(job);
  }));
  router.post('/jobs/:videoId/progress', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(progressSchema, req.body);
    res.json(await reportProgress(prisma, worker.id, videoId, leaseHeader(req), body.progress, body.phase));
  }));
  router.post('/jobs/:videoId/renew', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    res.json(await renewLease(prisma, worker.id, videoId, leaseHeader(req), leaseDurationSeconds));
  }));
  router.post('/jobs/:videoId/assets/uploads', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(workerAssetUploadSchema, req.body);
    res.status(201).json(await createWorkerVideoUpload(prisma, requireStorage(storage), config, worker.id, videoId, leaseHeader(req), idempotencyHeader(req), body));
  }));
  router.post('/assets/uploads/:sessionId/parts', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    const body = parseRequest(partsRequestSchema, req.body);
    res.json(await presignWorkerParts(prisma, requireStorage(storage), config, sessionId, worker.id, leaseHeader(req), body.partNumbers));
  }));
  router.post('/assets/uploads/:sessionId/complete', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    const body = parseRequest(finalizeUploadSchema, req.body);
    res.json(await finalizeWorkerUpload(prisma, requireStorage(storage), config, sessionId, worker.id, leaseHeader(req), idempotencyHeader(req), body.parts));
  }));
  router.post('/assets/uploads/:sessionId/abort', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const sessionId = parseRequest(idSchema, req.params.sessionId);
    parseRequest(emptyBodySchema, req.body);
    res.json(await abortWorkerUpload(prisma, requireStorage(storage), sessionId, worker.id, leaseHeader(req)));
  }));
  router.post('/jobs/:videoId/complete', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(completeSchema, req.body);
    const leaseToken = leaseHeader(req);
    if (body.qa.passed) await assertWorkerOutputAsset(prisma, requireStorage(storage), worker.id, videoId, leaseToken, body.outputAssetId!);
    res.json(await completeJob(prisma, worker.id, videoId, leaseToken, idempotencyHeader(req), body, { requireDurableOutput: body.qa.passed }));
  }));
  router.post('/jobs/:videoId/fail', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(failSchema, req.body);
    res.json(await failJob(prisma, worker.id, videoId, leaseHeader(req), idempotencyHeader(req), body));
  }));
  return router;
}
