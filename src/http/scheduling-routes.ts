import { Router, type NextFunction, type Request, type Response } from 'express';
import { Platform, ScheduleStatus, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { cancelPublication, cancelSchedule, createPublicationSchedule, listCalendar, reschedulePublication } from '../scheduling/service.js';
import { evaluatePublicationPreflight } from '../scheduling/preflight.js';
import { ApiError } from './errors.js';
import { idSchema, parseRequest, positiveVersionSchema } from './validation.js';

const localDateTimeSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, 'localDateTime must use YYYY-MM-DDTHH:mm[:ss]');
const timezoneSchema = z.string().trim().min(1).max(64);
const scheduleMutationSchema = z.object({ localDateTime: localDateTimeSchema, timezone: timezoneSchema, expectedVersion: positiveVersionSchema }).strict();
const versionBodySchema = z.object({ expectedVersion: positiveVersionSchema }).strict();
const calendarQuerySchema = z.object({
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  platform: z.nativeEnum(Platform).optional(),
  status: z.nativeEnum(ScheduleStatus).optional(),
  channelId: z.string().trim().min(1).max(191).optional(),
}).strict();

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => { void Promise.resolve(handler(req, res)).catch(next); };
}

function requireAdmin(req: Request) {
  if (!req.actor) throw new ApiError(401, 'ADMIN_CONTEXT_MISSING', 'Administrator context is missing');
  return req.actor;
}

export function createSchedulingRouter(prisma: PrismaClient, config: AppConfig) {
  const router = Router();

  router.get('/publications/:id/preflight', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    requireAdmin(req);
    res.json(await evaluatePublicationPreflight(prisma, id));
  }));

  router.post('/publications/:id/schedule', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(scheduleMutationSchema, req.body);
    const actor = requireAdmin(req);
    res.status(201).json(await createPublicationSchedule(prisma, id, body, config, actor.email, req.requestId));
  }));

  router.patch('/schedules/:id', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(scheduleMutationSchema, req.body);
    const actor = requireAdmin(req);
    res.json(await reschedulePublication(prisma, id, body, config, actor.email, req.requestId));
  }));

  router.post('/schedules/:id/cancel', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(versionBodySchema, req.body);
    const actor = requireAdmin(req);
    res.json(await cancelSchedule(prisma, id, body.expectedVersion, actor.email, req.requestId));
  }));

  router.post('/publications/:id/cancel', asyncRoute(async (req, res) => {
    const id = parseRequest(idSchema, req.params.id);
    const body = parseRequest(versionBodySchema, req.body);
    const actor = requireAdmin(req);
    res.json(await cancelPublication(prisma, id, body.expectedVersion, actor.email, req.requestId));
  }));

  router.get('/calendar', asyncRoute(async (req, res) => {
    requireAdmin(req);
    const query = parseRequest(calendarQuerySchema, req.query);
    const start = new Date(query.start);
    const end = new Date(query.end);
    if (end.getTime() <= start.getTime()) throw new ApiError(400, 'CALENDAR_RANGE_INVALID', 'Calendar end must be after start');
    if (end.getTime() - start.getTime() > 370 * 24 * 60 * 60 * 1000) throw new ApiError(400, 'CALENDAR_RANGE_TOO_LARGE', 'Calendar range cannot exceed 370 days');
    res.json(await listCalendar(prisma, {
      start,
      end,
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.channelId ? { channelId: query.channelId } : {}),
    }));
  }));

  return router;
}
