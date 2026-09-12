import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind } from '@prisma/client';
import { loadConfig, type AppConfig, type R2Config } from '../../src/config.js';
import { redact } from '../../src/http/logger.js';
import { productionCsp } from '../../src/http/security.js';
import { safeOriginalFilename, validateAssetInput, videoObjectKey } from '../../src/storage/asset-policy.js';
import { AwsR2Storage } from '../../src/storage/r2.js';

const r2: R2Config = {
  accountId: 'abc123', accessKeyId: 'ACCESS_KEY_MUST_NOT_LEAK', secretAccessKey: 'SECRET_MUST_NOT_LEAK', bucket: 'private-video-factory',
  endpoint: 'https://abc123.r2.cloudflarestorage.com', origin: 'https://abc123.r2.cloudflarestorage.com', presignTtlSeconds: 300,
  singleUploadThresholdBytes: 104857600, multipartPartSizeBytes: 16777216,
};

test('AWS SDK presigns R2 PUT locally with bounded TTL and signed Content-Type', async () => {
  const storage = new AwsR2Storage(r2);
  const url = await storage.presignPut('channels/c/videos/v/assets/a/video.mp4', 'video/mp4', 300);
  assert.match(url, /^https:\/\/abc123\.r2\.cloudflarestorage\.com\//);
  assert.match(url, /X-Amz-Expires=300/);
  assert.match(decodeURIComponent(url), /X-Amz-SignedHeaders=.*content-type/i);
  assert.equal(url.includes(r2.secretAccessKey), false);
  assert.equal(url.includes('SECRET_MUST_NOT_LEAK'), false);
});

test('asset policy rejects active content and server object key ignores supplied filename', () => {
  assert.throws(() => validateAssetInput(AssetKind.COVER, 'image/svg+xml', 100n), /MIME type is not allowed/);
  assert.throws(() => validateAssetInput(AssetKind.VIDEO, 'text/html', 100n), /MIME type is not allowed/);
  const names = ['../../evil.mp4', 'foo/bar.mp4', '%2e%2e.mp4', 'évil/../video.mp4'];
  for (const name of names) {
    const normalized = safeOriginalFilename(name);
    assert.ok(normalized === null || (!normalized.includes('/') && !normalized.includes('\\')));
    const key = videoObjectKey('channel-id', 'video-id', 'asset-id', AssetKind.VIDEO, 'video/mp4');
    assert.equal(key, 'channels/channel-id/videos/video-id/assets/asset-id/video.mp4');
    assert.equal(key.includes(name), false);
  }
});

test('redaction strips signed URL fields and X-Amz query credentials', () => {
  const signed = 'https://abc123.r2.cloudflarestorage.com/bucket/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=hidden&X-Amz-Signature=deadbeef';
  const value = redact({ presignedUrl: signed, uploadUrl: signed, downloadUrl: signed, safeUrl: signed, 'X-Amz-Security-Token': 'hidden' }) as Record<string, unknown>;
  assert.equal(value.presignedUrl, '[REDACTED]');
  assert.equal(value.uploadUrl, '[REDACTED]');
  assert.equal(value.downloadUrl, '[REDACTED]');
  assert.equal(value['X-Amz-Security-Token'], '[REDACTED]');
  assert.equal(String(value.safeUrl).includes('X-Amz-Signature'), false);
  assert.equal(String(value.safeUrl).includes('X-Amz-Credential'), false);
});

test('production CSP permits only self plus exact configured R2 origin with no wildcard/unsafe directives', () => {
  const config: AppConfig = { nodeEnv: 'production', port: 3000, appBaseUrl: 'https://factory.norvian.io', appOrigin: 'https://factory.norvian.io', databaseUrl: 'mysql://redacted', cloudflareAuthMode: 'remote', cloudflareTeamDomain: 'https://team.cloudflareaccess.com', cloudflareAdminAccessAud: 'admin-aud', cloudflareWorkerAccessAud: 'worker-aud', adminAllowedEmails: ['admin@example.com'], r2 };
  const csp = productionCsp(config);
  assert.match(csp, /connect-src 'self' https:\/\/abc123\.r2\.cloudflarestorage\.com/);
  assert.match(csp, /img-src 'self' data: https:\/\/abc123\.r2\.cloudflarestorage\.com/);
  assert.match(csp, /media-src 'self' https:\/\/abc123\.r2\.cloudflarestorage\.com/);
  assert.equal(csp.includes('*.cloudflarestorage.com'), false);
  assert.equal(csp.includes('https: *'), false);
  assert.equal(csp.includes("'unsafe-inline'"), false);
  assert.equal(csp.includes("'unsafe-eval'"), false);
});

test('R2 production configuration fails closed if credentials are partial and derives S3 endpoint when complete', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', APP_BASE_URL: 'http://admin.test', DATABASE_URL: 'mysql://example.invalid/v5', CLOUDFLARE_AUTH_MODE: 'test', ADMIN_ALLOWED_EMAILS: 'admin@example.com', R2_ACCOUNT_ID: 'abc' }), /must be configured together/);
  const config = loadConfig({ NODE_ENV: 'test', APP_BASE_URL: 'http://admin.test', DATABASE_URL: 'mysql://example.invalid/v5', CLOUDFLARE_AUTH_MODE: 'test', ADMIN_ALLOWED_EMAILS: 'admin@example.com', R2_ACCOUNT_ID: 'abc', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'bucket' });
  assert.equal(config.r2?.endpoint, 'https://abc.r2.cloudflarestorage.com');
  assert.equal(config.r2?.presignTtlSeconds, 300);
  assert.equal(config.r2?.multipartPartSizeBytes, 16777216);
});
