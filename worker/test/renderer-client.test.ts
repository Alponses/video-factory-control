import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RendererClient } from '../src/renderer-client.js';

async function withRenderer(handler: http.RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
  }
}

function hangJson(res: http.ServerResponse, prefix = '{') {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(prefix);
}

test('renderer health and accepted render use real contract paths', async () => {
  const seen: string[] = [];
  await withRenderer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return void res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/api/short-video' && req.method === 'POST') return void res.end(JSON.stringify({ videoId: 'video-1' }));
    res.statusCode = 404; res.end('{}');
  }, async (baseUrl) => {
    const client = new RendererClient(baseUrl, 1000);
    assert.equal((await client.health()).healthy, true);
    assert.equal(await client.createVideo([{ text: 'hola', searchTerms: ['paz'] }], {}), 'video-1');
  });
  assert.deepEqual(seen, ['GET /health', 'POST /api/short-video']);
});

test('renderer status accepts processing, ready and failed values without inventing state', async () => {
  let status = 'processing';
  await withRenderer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status })); }, async (baseUrl) => {
    const client = new RendererClient(baseUrl, 1000);
    assert.equal((await client.status('v')).status, 'processing');
    status = 'ready'; assert.equal((await client.status('v')).status, 'ready');
    status = 'failed'; assert.equal((await client.status('v')).status, 'failed');
  });
});

test('renderer download uses the verified GET /api/short-video/:id contract and stores locally', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vf-renderer-'));
  try {
    await withRenderer((req, res) => {
      assert.equal(req.url, '/api/short-video/video-1');
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from('mp4-bytes'));
    }, async (baseUrl) => {
      const client = new RendererClient(baseUrl, 1000);
      const output = await client.download('video-1', tempDir, 'religion-000011-attempt-1.mp4');
      assert.equal(output.logicalPath, 'worker-output/religion-000011-attempt-1.mp4');
      assert.equal((await readFile(output.absolutePath)).toString(), 'mp4-bytes');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renderer offline health is false', async () => {
  const client = new RendererClient('http://127.0.0.1:9', 100);
  assert.equal((await client.health()).healthy, false);
});

test('health times out while reading a stalled response body', async () => {
  await withRenderer((_req, res) => hangJson(res, '{"status":"ok"'), async (baseUrl) => {
    const client = new RendererClient(baseUrl, 30);
    assert.equal((await client.health()).healthy, false);
  });
});

test('create times out while reading a stalled response body', async () => {
  await withRenderer((_req, res) => hangJson(res, '{"videoId":"unfinished'), async (baseUrl) => {
    const client = new RendererClient(baseUrl, 30);
    await assert.rejects(() => client.createVideo([{ text: 'hola', searchTerms: [] }], {}));
  });
});

test('status times out while reading a stalled response body', async () => {
  await withRenderer((_req, res) => hangJson(res, '{"status":"processing"'), async (baseUrl) => {
    const client = new RendererClient(baseUrl, 30);
    await assert.rejects(() => client.status('slow'));
  });
});

test('MP4 body streaming is bounded by the renderer timeout', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vf-renderer-timeout-'));
  try {
    await withRenderer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.from('partial-mp4'));
    }, async (baseUrl) => {
      const client = new RendererClient(baseUrl, 30);
      await assert.rejects(() => client.download('slow', tempDir, 'slow.mp4'));
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
