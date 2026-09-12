import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ControlPlaneClient, UploadSession } from '../src/api-client.js';
import type { WorkerConfig } from '../src/config.js';
import { uploadDurableOutput } from '../src/storage-upload.js';

const config: WorkerConfig = {
  videoFactoryUrl: 'https://factory.example.test', workerId: 'imac-01', workerSecret: `vfws_${'a'.repeat(43)}`,
  cfAccessClientId: null, cfAccessClientSecret: null, cfAccessJwtAssertion: null, rendererUrl: 'http://127.0.0.1:3123',
  heartbeatIntervalMs: 20_000, claimIntervalMs: 15_000, leaseRenewIntervalMs: 30_000, apiTimeoutMs: 10_000,
  rendererTimeoutMs: 10_000, rendererPollIntervalMs: 2_000, outputDir: './output', r2UploadMaxRetries: 3, deleteLocalAfterDurableUpload: false,
};

function session(): UploadSession {
  return { sessionId: 'session-1', assetId: 'asset-1', mode: 'SINGLE', status: 'UPLOADING', uploadUrl: `https://r2.example/object?X-Amz-Signature=${Math.random()}`, requiredHeaders: { 'Content-Type': 'video/mp4' }, expiresAt: new Date(Date.now() + 300_000).toISOString(), sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), partSizeBytes: null };
}

test('worker direct upload retries authorization without re-creating rendered file and finalizes same logical asset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vf-phase5-'));
  const file = path.join(dir, 'render.mp4');
  await writeFile(file, Buffer.alloc(4096, 7));
  const originalFetch = globalThis.fetch;
  let putCalls = 0;
  let createCalls = 0;
  let finalizeCalls = 0;
  const client = {
    createOutputUpload: async () => { createCalls += 1; return session(); },
    finalizeUpload: async () => { finalizeCalls += 1; return { id: 'asset-1', status: 'READY', size: '4096', sha256: null }; },
    abortUpload: async () => undefined,
  } as unknown as ControlPlaneClient;
  globalThis.fetch = async () => {
    putCalls += 1;
    if (putCalls === 1) return new Response('', { status: 403 });
    return new Response('', { status: 200, headers: { etag: '"single"' } });
  };
  try {
    const before = await readFile(file);
    const result = await uploadDurableOutput(config, client, 'video-1', 'lease-1', file);
    const after = await readFile(file);
    assert.equal(result.assetId, 'asset-1');
    assert.equal(putCalls, 2);
    assert.equal(createCalls, 2);
    assert.equal(finalizeCalls, 1);
    assert.deepEqual(after, before);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('exhausted storage retries abort session and preserve local MP4', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vf-phase5-fail-'));
  const file = path.join(dir, 'render.mp4');
  await writeFile(file, Buffer.alloc(2048, 3));
  const originalFetch = globalThis.fetch;
  let abortCalls = 0;
  const client = {
    createOutputUpload: async () => session(),
    finalizeUpload: async () => { throw new Error('should not finalize'); },
    abortUpload: async () => { abortCalls += 1; },
  } as unknown as ControlPlaneClient;
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    await assert.rejects(() => uploadDurableOutput(config, client, 'video-1', 'lease-1', file), /R2_PUT_503/);
    assert.equal(abortCalls, 1);
    assert.equal((await readFile(file)).length, 2048);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
