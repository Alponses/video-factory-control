import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RendererHealth { healthy: boolean; version: string | null }
export interface RendererStatus { status: string }

export class RendererClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${pathname}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<RendererHealth> {
    try {
      const response = await this.request('/health');
      if (!response.ok) return { healthy: false, version: null };
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return { healthy: true, version: typeof body.version === 'string' ? body.version : null };
    } catch {
      return { healthy: false, version: null };
    }
  }

  async createVideo(scenes: Array<{ text: string; searchTerms: string[] }>, renderConfig: unknown): Promise<string> {
    const response = await this.request('/api/short-video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenes, config: renderConfig ?? {} }),
    });
    if (!response.ok) throw new Error(`RENDERER_CREATE_HTTP_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.videoId !== 'string' || !body.videoId) throw new Error('RENDERER_VIDEO_ID_MISSING');
    return body.videoId;
  }

  async status(videoId: string): Promise<RendererStatus> {
    const response = await this.request(`/api/short-video/${encodeURIComponent(videoId)}/status`);
    if (!response.ok) throw new Error(`RENDERER_STATUS_HTTP_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.status !== 'string') throw new Error('RENDERER_STATUS_INVALID');
    return { status: body.status };
  }

  async download(videoId: string, outputDir: string, logicalName: string): Promise<{ absolutePath: string; logicalPath: string }> {
    const response = await this.request(`/api/short-video/${encodeURIComponent(videoId)}`);
    if (!response.ok) throw new Error(`RENDERER_DOWNLOAD_HTTP_${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const absolutePath = path.resolve(outputDir, logicalName);
    await writeFile(absolutePath, data, { mode: 0o600 });
    return { absolutePath, logicalPath: `worker-output/${logicalName}` };
  }
}
