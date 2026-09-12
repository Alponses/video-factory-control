import { Platform, type Profile } from '@prisma/client';
import type { AppConfig } from '../config.js';
import type { HttpResponse, HttpTransport } from '../publishing/http.js';
import { IntegrationError } from './errors.js';

const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;
const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;
const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const;

export interface OAuthConnectionResult {
  provider: Platform;
  accountId: string;
  displayName: string | null;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes: string[];
  readiness: string;
  metadata: Record<string, unknown>;
}

function socialConfig(config: AppConfig, provider: Platform): { redirectUri: string } {
  if (provider === Platform.TIKTOK && config.tiktok) return config.tiktok;
  if (provider === Platform.YOUTUBE && config.youtube) return config.youtube;
  if (provider === Platform.FACEBOOK && config.facebook) return config.facebook;
  throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', `${provider} OAuth is not configured`);
}

export function buildOAuthAuthorizeUrl(config: AppConfig, provider: Platform, state: string): string {
  const configured = socialConfig(config, provider);
  if (provider === Platform.TIKTOK) {
    if (!config.tiktok) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'TikTok OAuth is not configured');
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.search = new URLSearchParams({ client_key: config.tiktok.clientKey, response_type: 'code', scope: TIKTOK_SCOPES.join(','), redirect_uri: configured.redirectUri, state }).toString();
    return url.toString();
  }
  if (provider === Platform.YOUTUBE) {
    if (!config.youtube) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'YouTube OAuth is not configured');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.youtube.clientId, response_type: 'code', scope: YOUTUBE_SCOPES.join(' '), redirect_uri: configured.redirectUri, state, access_type: 'offline', include_granted_scopes: 'true' }).toString();
    return url.toString();
  }
  if (!config.facebook) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'Facebook OAuth is not configured');
  const url = new URL(`https://www.facebook.com/${config.facebook.graphApiVersion}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: config.facebook.appId, response_type: 'code', scope: FACEBOOK_SCOPES.join(','), redirect_uri: configured.redirectUri, state }).toString();
  return url.toString();
}

async function requireJson<T>(response: HttpResponse, code: 'OAUTH_TOKEN_EXCHANGE_FAILED' | 'OAUTH_IDENTITY_FAILED'): Promise<T> {
  if (!response.ok) throw new IntegrationError(code, code === 'OAUTH_TOKEN_EXCHANGE_FAILED' ? 'OAuth token exchange was rejected' : 'Provider identity lookup failed');
  try { return await response.json<T>(); } catch { throw new IntegrationError(code, 'Provider returned an invalid OAuth response'); }
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function futureDate(seconds: unknown, now: Date): Date | null {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(now.getTime() + value * 1000) : null;
}

function splitScopes(value: unknown, fallback: readonly string[]): string[] {
  if (typeof value === 'string') return value.split(/[ ,]+/).map((item) => item.trim()).filter(Boolean);
  return [...fallback];
}

function profileMetadata(profile: Profile): Record<string, unknown> {
  return profile.metadata && typeof profile.metadata === 'object' && !Array.isArray(profile.metadata) ? profile.metadata as Record<string, unknown> : {};
}

export async function exchangeOAuthCode(transport: HttpTransport, config: AppConfig, provider: Platform, profile: Profile, code: string, redirectUri: string, now = new Date()): Promise<OAuthConnectionResult> {
  if (!code) throw new IntegrationError('OAUTH_TOKEN_EXCHANGE_FAILED', 'Authorization code is required');
  if (socialConfig(config, provider).redirectUri !== redirectUri) throw new IntegrationError('OAUTH_TOKEN_EXCHANGE_FAILED', 'OAuth redirect URI does not match configured callback');

  if (provider === Platform.TIKTOK) {
    if (!config.tiktok) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'TikTok OAuth is not configured');
    const tokenResponse = await transport.request('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }) });
    const token = await requireJson<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; open_id?: string; scope?: string }>(tokenResponse, 'OAUTH_TOKEN_EXCHANGE_FAILED');
    if (!token.access_token || !token.open_id) throw new IntegrationError('OAUTH_TOKEN_EXCHANGE_FAILED', 'TikTok token response is incomplete');
    const identityResponse = await transport.request('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` } });
    const identity = await requireJson<{ data?: { user?: { open_id?: string; display_name?: string } } }>(identityResponse, 'OAUTH_IDENTITY_FAILED');
    const user = identity.data?.user;
    return {
      provider,
      accountId: user?.open_id ?? token.open_id,
      displayName: user?.display_name ?? null,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: futureDate(token.expires_in, now),
      refreshExpiresAt: futureDate(token.refresh_expires_in, now),
      scopes: splitScopes(token.scope, TIKTOK_SCOPES),
      readiness: 'PRIVATE_ONLY_UNAUDITED',
      metadata: { auditStatus: 'UNAUDITED' },
    };
  }

  if (provider === Platform.YOUTUBE) {
    if (!config.youtube) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'YouTube OAuth is not configured');
    const tokenResponse = await transport.request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }) });
    const token = await requireJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(tokenResponse, 'OAUTH_TOKEN_EXCHANGE_FAILED');
    if (!token.access_token) throw new IntegrationError('OAUTH_TOKEN_EXCHANGE_FAILED', 'Google token response is incomplete');
    const channelsResponse = await transport.request('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` } });
    const channels = await requireJson<{ items?: Array<{ id?: string; snippet?: { title?: string } }> }>(channelsResponse, 'OAUTH_IDENTITY_FAILED');
    const channel = channels.items?.[0];
    if (!channel?.id) throw new IntegrationError('OAUTH_IDENTITY_FAILED', 'No YouTube channel is available for this authorization');
    return {
      provider,
      accountId: channel.id,
      displayName: channel.snippet?.title ?? null,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: futureDate(token.expires_in, now),
      scopes: splitScopes(token.scope, YOUTUBE_SCOPES),
      readiness: 'PRIVATE_ONLY_UNVERIFIED',
      metadata: { apiVerification: 'UNVERIFIED', channelId: channel.id },
    };
  }

  if (!config.facebook) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'Facebook OAuth is not configured');
  const tokenResponse = await transport.request(`https://graph.facebook.com/${config.facebook.graphApiVersion}/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: config.facebook.appId, client_secret: config.facebook.appSecret, code, redirect_uri: redirectUri }) });
  const token = await requireJson<{ access_token?: string; expires_in?: number }>(tokenResponse, 'OAUTH_TOKEN_EXCHANGE_FAILED');
  if (!token.access_token) throw new IntegrationError('OAUTH_TOKEN_EXCHANGE_FAILED', 'Facebook token response is incomplete');
  const pageResponse = await transport.request(`https://graph.facebook.com/${config.facebook.graphApiVersion}/me/accounts?fields=id,name,access_token,tasks`, { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` } });
  const pages = await requireJson<{ data?: Array<{ id?: string; name?: string; access_token?: string; tasks?: string[] }> }>(pageResponse, 'OAUTH_IDENTITY_FAILED');
  const available = (pages.data ?? []).filter((page) => page.id && page.access_token);
  const wantedPageId = profileMetadata(profile).facebookPageId;
  const page = typeof wantedPageId === 'string' ? available.find((item) => item.id === wantedPageId) : available.length === 1 ? available[0] : undefined;
  if (!page?.id || !page.access_token) throw new IntegrationError('FACEBOOK_PAGE_SELECTION_REQUIRED', 'Facebook Page selection is required before connection can complete');
  return {
    provider,
    accountId: page.id,
    displayName: page.name ?? null,
    accessToken: page.access_token,
    expiresAt: futureDate(token.expires_in, now),
    scopes: FACEBOOK_SCOPES.filter((scope) => page.tasks?.length ? true : scope !== 'pages_manage_posts'),
    readiness: 'READY',
    metadata: { pageId: page.id, pageName: page.name ?? null, tasks: page.tasks ?? [], graphApiVersion: config.facebook.graphApiVersion },
  };
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes?: string[];
}

