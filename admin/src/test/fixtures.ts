import type { AdminDashboardDto, VideoDetailDto, VideoListDto } from '@contracts';
import type { WorkerEffectiveStatus, WorkerListView, WorkerView } from '../types/worker';

export const dashboardFixture: AdminDashboardDto = {
  totalVideos: 11,
  totalsByStatus: { DRAFT: 1, READY: 2, QUEUED: 0, RENDERING: 0, QA: 1, APPROVED: 2, SCHEDULED: 0, PUBLISHING: 0, PUBLISHED: 5, FAILED: 0, CANCELLED: 0 },
  legacyIncomplete: 1,
  recentVideos: [{ id: 'religion-000011', title: 'Una pausa', category: 'fe', status: 'APPROVED', legacyIncomplete: false, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T11:00:00.000Z' }],
  recentEvents: [],
};

export function workerFixture(id = 'imac-01', effectiveStatus: WorkerEffectiveStatus = 'ONLINE', overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    id,
    effectiveStatus,
    agentVersion: '5.0.0-phase.4',
    rendererVersion: 'short-video-maker-local',
    lastHeartbeatAt: '2026-09-11T20:00:00.000Z',
    currentVideoId: effectiveStatus === 'BUSY' ? 'religion-000011' : null,
    progress: effectiveStatus === 'BUSY' ? 42 : null,
    lastError: null,
    secretVersion: 1,
    createdAt: '2026-09-11T19:00:00.000Z',
    updatedAt: '2026-09-11T20:00:00.000Z',
    ...overrides,
  };
}

export const workerListFixture: WorkerListView = {
  items: [],
  offlineThresholdSeconds: 60,
};

export const listFixture: VideoListDto = {
  items: [{ id: 'religion-000011', slug: 'una-pausa', title: 'Una pausa', category: 'fe', status: 'APPROVED', version: 1, legacyIncomplete: false, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T11:00:00.000Z', sceneCount: 16, durationSeconds: 65.2, publications: [{ id: 'pub-1', platform: 'TIKTOK', status: 'DRAFT' }], hasThumbnailReference: false }],
  page: 1, pageSize: 25, total: 1, categories: ['fe'],
};

export function detailFixture(id = 'religion-000011', sceneCount = 1): VideoDetailDto {
  return {
    video: { id, channelId: 'religion-es', slug: id, title: 'Una pausa con fe', category: 'fe', status: 'APPROVED', legacyStatus: null, schemaVersion: 3, legacyIncomplete: id === 'religion-000001', version: 4, primaryKeyword: 'oracion', secondaryKeywords: ['fe', 'paz'], searchIntent: 'oración de noche', hookText: 'Respira un momento', hookType: 'calm', closing: 'Descansa', cta: 'Comparte', question: '¿Qué agradeces hoy?', pinnedComment: 'Amén', wordCount: 180, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T11:00:00.000Z' },
    channel: { id: 'religion-es', displayName: 'Pausa con Fe', language: 'es-MX', profiles: [{ id: 'profile-1', platform: 'TIKTOK', displayName: 'Pausa con Fe', username: '@pausaconfe', description: 'Reflexiones y oraciones' }] },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({ id: `scene-${index}`, position: index, text: `Scene text ${index}`, searchTerms: ['paz', 'noche'], version: 1, updatedAt: '2026-09-10T11:00:00.000Z' })),
    publications: [{ id: 'pub-1', platform: 'TIKTOK', status: 'DRAFT', legacyStatus: null, version: 2, title: 'TikTok title', caption: 'Caption', description: 'Description', hashtags: ['#Fe', '#Paz'], cta: 'Comparte', pinnedComment: 'Amén', platformId: null, url: null, scheduledAt: null, publishedAt: null, updatedAt: '2026-09-10T11:00:00.000Z', metrics: [], snapshots: [] }],
    renderAttempts: [{ id: 'render-1', attempt: 1, status: 'SUCCEEDED', workerId: null, workerLabel: 'legacy-imac', rendererVideoId: 'renderer-1', startedAt: '2026-09-10T10:00:00.000Z', finishedAt: '2026-09-10T10:01:05.000Z', durationSeconds: 65, width: 1080, height: 1920, hasAudio: true, error: null }],
    qa: [{ id: 'qa-1', attempt: 1, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: true, createdAt: '2026-09-10T11:00:00.000Z' }],
    legacyAssets: [{ id: 'asset-1', kind: 'VIDEO', status: 'READY', storageProvider: 'LEGACY_LOCAL', localPath: '/legacy/video.mp4', mimeType: 'video/mp4', size: '1000', createdAt: '2026-09-10T11:00:00.000Z' }],
  };
}
