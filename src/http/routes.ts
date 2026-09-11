import { Router, type NextFunction, type Request, type Response } from 'express';
import { VideoStatus, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { isCriticalConfigReady } from '../config.js';
import { ApiError } from './errors.js';
import { getDashboard, getVideoDetail, listVideos, updateSceneWithAudit, updateVideoWithAudit } from './admin-service.js';
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

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
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

export function createAdminRouter(prisma: PrismaClient) {
  const router = Router();
  router.get('/dashboard', asyncRoute(async (_req, res) => res.json(await getDashboard(prisma))));
  router.get('/videos', asyncRoute(async (req, res) => {
    const query = parseRequest(paginationSchema, req.query);
    let status: VideoStatus | undefined;
    if (query.status) {
      if (!Object.values(VideoStatus).includes(query.status as VideoStatus)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status filter');
      status = query.status as VideoStatus;
    }
    res.json(await listVideos(prisma, { ...query, status }));
  }));
  router.get('/videos/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    res.json(await getVideoDetail(prisma, id));
  }));
  router.patch('/videos/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(videoPatchSchema, req.body);
    const { expectedVersion, ...changes } = body;
    const actor = req.actor;
    if (!actor) throw new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing');
    res.json(await updateVideoWithAudit(prisma, id, { expectedVersion, changes }, actor.email, req.requestId));
  }));
  router.patch('/videos/:id/scenes/:position', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const position = parseRequest(z.coerce.number().int().min(0).max(1000), req.params.position);
    const body = parseRequest(scenePatchSchema, req.body);
    const actor = req.actor;
    if (!actor) throw new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing');
    res.json(await updateSceneWithAudit(prisma, id, position, body, actor.email, req.requestId));
  }));
  return router;
}
