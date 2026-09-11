import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '../src/config.js';
import { ControlPlaneClient, type CompletionPayload } from '../src/api-client.js';

const config: WorkerConfig = {
  videoFactoryUrl: 'https://factory.example.test',
  workerId: 'imac-01',
  workerSecret: `vfws_${'a'.repeat(43)}`,
  cfAccessClientId: 'client-id',
  cfAccessClientSecret: 'client-secret',
  cfAccessJwtAssertion: 'signed-worker-jwt',
  rendererUrl: 'http://127.0.0.1:3123',
  heartbeatIntervalMs: 20_000,
  claimIntervalMs: 15_000,
  leaseRenewIntervalMs: 30_000,
  apiTimeoutMs: 15,
  rendererTimeoutMs: 1000,
  rendererPollIntervalMs: 1000,
  outputDir: './output',
  r2UploadMaxRetries: 3,
  deleteLocalAfterDurableUpload: false,
};

function timeoutUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return reject(new Error('missing abort signal'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

const completion: CompletionPayload = {
  rendererVideoId: 'renderer-1',
  localFile: 'worker-output/video.mp4',
  outputAssetId: 'durable-asset-1',
  durationSeconds: 61,
  width: 1080,
  height: 1920,
  hasAudio: true,
  qa: { durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null, passed: true, raw: {} },
};

test('complete retries a lost response with the exact same Idempotency-Key', async () => {
  const originalFetch = globalThis.fetch;
  const keys: Array<string | undefined> = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    keys.push(header(init, 'Idempotency-Key'));
    if (calls === 1) return timeoutUntilAborted(init?.signal);
    return new Response(JSON.stringify({ videoId: 'religion-000011', attempt: 1, videoStatus: 'APPROVED', renderStatus: 'SUCCEEDED', qaPassed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new ControlPlaneClient(config);
    await client.complete('religion-000011', 'lease-token', 'complete-stable-key', completion);
    assert.equal(calls, 2);
    assert.deepEqual(keys, ['complete-stable-key', 'complete-stable-key']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fail retries a timeout with the exact same Idempotency-Key', async () => {
  const originalFetch = globalThis.fetch;
  const keys: Array<string | undefined> = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    keys.push(header(init, 'Idempotency-Key'));
    if (calls === 1) return timeoutUntilAborted(init?.signal);
    return new Response(JSON.stringify({ videoId: 'religion-000011', attempt: 1, videoStatus: 'FAILED', renderStatus: 'FAILED' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new ControlPlaneClient(config);
    await client.fail('religion-000011', 'lease-token', 'fail-stable-key', 'RENDERER_FAILED', 'safe failure');
    assert.equal(calls, 2);
    assert.deepEqual(keys, ['fail-stable-key', 'fail-stable-key']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-retryable idempotency conflicts are not retried', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'conflict' } }), { status: 409, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new ControlPlaneClient(config);
    await assert.rejects(() => client.complete('religion-000011', 'lease-token', 'conflict-key', completion), /IDEMPOTENCY_CONFLICT/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker upload session request carries lease + idempotency but no R2 permanent credential', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ sessionId: 'session-1', assetId: 'asset-1', mode: 'SINGLE', status: 'UPLOADING', uploadUrl: 'https://r2.example/object?X-Amz-Signature=short', requiredHeaders: { 'Content-Type': 'video/mp4' }, expiresAt: new Date().toISOString(), sessionExpiresAt: new Date().toISOString(), partSizeBytes: null }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new ControlPlaneClient(config);
    await client.createOutputUpload('video-1', 'lease-1', 'asset-create-stable', { mimeType: 'video/mp4', size: '1024', sha256: 'a'.repeat(64), originalFilename: 'video.mp4' });
    assert.equal(header(captured, 'X-Worker-Lease'), 'lease-1');
    assert.equal(header(captured, 'Idempotency-Key'), 'asset-create-stable');
    const serialized = JSON.stringify(captured);
    assert.equal(serialized.includes('R2_ACCESS_KEY_ID'), false);
    assert.equal(serialized.includes('R2_SECRET_ACCESS_KEY'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
