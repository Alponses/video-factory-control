import { Router, type NextFunction, type Request, type Response } from 'express';
import { VideoStatus, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { isCriticalConfigReady } from '../config.js';
import { ApiError } from './errors.js';
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
});
const failSchema = z.object({ errorCode: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_:-]+$/), safeErrorMessage: z.string().trim().min(1).max(1000) }).strict();
const idempotencySchema = z.string().trim().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/);

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

export function createAdminRouter(prisma: PrismaClient, config: AppConfig) {
  const router = Router();
  router.get('/me', (req, res, next) => {
    if (!req.actor) return next(new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing'));
    res.json({ email: req.actor.email });
  });
  router.get('/dashboard', asyncRoute(async (_req, res) => res.json(await getDashboard(prisma))));
  router.get('/workers', asyncRoute(async (_req, res) => res.json(await listWorkers(prisma, config.workerOfflineThresholdSeconds))));
  router.post('/workers', asyncRoute(async (req, res) => {
    const body = parseRequest(z.object({ workerId: workerIdSchema }).strict(), req.body);
    const actor = requireAdmin(req);
    res.status(201).json(await createWorker(prisma, body.workerId, actor.email, req.requestId, config.workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/rotate-secret', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await rotateWorkerSecret(prisma, workerId, actor.email, req.requestId, config.workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/revoke', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await revokeWorker(prisma, workerId, actor.email, req.requestId, config.workerOfflineThresholdSeconds));
  }));
  router.post('/workers/:workerId/enable', asyncRoute(async (req, res) => {
    const workerId = parseRequest(workerIdSchema, req.params.workerId);
    const actor = requireAdmin(req);
    res.json(await enableWorker(prisma, workerId, actor.email, req.requestId, config.workerOfflineThresholdSeconds));
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

export function createWorkerRouter(prisma: PrismaClient, config: AppConfig) {
  const router = Router();
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
    const job = await claimNextJob(prisma, worker.id, config.leaseDurationSeconds);
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
    res.json(await renewLease(prisma, worker.id, videoId, leaseHeader(req), config.leaseDurationSeconds));
  }));
  router.post('/jobs/:videoId/complete', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(completeSchema, req.body);
    res.json(await completeJob(prisma, worker.id, videoId, leaseHeader(req), idempotencyHeader(req), body));
  }));
  router.post('/jobs/:videoId/fail', asyncRoute(async (req, res) => {
    const worker = requireWorker(req);
    const videoId = parseRequest(idSchema, req.params.videoId);
    const body = parseRequest(failSchema, req.body);
    res.json(await failJob(prisma, worker.id, videoId, leaseHeader(req), idempotencyHeader(req), body));
  }));
  return router;
}
