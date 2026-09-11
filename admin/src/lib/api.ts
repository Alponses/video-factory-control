import type {
  AdminDashboardDto,
  AdminMeDto,
  ApiErrorDto,
  PublicationEditResultDto,
  PublicationPatchDto,
  SceneEditResultDto,
  ScenePatchDto,
  VideoDetailDto,
  VideoEditResultDto,
  VideoHistoryDto,
  VideoListDto,
  VideoPatchDto,
} from '@contracts';
import type { QueueRenderView, WorkerListView, WorkerMutationView, WorkerSecretView } from '../types/worker';

export class AdminApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await parseBody(response);
  if (!response.ok) {
    const apiBody = body as ApiErrorDto | null;
    const code = apiBody?.error?.code ?? `HTTP_${response.status}`;
    const message = apiBody?.error?.message ?? (response.statusText || 'Request failed');
    const requestId = apiBody?.error?.requestId ?? response.headers.get('x-request-id') ?? undefined;
    throw new AdminApiError(response.status, code, message, requestId);
  }
  return body as T;
}

export const adminApi = {
  me: () => request<AdminMeDto>('/api/admin/me'),
  dashboard: () => request<AdminDashboardDto>('/api/admin/dashboard'),
  workers: () => request<WorkerListView>('/api/admin/workers'),
  createWorker: (workerId: string) => request<WorkerSecretView>('/api/admin/workers', { method: 'POST', body: JSON.stringify({ workerId }) }),
  rotateWorkerSecret: (workerId: string) => request<WorkerSecretView>(`/api/admin/workers/${encodeURIComponent(workerId)}/rotate-secret`, { method: 'POST', body: '{}' }),
  revokeWorker: (workerId: string) => request<WorkerMutationView>(`/api/admin/workers/${encodeURIComponent(workerId)}/revoke`, { method: 'POST', body: '{}' }),
  enableWorker: (workerId: string) => request<WorkerMutationView>(`/api/admin/workers/${encodeURIComponent(workerId)}/enable`, { method: 'POST', body: '{}' }),
  videos: (query: URLSearchParams) => request<VideoListDto>(`/api/admin/videos?${query.toString()}`),
  video: (id: string) => request<VideoDetailDto>(`/api/admin/videos/${encodeURIComponent(id)}`),
  history: (id: string) => request<VideoHistoryDto>(`/api/admin/videos/${encodeURIComponent(id)}/history`),
  queueRender: (id: string, expectedVersion: number) => request<QueueRenderView>(`/api/admin/videos/${encodeURIComponent(id)}/queue-render`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  rerender: (id: string, expectedVersion: number) => request<QueueRenderView>(`/api/admin/videos/${encodeURIComponent(id)}/rerender`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  updateVideo: (id: string, body: VideoPatchDto) => request<VideoEditResultDto>(`/api/admin/videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateScene: (id: string, position: number, body: ScenePatchDto) => request<SceneEditResultDto>(`/api/admin/videos/${encodeURIComponent(id)}/scenes/${position}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updatePublication: (id: string, body: PublicationPatchDto) => request<PublicationEditResultDto>(`/api/admin/publications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
};
