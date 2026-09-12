export type WorkerEffectiveStatus = 'ONLINE' | 'OFFLINE' | 'BUSY' | 'DISABLED';

export interface WorkerView {
  id: string;
  effectiveStatus: WorkerEffectiveStatus;
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

export interface WorkerListView {
  items: WorkerView[];
  offlineThresholdSeconds: number;
}

export interface WorkerSecretView {
  worker: WorkerView;
  secret: string;
}

export interface WorkerMutationView {
  worker: WorkerView;
}

export interface QueueRenderView {
  id: string;
  status: 'QUEUED';
  version: number;
}
