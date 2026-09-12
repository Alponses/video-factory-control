import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { errorHandler } from '../../src/http/errors.js';
import { redact } from '../../src/http/logger.js';
import { requestContext, securityHeaders } from '../../src/http/security.js';
import { withServer } from '../helpers/http.js';

test('production config fails closed for test auth', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    PORT: '3000',
    APP_BASE_URL: 'https://factory.norvian.io',
    DATABASE_URL: 'mysql://example.invalid/v5',
    CLOUDFLARE_AUTH_MODE: 'test',
    ADMIN_ALLOWED_EMAILS: 'admin@example.com',
  }), /forbidden in production/);
});

test('admin allowlist rejects wildcards', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://admin.test',
    DATABASE_URL: 'mysql://example.invalid/v5',
    CLOUDFLARE_AUTH_MODE: 'test',
    ADMIN_ALLOWED_EMAILS: '*@example.com',
  }), /Invalid server configuration/);
});

test('redaction removes phase4 secrets, lease material, access assertions and database URLs', () => {
  const value = redact({
    authorization: 'Bearer hidden',
    cookie: 'session=hidden',
    workerSecret: 'vfws_hidden',
    secretHash: 'worker-hash-hidden',
    leaseToken: 'vfl_hidden',
    leaseTokenHash: 'lease-hash-hidden',
    'CF-Access-Client-Secret': 'cloudflare-service-secret',
    'Cf-Access-Jwt-Assertion': 'cloudflare-access-jwt',
    nested: { accessToken: 'hidden', refreshToken: 'hidden', clientSecret: 'hidden', safe: 'ok' },
    databaseUrl: 'mysql://example.invalid/v5',
    value: 'mysql://example.invalid/v5',
  }) as Record<string, unknown>;
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.cookie, '[REDACTED]');
  assert.equal(value.workerSecret, '[REDACTED]');
  assert.equal(value.secretHash, '[REDACTED]');
  assert.equal(value.leaseToken, '[REDACTED]');
  assert.equal(value.leaseTokenHash, '[REDACTED]');
  assert.equal(value['CF-Access-Client-Secret'], '[REDACTED]');
  assert.equal(value['Cf-Access-Jwt-Assertion'], '[REDACTED]');
  assert.equal(value.databaseUrl, '[REDACTED]');
  assert.equal(value.value, '[REDACTED]');
  assert.deepEqual(value.nested, { accessToken: '[REDACTED]', refreshToken: '[REDACTED]', clientSecret: '[REDACTED]', safe: 'ok' });
});

test('security headers are present and HSTS is HTTPS-production only', async () => {
  const config: AppConfig = {
    nodeEnv: 'test', port: 3000, appBaseUrl: 'http://admin.test', appOrigin: 'http://admin.test', databaseUrl: 'mysql://redacted', cloudflareAuthMode: 'test', adminAllowedEmails: ['admin@example.com'],
  };
  const app = express();
  app.use(requestContext);
  app.use(securityHeaders(config));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/test`);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(response.headers.get('strict-transport-security'), null);
  });
});

test('production errors do not expose stack traces', async () => {
  const app = express();
  app.use(requestContext);
  app.get('/boom', () => { throw new Error('sensitive stack marker'); });
  app.use(errorHandler('production'));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/boom`);
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes('sensitive stack marker'), false);
    assert.equal(text.includes('stack'), false);
  });
});
