import { z } from 'zod';

const emailListSchema = z.string().transform((value, ctx) => {
  const emails = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0 || emails.some((email) => email.includes('*') || !z.string().email().safeParse(email).success)) {
    ctx.addIssue({ code: 'custom', message: 'ADMIN_ALLOWED_EMAILS must contain explicit valid email addresses only' });
    return z.NEVER;
  }
  return [...new Set(emails)];
});

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  CLOUDFLARE_AUTH_MODE: z.enum(['remote', 'test']).default('remote'),
  CLOUDFLARE_TEAM_DOMAIN: z.string().url().optional(),
  CLOUDFLARE_ADMIN_ACCESS_AUD: z.string().min(1).optional(),
  ADMIN_ALLOWED_EMAILS: emailListSchema,
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  appOrigin: string;
  databaseUrl: string;
  cloudflareAuthMode: 'remote' | 'test';
  cloudflareTeamDomain?: string;
  cloudflareAdminAccessAud?: string;
  adminAllowedEmails: string[];
}

export function isCriticalConfigReady(config: AppConfig): boolean {
  if (!config.appBaseUrl || !config.appOrigin || !config.databaseUrl || config.adminAllowedEmails.length === 0) return false;
  if (config.nodeEnv === 'production' && !config.appBaseUrl.startsWith('https://')) return false;
  if (config.cloudflareAuthMode === 'remote' && (!config.cloudflareTeamDomain || !config.cloudflareAdminAccessAud)) return false;
  if (config.nodeEnv === 'production' && config.cloudflareAuthMode !== 'remote') return false;
  return true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = baseSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid server configuration: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  }
  const value = parsed.data;
  const appUrl = new URL(value.APP_BASE_URL);
  if (value.NODE_ENV === 'production') {
    if (appUrl.protocol !== 'https:') throw new Error('Invalid server configuration: APP_BASE_URL must use HTTPS in production');
    if (value.CLOUDFLARE_AUTH_MODE !== 'remote') throw new Error('Invalid server configuration: Cloudflare test mode is forbidden in production');
    if (!value.CLOUDFLARE_TEAM_DOMAIN || !value.CLOUDFLARE_ADMIN_ACCESS_AUD) {
      throw new Error('Invalid server configuration: Cloudflare team domain and audience are required in production');
    }
  }
  if (value.CLOUDFLARE_AUTH_MODE === 'remote' && (!value.CLOUDFLARE_TEAM_DOMAIN || !value.CLOUDFLARE_ADMIN_ACCESS_AUD)) {
    throw new Error('Invalid server configuration: remote Cloudflare auth requires team domain and audience');
  }
  const config: AppConfig = {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    appBaseUrl: appUrl.toString().replace(/\/$/, ''),
    appOrigin: appUrl.origin,
    databaseUrl: value.DATABASE_URL,
    cloudflareAuthMode: value.CLOUDFLARE_AUTH_MODE,
    cloudflareTeamDomain: value.CLOUDFLARE_TEAM_DOMAIN?.replace(/\/$/, ''),
    cloudflareAdminAccessAud: value.CLOUDFLARE_ADMIN_ACCESS_AUD,
    adminAllowedEmails: value.ADMIN_ALLOWED_EMAILS,
  };
  if (!isCriticalConfigReady(config)) throw new Error('Invalid server configuration: critical configuration is incomplete');
  return config;
}