export async function refreshOAuthToken(transport: HttpTransport, config: AppConfig, provider: Platform, refreshToken: string, now = new Date()): Promise<RefreshResult> {
  if (provider === Platform.TIKTOK) {
    if (!config.tiktok) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'TikTok OAuth is not configured');
    const response = await transport.request('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) });
    const token = await requireJson<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; scope?: string }>(response, 'OAUTH_TOKEN_EXCHANGE_FAILED');
    if (!token.access_token) throw new IntegrationError('TOKEN_REFRESH_FAILED', 'TikTok refresh response is incomplete');
    return { accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), expiresAt: futureDate(token.expires_in, now), refreshExpiresAt: futureDate(token.refresh_expires_in, now), scopes: splitScopes(token.scope, TIKTOK_SCOPES) };
  }
  if (provider === Platform.YOUTUBE) {
    if (!config.youtube) throw new IntegrationError('SOCIAL_PROVIDER_NOT_CONFIGURED', 'YouTube OAuth is not configured');
    const response = await transport.request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) });
    const token = await requireJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(response, 'OAUTH_TOKEN_EXCHANGE_FAILED');
    if (!token.access_token) throw new IntegrationError('TOKEN_REFRESH_FAILED', 'Google refresh response is incomplete');
    return { accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), expiresAt: futureDate(token.expires_in, now), scopes: splitScopes(token.scope, YOUTUBE_SCOPES) };
  }
  throw new IntegrationError('TOKEN_REFRESH_FAILED', 'Facebook Page access requires reauthorization when the stored token expires');
}

export { FACEBOOK_SCOPES, TIKTOK_SCOPES, YOUTUBE_SCOPES };
