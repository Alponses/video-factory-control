import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { isValidIanaTimeZone } from './scheduling/timezone.js';

const emailListSchema = z.string().transform((value, ctx) => {
  const emails = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0 || emails.some((email) => email.includes('*') || !z.string().email().safeParse(email).success)) {
    ctx.addIssue({ code: 'custom', message: 'ADMIN_ALLOWED_EMAILS must contain explicit valid email addresses only' });
    return z.NEVER;
  }
  return [...new Set(emails)];
});

const optionalInteger = (min: number, max: number) => z.preprocess(
  (value) => value === '' || value === undefined ? undefined : value,
  z.coerce.number().int().min(min).max(max).optional(),
);

const optionalSecret = z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).optional());

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  CLOUDFLARE_AUTH_MODE: z.enum(['remote', 'test']).default('remote'),
  CLOUDFLARE_TEAM_DOMAIN: z.string().url().optional(),
  CLOUDFLARE_ADMIN_ACCESS_AUD: z.string().min(1).optional(),
  CLOUDFLARE_WORKER_ACCESS_AUD: z.string().min(1).optional(),
  ADMIN_ALLOWED_EMAILS: emailListSchema,
  WORKER_OFFLINE_THRESHOLD_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  LEASE_DURATION_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  APP_TIMEZONE: z.string().trim().min(1).max(64).default('America/Mexico_City'),
  SCHEDULER_LEASE_SECONDS: z.coerce.number().int().min(10).max(300).default(55),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  SCHEDULER_MAX_LATENESS_SECONDS: optionalInteger(1, 7 * 24 * 60 * 60),
  SCHEDULE_PAST_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  SCHEDULE_MIN_LEAD_SECONDS: optionalInteger(0, 3600),
  PUBLISHER_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  PUBLISHER_CLAIM_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  PUBLISHER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  PUBLISHER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  APP_ENCRYPTION_KEY: optionalSecret,
  TIKTOK_CLIENT_KEY: optionalSecret,
  TIKTOK_CLIENT_SECRET: optionalSecret,
  TIKTOK_REDIRECT_URI: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  YOUTUBE_CLIENT_ID: optionalSecret,
  YOUTUBE_CLIENT_SECRET: optionalSecret,
  YOUTUBE_REDIRECT_URI: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  FACEBOOK_APP_ID: optionalSecret,
  FACEBOOK_APP_SECRET: optionalSecret,
  FACEBOOK_REDIRECT_URI: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  FACEBOOK_GRAPH_API_VERSION: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^v\d+\.\d+$/).optional()),
  R2_ACCOUNT_ID: z.string().trim().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  R2_BUCKET: z.string().trim().min(1).max(255).optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  R2_SINGLE_UPLOAD_THRESHOLD_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).max(5 * 1024 * 1024 * 1024).default(100 * 1024 * 1024),
  R2_MULTIPART_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).max(5 * 1024 * 1024 * 1024).default(16 * 1024 * 1024),
});

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  origin: string;
  presignTtlSeconds: number;
  singleUploadThresholdBytes: number;
  multipartPartSizeBytes: number;
}

export interface TikTokSocialConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export interface YouTubeSocialConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface FacebookSocialConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphApiVersion: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  appOrigin: string;
  databaseUrl: string;
  cloudflareAuthMode: 'remote' | 'test';
  cloudflareTeamDomain?: string;
  cloudflareAdminAccessAud?: string;
  cloudflareWorkerAccessAud?: string;
  adminAllowedEmails: string[];
  workerOfflineThresholdSeconds?: number;
  leaseDurationSeconds?: number;
  appTimezone?: string;
  schedulerLeaseSeconds?: number;
  schedulerBatchSize?: number;
  schedulerMaxLatenessSeconds?: number;
  schedulePastToleranceSeconds?: number;
  scheduleMinLeadSeconds?: number;
  publisherBatchSize?: number;
  publisherClaimSeconds?: number;
  publisherMaxAttempts?: number;
  publisherHttpTimeoutMs?: number;
  appEncryptionKey?: string;
  tiktok?: TikTokSocialConfig;
  youtube?: YouTubeSocialConfig;
  facebook?: FacebookSocialConfig;
  r2?: R2Config;
}

export function hasSocialIntegrations(config: AppConfig): boolean {
  return Boolean(config.tiktok || config.youtube || config.facebook);
}

function validBase64EncryptionKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

