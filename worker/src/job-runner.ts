import { randomUUID } from 'node:crypto';
import type { WorkerConfig } from './config.js';
import type { ControlPlaneClient, WorkerJob } from './api-client.js';
import type { RendererClient } from './renderer-client.js';
import type { AgentState } from './heartbeat.js';
import { startLeaseRenewal } from './lease.js';
import { runQa } from './qa.js';
import { log } from './logger.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)) return error.message.slice(0, 64);
  return 'WORKER_JOB_FAILED';
}

export async function runJob(config: WorkerConfig, client: ControlPlaneClient, renderer: RendererClient, state: AgentState, job: WorkerJob, signal: AbortSignal): Promise<void> {
  state.currentVideoId = job.video.id;
  state.progress = 0;
  state.lastError = null;
  const stopRenewal = startLeaseRenewal(client, config.workerId, job.video.id, job.leaseToken, config.leaseRenewIntervalMs, signal);
  const started = Date.now();
  try {
    if (signal.aborted) return;
    const rendererVideoId = await renderer.createVideo(job.scenes.map(({ text, searchTerms }) => ({ text, searchTerms })), job.renderConfig);
    state.progress = 10;
    await client.progress(job.video.id, job.leaseToken, 10);
    while (!signal.aborted) {
      const status = await renderer.status(rendererVideoId);
      if (status.status === 'ready' || status.status === 'completed') break;
      if (status.status === 'failed') throw new Error('RENDERER_FAILED');
      state.progress = Math.max(state.progress ?? 10, 20);
      await sleep(config.rendererPollIntervalMs, signal);
    }
    if (signal.aborted) return;
    state.progress = 80;
    await client.progress(job.video.id, job.leaseToken, 80);
    const filename = `${job.video.id}-attempt-${job.attempt}.mp4`;
    const output = await renderer.download(rendererVideoId, config.outputDir, filename);
    state.progress = 90;
    await client.progress(job.video.id, job.leaseToken, 90, 'QA');
    const qa = await runQa(output.absolutePath);
    await client.complete(job.video.id, job.leaseToken, randomUUID(), {
      rendererVideoId,
      localFile: output.logicalPath,
      durationSeconds: qa.durationSeconds,
      width: qa.width,
      height: qa.height,
      hasAudio: qa.hasAudio,
      qa: {
        durationPassed: qa.durationPassed,
        resolutionPassed: qa.resolutionPassed,
        audioPassed: qa.audioPassed,
        captionsPassed: qa.captionsPassed,
        passed: qa.passed,
        raw: qa.raw,
      },
    });
    state.progress = 100;
    log('info', { workerId: config.workerId, event: 'job_completed', videoId: job.video.id, attempt: job.attempt, progress: 100, durationMs: Date.now() - started });
  } catch (error) {
    const code = errorCode(error);
    state.lastError = code;
    if (!signal.aborted) {
      try {
        await client.fail(job.video.id, job.leaseToken, randomUUID(), code, 'Local render or QA failed');
      } catch {
        log('error', { workerId: config.workerId, event: 'job_fail_report_failed', videoId: job.video.id, attempt: job.attempt, errorCode: code });
      }
    }
    log('error', { workerId: config.workerId, event: 'job_failed', videoId: job.video.id, attempt: job.attempt, durationMs: Date.now() - started, errorCode: code });
  } finally {
    stopRenewal();
    state.currentVideoId = null;
    state.progress = null;
  }
}
