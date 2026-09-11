export type WorkerEffectiveStatusDto = 'ONLINE' | 'OFFLINE' | 'BUSY' | 'DISABLED';

export interface WorkerDto {
  id: string;
  effectiveStatus: WorkerEffectiveStatusDto;
  agentVersion: string | null;
  rendererVersion: string | null;
  lastHeartbeatAt: string | null;
  currentVideoId: string | null;
  progress: number | null;
  lastError: string | null;
  secretVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerListDto { items: WorkerDto[]; offlineThresholdSeconds: number }
export interface WorkerSecretResultDto { worker: WorkerDto; secret: string }
export interface WorkerMutationResultDto { worker: WorkerDto }

export interface WorkerJobSceneDto { position: number; text: string; searchTerms: string[] }
export interface WorkerJobDto {
  video: { id: string; title: string; category: string };
  scenes: WorkerJobSceneDto[];
  renderConfig: unknown;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface WorkerHeartbeatResultDto { workerId: string; acceptedAt: string }
export interface WorkerProgressResultDto { videoId: string; progress: number; phase: 'RENDERING' | 'QA' }
export interface WorkerRenewResultDto { videoId: string; leaseExpiresAt: string }
export interface WorkerCompletionResultDto { videoId: string; attempt: number; videoStatus: 'APPROVED' | 'FAILED'; renderStatus: 'SUCCEEDED'; qaPassed: boolean }
export interface WorkerFailureResultDto { videoId: string; attempt: number; videoStatus: 'FAILED'; renderStatus: 'FAILED' }
export interface QueueRenderResultDto { id: string; status: 'QUEUED'; version: number }