function validateRedirectUri(uri: string, provider: 'tiktok' | 'youtube' | 'facebook', appOrigin: string, production: boolean): void {
  const parsed = new URL(uri);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Invalid server configuration: ${provider.toUpperCase()}_REDIRECT_URI must use HTTP(S)`);
  if (parsed.search || parsed.hash || parsed.pathname !== `/api/oauth/${provider}/callback`) {
    throw new Error(`Invalid server configuration: ${provider.toUpperCase()}_REDIRECT_URI must be the configured callback path`);
  }
  if (production && (parsed.protocol !== 'https:' || parsed.origin !== appOrigin)) {
    throw new Error(`Invalid server configuration: ${provider.toUpperCase()}_REDIRECT_URI must be same-origin HTTPS in production`);
  }
}

function coherentBundle(name: string, values: Array<string | undefined>): boolean {
  const supplied = values.filter(Boolean).length;
  if (supplied !== 0 && supplied !== values.length) throw new Error(`Invalid server configuration: ${name} credentials and redirect URI must be configured together`);
  return supplied === values.length;
}

export function isCriticalConfigReady(config: AppConfig): boolean {
  if (!config.appBaseUrl || !config.appOrigin || !config.databaseUrl || config.adminAllowedEmails.length === 0) return false;
  if (config.nodeEnv === 'production' && !config.appBaseUrl.startsWith('https://')) return false;
  if (config.cloudflareAuthMode === 'remote' && (!config.cloudflareTeamDomain || !config.cloudflareAdminAccessAud)) return false;
  if (config.nodeEnv === 'production' && (!config.cloudflareWorkerAccessAud || config.cloudflareAuthMode !== 'remote' || !config.r2)) return false;
  const workerOfflineThresholdSeconds = config.workerOfflineThresholdSeconds ?? 60;
  const leaseDurationSeconds = config.leaseDurationSeconds ?? 120;
  if (workerOfflineThresholdSeconds < 15 || leaseDurationSeconds < 30) return false;
  if (!isValidIanaTimeZone(config.appTimezone ?? 'America/Mexico_City')) return false;
  if ((config.schedulerLeaseSeconds ?? 55) < 10 || (config.schedulerBatchSize ?? 50) < 1 || (config.schedulePastToleranceSeconds ?? 60) < 0) return false;
  if ((config.publisherBatchSize ?? 5) < 1 || (config.publisherClaimSeconds ?? 300) < 30 || (config.publisherMaxAttempts ?? 5) < 1) return false;
  if (hasSocialIntegrations(config) && (!config.appEncryptionKey || !validBase64EncryptionKey(config.appEncryptionKey))) return false;
  if (config.r2) {
    if (!config.r2.endpoint.startsWith('https://') || config.r2.presignTtlSeconds < 30 || config.r2.presignTtlSeconds > 900) return false;
    if (config.r2.multipartPartSizeBytes < 5 * 1024 * 1024 || config.r2.multipartPartSizeBytes > 5 * 1024 * 1024 * 1024) return false;
  }
  return true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = baseSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid server configuration: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  }
  const value = parsed.data;
  const appUrl = new URL(value.APP_BASE_URL);
  if (!isValidIanaTimeZone(value.APP_TIMEZONE)) throw new Error('Invalid server configuration: APP_TIMEZONE must be a valid IANA time zone');
  if (value.NODE_ENV === 'production') {
    if (appUrl.protocol !== 'https:') throw new Error('Invalid server configuration: APP_BASE_URL must use HTTPS in production');
    if (value.CLOUDFLARE_AUTH_MODE !== 'remote') throw new Error('Invalid server configuration: Cloudflare test mode is forbidden in production');
    if (!value.CLOUDFLARE_TEAM_DOMAIN || !value.CLOUDFLARE_ADMIN_ACCESS_AUD || !value.CLOUDFLARE_WORKER_ACCESS_AUD) {
      throw new Error('Invalid server configuration: Cloudflare team domain plus admin and worker audiences are required in production');
    }
  }
  if (value.CLOUDFLARE_AUTH_MODE === 'remote' && (!value.CLOUDFLARE_TEAM_DOMAIN || !value.CLOUDFLARE_ADMIN_ACCESS_AUD)) {
    throw new Error('Invalid server configuration: remote Cloudflare auth requires team domain and admin audience');
  }

  const suppliedR2 = [value.R2_ACCOUNT_ID, value.R2_ACCESS_KEY_ID, value.R2_SECRET_ACCESS_KEY, value.R2_BUCKET].filter(Boolean).length;
  if (suppliedR2 !== 0 && suppliedR2 !== 4) throw new Error('Invalid server configuration: R2 account ID, access key, secret and bucket must be configured together');
  if (value.NODE_ENV === 'production' && suppliedR2 !== 4) throw new Error('Invalid server configuration: private R2 durable storage is required in production');

  const tiktokReady = coherentBundle('TikTok', [value.TIKTOK_CLIENT_KEY, value.TIKTOK_CLIENT_SECRET, value.TIKTOK_REDIRECT_URI]);
  const youtubeReady = coherentBundle('YouTube', [value.YOUTUBE_CLIENT_ID, value.YOUTUBE_CLIENT_SECRET, value.YOUTUBE_REDIRECT_URI]);
  const facebookReady = coherentBundle('Facebook', [value.FACEBOOK_APP_ID, value.FACEBOOK_APP_SECRET, value.FACEBOOK_REDIRECT_URI, value.FACEBOOK_GRAPH_API_VERSION]);
  const socialConfigured = tiktokReady || youtubeReady || facebookReady;
  if (socialConfigured && (!value.APP_ENCRYPTION_KEY || !validBase64EncryptionKey(value.APP_ENCRYPTION_KEY))) {
    throw new Error('Invalid server configuration: APP_ENCRYPTION_KEY must be a 32-byte base64 key when social integrations are configured');
  }

  const config: AppConfig = {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    appBaseUrl: appUrl.toString().replace(/\/$/, ''),
    appOrigin: appUrl.origin,
    databaseUrl: value.DATABASE_URL,
    cloudflareAuthMode: value.CLOUDFLARE_AUTH_MODE,
    adminAllowedEmails: value.ADMIN_ALLOWED_EMAILS,
    workerOfflineThresholdSeconds: value.WORKER_OFFLINE_THRESHOLD_SECONDS,
    leaseDurationSeconds: value.LEASE_DURATION_SECONDS,
    appTimezone: value.APP_TIMEZONE,
    schedulerLeaseSeconds: value.SCHEDULER_LEASE_SECONDS,
    schedulerBatchSize: value.SCHEDULER_BATCH_SIZE,
    schedulePastToleranceSeconds: value.SCHEDULE_PAST_TOLERANCE_SECONDS,
    publisherBatchSize: value.PUBLISHER_BATCH_SIZE,
    publisherClaimSeconds: value.PUBLISHER_CLAIM_SECONDS,
    publisherMaxAttempts: value.PUBLISHER_MAX_ATTEMPTS,
    publisherHttpTimeoutMs: value.PUBLISHER_HTTP_TIMEOUT_MS,
  };
  if (value.SCHEDULER_MAX_LATENESS_SECONDS !== undefined) config.schedulerMaxLatenessSeconds = value.SCHEDULER_MAX_LATENESS_SECONDS;
  if (value.SCHEDULE_MIN_LEAD_SECONDS !== undefined) config.scheduleMinLeadSeconds = value.SCHEDULE_MIN_LEAD_SECONDS;
  if (value.CLOUDFLARE_TEAM_DOMAIN) config.cloudflareTeamDomain = value.CLOUDFLARE_TEAM_DOMAIN.replace(/\/$/, '');
  if (value.CLOUDFLARE_ADMIN_ACCESS_AUD) config.cloudflareAdminAccessAud = value.CLOUDFLARE_ADMIN_ACCESS_AUD;
  if (value.CLOUDFLARE_WORKER_ACCESS_AUD) config.cloudflareWorkerAccessAud = value.CLOUDFLARE_WORKER_ACCESS_AUD;
  if (value.APP_ENCRYPTION_KEY) config.appEncryptionKey = value.APP_ENCRYPTION_KEY;

  if (tiktokReady) {
    validateRedirectUri(value.TIKTOK_REDIRECT_URI!, 'tiktok', appUrl.origin, value.NODE_ENV === 'production');
    config.tiktok = { clientKey: value.TIKTOK_CLIENT_KEY!, clientSecret: value.TIKTOK_CLIENT_SECRET!, redirectUri: value.TIKTOK_REDIRECT_URI! };
  }
  if (youtubeReady) {
    validateRedirectUri(value.YOUTUBE_REDIRECT_URI!, 'youtube', appUrl.origin, value.NODE_ENV === 'production');
    config.youtube = { clientId: value.YOUTUBE_CLIENT_ID!, clientSecret: value.YOUTUBE_CLIENT_SECRET!, redirectUri: value.YOUTUBE_REDIRECT_URI! };
  }
  if (facebookReady) {
    validateRedirectUri(value.FACEBOOK_REDIRECT_URI!, 'facebook', appUrl.origin, value.NODE_ENV === 'production');
    config.facebook = { appId: value.FACEBOOK_APP_ID!, appSecret: value.FACEBOOK_APP_SECRET!, redirectUri: value.FACEBOOK_REDIRECT_URI!, graphApiVersion: value.FACEBOOK_GRAPH_API_VERSION! };
  }

  if (suppliedR2 === 4) {
    const endpoint = (value.R2_ENDPOINT ?? `https://${value.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/$/, '');
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:') throw new Error('Invalid server configuration: R2_ENDPOINT must use HTTPS');
    config.r2 = {
      accountId: value.R2_ACCOUNT_ID!,
      accessKeyId: value.R2_ACCESS_KEY_ID!,
      secretAccessKey: value.R2_SECRET_ACCESS_KEY!,
      bucket: value.R2_BUCKET!,
      endpoint,
      origin: endpointUrl.origin,
      presignTtlSeconds: value.R2_PRESIGN_TTL_SECONDS,
      singleUploadThresholdBytes: value.R2_SINGLE_UPLOAD_THRESHOLD_BYTES,
      multipartPartSizeBytes: value.R2_MULTIPART_PART_SIZE_BYTES,
    };
  }
  if (!isCriticalConfigReady(config)) throw new Error('Invalid server configuration: critical configuration is incomplete');
  return config;
}
