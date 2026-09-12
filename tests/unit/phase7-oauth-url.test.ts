import assert from 'node:assert/strict';
import test from 'node:test';
import { Platform } from '@prisma/client';
import type { AppConfig } from '../../src/config.js';
import { buildOAuthAuthorizeUrl } from '../../src/integrations/oauth.js';

const base: AppConfig = { nodeEnv: 'test', port: 3000, appBaseUrl: 'https://factory.example.test', appOrigin: 'https://factory.example.test', databaseUrl: 'mysql://test', cloudflareAuthMode: 'test', adminAllowedEmails: ['admin@example.test'] };

test('TikTok Web OAuth uses Login Kit web endpoint without desktop PKCE and least scopes', () => {
  const config: AppConfig = { ...base, tiktok: { clientKey: 'key', clientSecret: 'secret', redirectUri: 'https://factory.example.test/api/oauth/tiktok/callback' } };
  const url = new URL(buildOAuthAuthorizeUrl(config, Platform.TIKTOK, 'state-value'));
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.publish');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.has('code_challenge'), false);
  assert.equal(url.searchParams.get('redirect_uri'), config.tiktok?.redirectUri);
});

test('YouTube Web OAuth requests offline access and only upload plus channel identity scopes', () => {
  const config: AppConfig = { ...base, youtube: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://factory.example.test/api/oauth/youtube/callback' } };
  const url = new URL(buildOAuthAuthorizeUrl(config, Platform.YOUTUBE, 'state-value'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
  assert.deepEqual(scopes.sort(), ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.upload'].sort());
});

test('Facebook OAuth uses configured Graph version and server callback', () => {
  const config: AppConfig = { ...base, facebook: { appId: 'id', appSecret: 'secret', redirectUri: 'https://factory.example.test/api/oauth/facebook/callback', graphApiVersion: 'v99.0' } };
  const url = new URL(buildOAuthAuthorizeUrl(config, Platform.FACEBOOK, 'state-value'));
  assert.equal(url.pathname, '/v99.0/dialog/oauth');
  assert.match(url.searchParams.get('scope') ?? '', /pages_manage_posts/);
  assert.equal(url.searchParams.get('redirect_uri'), config.facebook?.redirectUri);
});
