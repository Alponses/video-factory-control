import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { ApiError } from './errors.js';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function securityHeaders(config: AppConfig) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const csp = config.nodeEnv === 'production'
      ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.nodeEnv === 'production' && config.appBaseUrl.startsWith('https://')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  };
}

export function sameOriginCors(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (origin && origin !== config.appOrigin) return next(new ApiError(403, 'CORS_ORIGIN_FORBIDDEN', 'Origin is not allowed'));
    if (origin === config.appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.appOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cf-Access-Jwt-Assertion');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function browserMutationGuard(config: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin !== config.appOrigin) return next(new ApiError(403, 'CSRF_ORIGIN_INVALID', 'Mutation origin is not allowed'));
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') return next(new ApiError(403, 'CSRF_SITE_INVALID', 'Cross-site mutation is not allowed'));
    if (!req.is('application/json')) return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Mutations require application/json'));
    next();
  };
}

interface Bucket { count: number; resetAt: number }
export function fixedWindowRateLimit(max: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.actor?.email ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) return next(new ApiError(429, 'RATE_LIMITED', 'Too many requests'));
    next();
  };
}
