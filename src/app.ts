import express, { type Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config.js';
import { createAdminAuth, type CloudflareAuthDependencies } from './http/auth.js';
import { errorHandler, ApiError } from './http/errors.js';
import { consoleJsonLogger, requestLogger, type Logger } from './http/logger.js';
import { createAdminRouter, createHealthRouter } from './http/routes.js';
import { browserMutationGuard, fixedWindowRateLimit, requestContext, sameOriginCors, securityHeaders } from './http/security.js';

export interface AppDependencies {
  prisma: PrismaClient;
  auth?: CloudflareAuthDependencies;
  logger?: Logger;
}

export function createApp(config: AppConfig, dependencies: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  // Trust exactly one hosting reverse-proxy hop, never arbitrary X-Forwarded-* chains.
  app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(securityHeaders(config));
  app.use(sameOriginCors(config));
  app.use(requestLogger(dependencies.logger ?? consoleJsonLogger));
  app.use(express.json({ limit: '1mb', strict: true }));

  app.use('/api/health', createHealthRouter(dependencies.prisma));

  const adminAuth = createAdminAuth(config, dependencies.auth);
  app.use('/api/admin', adminAuth);
  app.use('/api/admin', (req, res, next) => req.method === 'GET' ? fixedWindowRateLimit(120, 60_000)(req, res, next) : fixedWindowRateLimit(60, 60_000)(req, res, next));
  app.use('/api/admin', browserMutationGuard(config));
  app.use('/api/admin', createAdminRouter(dependencies.prisma));

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'ROUTE_NOT_FOUND', 'API route was not found')));
  app.use(errorHandler(config.nodeEnv));
  return app;
}
