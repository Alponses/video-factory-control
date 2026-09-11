import type { NextFunction, Request, Response } from 'express';
import { ActorType } from '@prisma/client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppConfig } from '../config.js';
import { ApiError } from './errors.js';

type VerifyKey = Parameters<typeof jwtVerify>[1];

export interface CloudflareAuthDependencies {
  keyResolver?: VerifyKey;
  issuer?: string;
  audience?: string;
}

function buildRemoteKey(config: AppConfig): VerifyKey {
  if (!config.cloudflareTeamDomain) throw new Error('Cloudflare team domain is not configured');
  return createRemoteJWKSet(new URL(`${config.cloudflareTeamDomain}/cdn-cgi/access/certs`));
}

export function createAdminAuth(config: AppConfig, dependencies: CloudflareAuthDependencies = {}) {
  if (config.cloudflareAuthMode === 'test' && !dependencies.keyResolver) {
    throw new Error('Test Cloudflare auth requires an injected cryptographic key resolver');
  }
  const issuer = dependencies.issuer ?? config.cloudflareTeamDomain;
  const audience = dependencies.audience ?? config.cloudflareAdminAccessAud;
  if (!issuer || !audience) throw new Error('Cloudflare issuer and audience are required');
  const keyResolver = dependencies.keyResolver ?? buildRemoteKey(config);
  const allowlist = new Set(config.adminAllowedEmails.map((email) => email.toLowerCase()));

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = req.get('cf-access-jwt-assertion');
    if (!token) return next(new ApiError(401, 'ACCESS_JWT_MISSING', 'Cloudflare Access token is required'));
    try {
      const { payload } = await jwtVerify(token, keyResolver, { issuer, audience });
      const rawEmail = payload.email;
      if (typeof rawEmail !== 'string' || !rawEmail.trim()) return next(new ApiError(401, 'ACCESS_IDENTITY_INVALID', 'Cloudflare Access identity is invalid'));
      const email = rawEmail.trim().toLowerCase();
      if (!allowlist.has(email)) return next(new ApiError(403, 'ADMIN_EMAIL_FORBIDDEN', 'Administrator is not authorized'));
      req.actor = { type: ActorType.ADMIN, email };
      next();
    } catch (error) {
      if (error instanceof ApiError) return next(error);
      next(new ApiError(401, 'ACCESS_JWT_INVALID', 'Cloudflare Access token is invalid'));
    }
  };
}
