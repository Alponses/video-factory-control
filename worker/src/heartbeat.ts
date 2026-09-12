import type { ControlPlaneClient } from './api-client.js';
import type { RendererClient } from './renderer-client.js';
import { log } from './logger.js';

export interface AgentState {
  currentVideoId: string | null;
  progress: number | null;
  lastError: string | null;
  rendererVersion: string | null;
}

export function startHeartbeat(client: ControlPlaneClient, renderer: RendererClient, workerId: string, agentVersion: string, state: AgentState, intervalMs: number, signal: AbortSignal): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    if (stopped || signal.aborted) return;
    const health = await renderer.health();
    state.rendererVersion = health.version;
    if (!health.healthy && !state.currentVideoId) state.lastError = 'RENDERER_OFFLINE';
    if (health.healthy && state.lastError === 'RENDERER_OFFLINE') state.lastError = null;
    try {
      await client.heartbeat({ agentVersion, rendererVersion: state.rendererVersion, currentVideoId: state.currentVideoId, progress: state.progress, lastError: state.lastError });
    } catch {
      log('warn', { workerId, event: 'heartbeat_failed', videoId: state.currentVideoId ?? undefined, errorCode: 'HEARTBEAT_FAILED' });
    } finally {
      if (!stopped && !signal.aborted) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
