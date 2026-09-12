import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlPlaneClient } from '../src/api-client.js';
import type { RendererClient } from '../src/renderer-client.js';
import type { WorkerConfig } from '../src/config.js';
import { startHeartbeat, type AgentState } from '../src/heartbeat.js';
import { runClaimLoop } from '../src/claim-loop.js';

const config: WorkerConfig = {
  videoFactoryUrl: 'https://factory.example.test',
  workerId: 'imac-01',
  workerSecret: `vfws_${'a'.repeat(43)}`,
  cfAccessClientId: null,
  cfAccessClientSecret: null,
  cfAccessJwtAssertion: null,
  rendererUrl: 'http://127.0.0.1:3123',
  heartbeatIntervalMs: 10,
  claimIntervalMs: 10,
  leaseRenewIntervalMs: 30_000,
  apiTimeoutMs: 1000,
  rendererTimeoutMs: 1000,
  rendererPollIntervalMs: 1000,
  outputDir: './output',
  r2UploadMaxRetries: 3,
  deleteLocalAfterDurableUpload: false,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('renderer offline still sends heartbeat with RENDERER_OFFLINE', async () => {
  const heartbeats: unknown[] = [];
  const client = { heartbeat: async (payload: unknown) => { heartbeats.push(payload); } } as unknown as ControlPlaneClient;
  const renderer = { health: async () => ({ healthy: false, version: null }) } as unknown as RendererClient;
  const state: AgentState = { currentVideoId: null, progress: null, lastError: null, rendererVersion: null };
  const controller = new AbortController();
  const stop = startHeartbeat(client, renderer, 'imac-01', '5.0.0-phase.4', state, 10, controller.signal);
  await wait(25);
  controller.abort();
  stop();
  assert.ok(heartbeats.length >= 1);
  assert.equal((heartbeats[0] as { lastError: string }).lastError, 'RENDERER_OFFLINE');
  assert.equal(state.lastError, 'RENDERER_OFFLINE');
});

test('renderer offline prevents claim attempts', async () => {
  let claims = 0;
  const client = { claim: async () => { claims += 1; return null; } } as unknown as ControlPlaneClient;
  const renderer = { health: async () => ({ healthy: false, version: null }) } as unknown as RendererClient;
  const state: AgentState = { currentVideoId: null, progress: null, lastError: null, rendererVersion: null };
  const controller = new AbortController();
  const running = runClaimLoop(config, client, renderer, state, controller.signal);
  await wait(30);
  controller.abort();
  await running;
  assert.equal(claims, 0);
  assert.equal(state.lastError, 'RENDERER_OFFLINE');
});

test('worker resumes claim flow after renderer health returns', async () => {
  let healthChecks = 0;
  let claims = 0;
  const client = { claim: async () => { claims += 1; return null; } } as unknown as ControlPlaneClient;
  const renderer = {
    health: async () => {
      healthChecks += 1;
      return healthChecks === 1 ? { healthy: false, version: null } : { healthy: true, version: 'local' };
    },
  } as unknown as RendererClient;
  const state: AgentState = { currentVideoId: null, progress: null, lastError: null, rendererVersion: null };
  const controller = new AbortController();
  const running = runClaimLoop(config, client, renderer, state, controller.signal);
  await wait(1100);
  controller.abort();
  await running;
  assert.ok(healthChecks >= 2);
  assert.ok(claims >= 1);
  assert.notEqual(state.lastError, 'RENDERER_OFFLINE');
});
