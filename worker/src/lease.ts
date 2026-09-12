import type { ControlPlaneClient } from './api-client.js';
import { log } from './logger.js';

export function startLeaseRenewal(client: ControlPlaneClient, workerId: string, videoId: string, leaseToken: string, intervalMs: number, signal: AbortSignal): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (stopped || signal.aborted) return;
    timer = setTimeout(() => { void renew(); }, intervalMs);
  };
  const renew = async () => {
    if (stopped || signal.aborted) return;
    try {
      await client.renew(videoId, leaseToken);
      log('info', { workerId, event: 'lease_renewed', videoId });
    } catch {
      log('error', { workerId, event: 'lease_renew_failed', videoId, errorCode: 'LEASE_RENEW_FAILED' });
    } finally {
      schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
