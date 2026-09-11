import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RendererHealth { healthy: boolean; version: string | null }
export interface RendererStatus { status: string }

export class RendererClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private fetch(pathname: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${pathname}`, { ...init, signal });
  }

  async health(): Promise<RendererHealth> {
    try {
      return await this.withTimeout(async (signal) => {
        const response = await this.fetch('/health', signal);
        if (!response.ok) return { healthy: false, version: null };
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        return { healthy: true, version: typeof body.version === 'string' ? body.version : null };
      });
    } catch {
      return { healthy: false, version: null };
    }
  }

  async createVideo(scenes: Array<{ text: string; searchTerms: string[] }>, renderConfig: unknown): Promise<string> {
    return this.withTimeout(async (signal) => {
      const response = await this.fetch('/api/short-video', signal, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenes, config: renderConfig ?? {} }),
      });
      if (!response.ok) throw new Error(`RENDERER_CREATE_HTTP_${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.videoId !== 'string' || !body.videoId) throw new Error('RENDERER_VIDEO_ID_MISSING');
      return body.videoId;
    });
  }

  async status(videoId: string): Promise<RendererStatus> {
    return this.withTimeout(async (signal) => {
      const response = await this.fetch(`/api/short-video/${encodeURIComponent(videoId)}/status`, signal);
      if (!response.ok) throw new Error(`RENDERER_STATUS_HTTP_${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.status !== 'string') throw new Error('RENDERER_STATUS_INVALID');
      return { status: body.status };
    });
  }

  async download(videoId: string, outputDir: string, logicalName: string): Promise<{ absolutePath: string; logicalPath: string }> {
    const data = await this.withTimeout(async (signal) => {
      const response = await this.fetch(`/api/short-video/${encodeURIComponent(videoId)}`, signal);
      if (!response.ok) throw new Error(`RENDERER_DOWNLOAD_HTTP_${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const absolutePath = path.resolve(outputDir, logicalName);
    await writeFile(absolutePath, data, { mode: 0o600 });
    return { absolutePath, logicalPath: `worker-output/${logicalName}` };
  }
}
