import type { WorkerConfig } from './config.js';
import type { ControlPlaneClient } from './api-client.js';
import type { RendererClient } from './renderer-client.js';
import type { AgentState } from './heartbeat.js';
import { runJob } from './job-runner.js';
import { log } from './logger.js';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function jitter(base: number): number {
  const delta = base * 0.2;
  return Math.max(1000, Math.round(base - delta + Math.random() * delta * 2));
}

export async function runClaimLoop(config: WorkerConfig, client: ControlPlaneClient, renderer: RendererClient, state: AgentState, signal: AbortSignal): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const health = await renderer.health();
      state.rendererVersion = health.version;
      if (!health.healthy) {
        state.lastError = 'RENDERER_OFFLINE';
        await wait(jitter(config.claimIntervalMs), signal);
        continue;
      }
      if (state.lastError === 'RENDERER_OFFLINE') state.lastError = null;
      const job = await client.claim();
      failures = 0;
      if (job) await runJob(config, client, renderer, state, job, signal);
      else await wait(jitter(config.claimIntervalMs), signal);
    } catch {
      failures += 1;
      state.lastError = 'CONTROL_PLANE_UNAVAILABLE';
      const backoff = Math.min(60_000, config.claimIntervalMs * 2 ** Math.min(failures, 4));
      log('warn', { workerId: config.workerId, event: 'claim_failed', errorCode: 'CONTROL_PLANE_UNAVAILABLE' });
      await wait(jitter(backoff), signal);
    }
  }
}
