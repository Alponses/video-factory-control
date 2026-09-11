import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetKind } from '@prisma/client';
import { loadConfig } from '../../src/config.js';
import { redact } from '../../src/http/logger.js';
import { expectedPartCount, safeOriginalFilename, videoObjectKey, VIDEO_MAX_BYTES } from '../../src/storage/asset-policy.js';

const baseEnv = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://admin.test',
  DATABASE_URL: 'mysql://example.invalid/v5',
  CLOUDFLARE_AUTH_MODE: 'test',
  ADMIN_ALLOWED_EMAILS: 'admin@example.com',
  R2_ACCOUNT_ID: 'abc123',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
};

test('R2 presign TTL is bounded, defaults to 300 and rejects zero/negative/excessive values', () => {
  assert.equal(loadConfig(baseEnv).r2?.presignTtlSeconds, 300);
  for (const value of ['0', '-1', '901', '999999999']) {
    assert.throws(() => loadConfig({ ...baseEnv, R2_PRESIGN_TTL_SECONDS: value }), /Invalid server configuration/);
  }
});

test('multipart part size is at least 5 MiB and single threshold must be positive', () => {
  assert.throws(() => loadConfig({ ...baseEnv, R2_MULTIPART_PART_SIZE_BYTES: String(5 * 1024 * 1024 - 1) }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...baseEnv, R2_SINGLE_UPLOAD_THRESHOLD_BYTES: '0' }), /Invalid server configuration/);
  const config = loadConfig({ ...baseEnv, R2_MULTIPART_PART_SIZE_BYTES: String(5 * 1024 * 1024) });
  assert.equal(config.r2?.multipartPartSizeBytes, 5 * 1024 * 1024);
  assert.ok(expectedPartCount(VIDEO_MAX_BYTES, config.r2!.multipartPartSizeBytes) <= 10_000);
  assert.throws(() => expectedPartCount(50_001n * 1024n * 1024n, 5 * 1024 * 1024), /exceed the allowed part count/);
});

test('production fails closed without full R2 credentials and rejects non-HTTPS R2 endpoints', () => {
  const productionBase = {
    NODE_ENV: 'production', APP_BASE_URL: 'https://factory.norvian.io', DATABASE_URL: 'mysql://example.invalid/v5',
    CLOUDFLARE_AUTH_MODE: 'remote', CLOUDFLARE_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', CLOUDFLARE_ADMIN_ACCESS_AUD: 'admin-aud',
    CLOUDFLARE_WORKER_ACCESS_AUD: 'worker-aud', ADMIN_ALLOWED_EMAILS: 'admin@example.com',
  };
  assert.throws(() => loadConfig(productionBase), /private R2 durable storage is required/);
  for (const endpoint of ['http://abc.r2.cloudflarestorage.com', 'javascript:alert(1)', 'data:text/plain,hi', 'file:///tmp/r2']) {
    assert.throws(() => loadConfig({ ...productionBase, R2_ACCOUNT_ID: 'abc', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'bucket', R2_ENDPOINT: endpoint }), /Invalid server configuration/);
  }
});

test('untrusted original filenames never influence the immutable object key', () => {
  const names = ['../../evil.mp4', '../foo', 'foo/bar.mp4', '%2e%2e', 'áéí_日本語.mp4', 'quote"name.mp4', "single'name.mp4", '..\\..\\evil.mp4'];
  const expected = videoObjectKey('channel-id', 'video-id', 'asset-id', AssetKind.VIDEO, 'video/mp4');
  assert.equal(expected, 'channels/channel-id/videos/video-id/assets/asset-id/video.mp4');
  for (const name of names) {
    const metadataName = safeOriginalFilename(name);
    assert.ok(metadataName === null || (!metadataName.includes('/') && !metadataName.includes('\\')));
    assert.equal(videoObjectKey('channel-id', 'video-id', 'asset-id', AssetKind.VIDEO, 'video/mp4'), expected);
    assert.equal(expected.includes(name), false);
  }
});

test('logger fully redacts every SigV4 query credential and signed URL field', () => {
  const signed = 'https://abc.r2.cloudflarestorage.com/bucket/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2Fscope&X-Amz-Date=20260911T220000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Security-Token=token-secret&X-Amz-Signature=deadbeefcafebabe';
  const output = redact({
    presignedUrl: signed,
    uploadUrl: signed,
    downloadUrl: signed,
    generic: signed,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'AKIA/scope',
    'X-Amz-Date': '20260911T220000Z',
    'X-Amz-Expires': '300',
    'X-Amz-Signature': 'deadbeefcafebabe',
    'X-Amz-SignedHeaders': 'host',
    'X-Amz-Security-Token': 'token-secret',
  });
  const serialized = JSON.stringify(output);
  for (const secret of ['AKIA/scope', 'token-secret', 'deadbeefcafebabe', 'X-Amz-Signature=', 'X-Amz-Credential=']) assert.equal(serialized.includes(secret), false);
  assert.equal((output as Record<string, unknown>).presignedUrl, '[REDACTED]');
  assert.match(String((output as Record<string, unknown>).generic), /\?\[REDACTED_PRESIGNED_QUERY\]$/);
});
