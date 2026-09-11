import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { RendererClient } from '../src/renderer-client.js';

async function withRenderer(handler: http.RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  try { await fn(`http://127.0.0.1:${address.port}`); } finally { server.close(); await once(server, 'close'); }
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
  await withRenderer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status })); }, async (baseUrl) => {
    const client = new RendererClient(baseUrl, 1000);
    assert.equal((await client.status('v')).status, 'processing');
    status = 'ready'; assert.equal((await client.status('v')).status, 'ready');
    status = 'failed'; assert.equal((await client.status('v')).status, 'failed');
  });
});

test('renderer offline health is false', async () => {
  const client = new RendererClient('http://127.0.0.1:9', 100);
  assert.equal((await client.health()).healthy, false);
});

test('renderer request times out', async () => {
  await withRenderer((_req, _res) => {}, async (baseUrl) => {
    const client = new RendererClient(baseUrl, 30);
    await assert.rejects(() => client.status('slow'));
  });
});
