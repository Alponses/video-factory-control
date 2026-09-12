import { readFileSync } from 'node:fs';
import { loadWorkerConfig } from './config.js';
import { ControlPlaneClient } from './api-client.js';
import { RendererClient } from './renderer-client.js';
import { startHeartbeat, type AgentState } from './heartbeat.js';
import { runClaimLoop } from './claim-loop.js';
import { createShutdown } from './shutdown.js';
import { log } from './logger.js';

function agentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const config = loadWorkerConfig();
const version = agentVersion();
const api = new ControlPlaneClient(config);
const renderer = new RendererClient(config.rendererUrl, config.rendererTimeoutMs);
const shutdown = createShutdown(config.workerId);
const state: AgentState = { currentVideoId: null, progress: null, lastError: null, rendererVersion: null };
const health = await renderer.health();
state.rendererVersion = health.version;
state.lastError = health.healthy ? null : 'RENDERER_OFFLINE';

process.stdout.write(`Video Factory Worker\nWorker: ${config.workerId}\nAPI: ${new URL(config.videoFactoryUrl).host}\nRenderer: ${health.healthy ? 'healthy' : 'offline'}\nAgent version: ${version}\n`);
log('info', { workerId: config.workerId, event: 'worker_started' });

const stopHeartbeat = startHeartbeat(api, renderer, config.workerId, version, state, config.heartbeatIntervalMs, shutdown.signal);
try {
  await runClaimLoop(config, api, renderer, state, shutdown.signal);
} finally {
  stopHeartbeat();
  log('info', { workerId: config.workerId, event: 'worker_stopped', videoId: state.currentVideoId ?? undefined });
}
