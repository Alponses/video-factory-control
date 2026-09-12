import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { generateKeyPair } from 'jose';
import type { AppConfig } from '../../src/config.js';
import { createAdminAuth } from '../../src/http/auth.js';
import { errorHandler } from '../../src/http/errors.js';
import { requestContext } from '../../src/http/security.js';
import { createTestAuthFixture, TEST_ALLOWED_EMAIL, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/auth.js';
import { withServer } from '../helpers/http.js';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  appBaseUrl: 'http://admin.test',
  appOrigin: 'http://admin.test',
  databaseUrl: 'mysql://redacted',
  cloudflareAuthMode: 'test',
  adminAllowedEmails: [TEST_ALLOWED_EMAIL],
};

function protectedApp(fixture: Awaited<ReturnType<typeof createTestAuthFixture>>) {
  const app = express();
  app.use(requestContext);
  app.use(createAdminAuth(config, { keyResolver: fixture.keyResolver, issuer: TEST_ISSUER, audience: TEST_AUDIENCE }));
  app.get('/protected', (req, res) => res.json({ email: req.actor?.email }));
  app.use(errorHandler('test'));
  return app;
}

async function statusFor(token?: string): Promise<number> {
  const fixture = await createTestAuthFixture();
  const app = protectedApp(fixture);
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/protected`, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
    return response.status;
  });
}

test('missing JWT -> 401', async () => {
  assert.equal(await statusFor(), 401);
});

test('malformed JWT -> 401', async () => {
  assert.equal(await statusFor('not-a-jwt'), 401);
});

test('invalid signature -> 401', async () => {
  const fixture = await createTestAuthFixture();
  const other = await generateKeyPair('RS256');
  const token = await fixture.sign({ privateKey: other.privateKey });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 401);
});

test('expired JWT -> 401', async () => {
  const fixture = await createTestAuthFixture();
  const token = await fixture.sign({ expiresInSeconds: -10 });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 401);
});

test('wrong issuer -> 401', async () => {
  const fixture = await createTestAuthFixture();
  const token = await fixture.sign({ issuer: 'https://wrong.cloudflareaccess.com' });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 401);
});

test('wrong audience -> 401', async () => {
  const fixture = await createTestAuthFixture();
  const token = await fixture.sign({ audience: 'wrong-audience' });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 401);
});

test('valid JWT wrong email -> 403', async () => {
  const fixture = await createTestAuthFixture();
  const token = await fixture.sign({ email: 'other@example.com' });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 403);
});

test('valid JWT allowed email -> authorized', async () => {
  const fixture = await createTestAuthFixture();
  const token = await fixture.sign({ email: 'ADMIN@EXAMPLE.COM' });
  const response = await withServer(protectedApp(fixture), (baseUrl) => fetch(`${baseUrl}/protected`, { headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: TEST_ALLOWED_EMAIL });
});
