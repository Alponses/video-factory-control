import type { WorkerConfig } from './config.js';

export interface WorkerJob {
  video: { id: string; title: string; category: string };
  scenes: Array<{ position: number; text: string; searchTerms: string[] }>;
  renderConfig: unknown;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface CompletionPayload {
  rendererVideoId: string;
  localFile: string;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  qa: {
    durationPassed: boolean;
    resolutionPassed: boolean;
    audioPassed: boolean;
    captionsPassed: boolean | null;
    passed: boolean;
    raw: Record<string, unknown>;
  };
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error instanceof TypeError) return true;
  return /^HTTP_5\d\d$/.test(error.message) || error.message === 'HTTP_429';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ControlPlaneClient {
  constructor(private readonly config: WorkerConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Worker-Id': this.config.workerId,
      Authorization: `Bearer ${this.config.workerSecret}`,
      ...extra,
    };
    if (this.config.cfAccessClientId && this.config.cfAccessClientSecret) {
      headers['CF-Access-Client-Id'] = this.config.cfAccessClientId;
      headers['CF-Access-Client-Secret'] = this.config.cfAccessClientSecret;
    }
    if (this.config.cfAccessJwtAssertion) headers['Cf-Access-Jwt-Assertion'] = this.config.cfAccessJwtAssertion;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);
    try {
      const response = await fetch(`${this.config.videoFactoryUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: this.headers({ ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }),
      });
      if (response.status === 204) return null;
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const error = body.error as Record<string, unknown> | undefined;
        const code = typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`;
        throw new Error(code);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async finalizationRequest<T>(path: string, leaseToken: string, idempotencyKey: string, body: unknown): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.request<T>(path, {
          method: 'POST',
          headers: { 'X-Worker-Lease': leaseToken, 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !retryable(error)) throw error;
        await pause(100 * attempt);
      }
    }
    throw lastError;
  }

  heartbeat(input: { agentVersion: string; rendererVersion: string | null; currentVideoId: string | null; progress: number | null; lastError: string | null }): Promise<unknown> {
    return this.request('/api/worker/heartbeat', { method: 'POST', body: JSON.stringify(input) });
  }

  claim(): Promise<WorkerJob | null> {
    return this.request<WorkerJob>('/api/worker/jobs/claim', { method: 'POST', body: '{}' });
  }

  progress(videoId: string, leaseToken: string, progress: number, phase: 'RENDERING' | 'QA' = 'RENDERING'): Promise<unknown> {
    return this.request(`/api/worker/jobs/${encodeURIComponent(videoId)}/progress`, { method: 'POST', headers: { 'X-Worker-Lease': leaseToken }, body: JSON.stringify({ progress, phase }) });
  }

  renew(videoId: string, leaseToken: string): Promise<unknown> {
    return this.request(`/api/worker/jobs/${encodeURIComponent(videoId)}/renew`, { method: 'POST', headers: { 'X-Worker-Lease': leaseToken }, body: '{}' });
  }

  complete(videoId: string, leaseToken: string, idempotencyKey: string, payload: CompletionPayload): Promise<unknown> {
    return this.finalizationRequest(`/api/worker/jobs/${encodeURIComponent(videoId)}/complete`, leaseToken, idempotencyKey, payload);
  }

  fail(videoId: string, leaseToken: string, idempotencyKey: string, errorCode: string, safeErrorMessage: string): Promise<unknown> {
    return this.finalizationRequest(`/api/worker/jobs/${encodeURIComponent(videoId)}/fail`, leaseToken, idempotencyKey, { errorCode, safeErrorMessage: safeErrorMessage.slice(0, 1000) });
  }
}
