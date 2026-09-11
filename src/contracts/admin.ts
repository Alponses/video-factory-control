export const VIDEO_STATUSES = ['DRAFT', 'READY', 'QUEUED', 'RENDERING', 'QA', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;
export type VideoStatusDto = typeof VIDEO_STATUSES[number];
export const PLATFORMS = ['TIKTOK', 'YOUTUBE', 'FACEBOOK'] as const;
export type PlatformDto = typeof PLATFORMS[number];

export interface AdminMeDto { email: string }
export interface DashboardVideoDto { id: string; title: string; category: string; status: VideoStatusDto; legacyIncomplete: boolean; createdAt: string; updatedAt: string }
export interface DashboardEventDto { id: string; videoId: string; type: string; fromStatus: string | null; toStatus: string | null; createdAt: string }
export interface AdminDashboardDto {
  totalVideos: number;
  totalsByStatus: Record<VideoStatusDto, number>;
  legacyIncomplete: number;
  recentVideos: DashboardVideoDto[];
  recentEvents: DashboardEventDto[];
}

export interface PublicationSummaryDto { id: string; platform: PlatformDto; status: string }
export interface VideoListItemDto {
  id: string;
  slug: string;
  title: string;
  category: string;
  status: VideoStatusDto;
  version: number;
  legacyIncomplete: boolean;
  createdAt: string;
  updatedAt: string;
  sceneCount: number;
  durationSeconds: number | null;
  publications: PublicationSummaryDto[];
  hasThumbnailReference: boolean;
}
export interface VideoListDto { items: VideoListItemDto[]; page: number; pageSize: number; total: number; categories: string[] }

export interface ChannelProfileDto { id: string; platform: PlatformDto; displayName: string | null; username: string | null; description: string | null }
export interface ChannelDto { id: string; displayName: string | null; language: string; profiles: ChannelProfileDto[] }
export interface VideoDto {
  id: string;
  channelId: string;
  slug: string;
  title: string;
  category: string;
  status: VideoStatusDto;
  legacyStatus: string | null;
  schemaVersion: number | null;
  legacyIncomplete: boolean;
  version: number;
  primaryKeyword: string | null;
  secondaryKeywords: string[];
  searchIntent: string | null;
  hookText: string | null;
  hookType: string | null;
  closing: string | null;
  cta: string | null;
  question: string | null;
  pinnedComment: string | null;
  wordCount: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface SceneDto { id: string; position: number; text: string; searchTerms: string[]; version: number; updatedAt: string }
export interface PublicationMetricDto { key: string; availability: string; numericValue: string | null; capturedAt: string | null }
export interface MetricSnapshotDto {
  id: string; capturedAt: string; views: string | null; likes: string | null; comments: string | null; shares: string | null; saves: string | null;
  watchTime: string | null; averageViewDuration: string | null; averagePercentageViewed: string | null; completionRate: string | null;
  followersGained: string | null; revenue: string | null;
}
export interface PublicationDto {
  id: string; platform: PlatformDto; status: string; legacyStatus: string | null; version: number; title: string | null; caption: string | null;
  description: string | null; hashtags: string[]; cta: string | null; pinnedComment: string | null; platformId: string | null; url: string | null;
  scheduledAt: string | null; publishedAt: string | null; updatedAt: string; metrics: PublicationMetricDto[]; snapshots: MetricSnapshotDto[];
}
export interface RenderAttemptDto {
  id: string; attempt: number; status: string; workerId: string | null; workerLabel: string | null; rendererVideoId: string | null;
  startedAt: string | null; finishedAt: string | null; durationSeconds: number | null; width: number | null; height: number | null; hasAudio: boolean | null; error: string | null;
}
export interface QaDto { id: string; attempt: number; passed: boolean | null; durationPassed: boolean | null; resolutionPassed: boolean | null; audioPassed: boolean | null; captionsPassed: boolean | null; createdAt: string }
export interface LegacyAssetDto { id: string; kind: string; status: string; storageProvider: string; localPath: string | null; mimeType: string | null; size: string | null; createdAt: string }
export interface VideoDetailDto { video: VideoDto; channel: ChannelDto; scenes: SceneDto[]; publications: PublicationDto[]; renderAttempts: RenderAttemptDto[]; qa: QaDto[]; legacyAssets: LegacyAssetDto[] }

export interface VideoPatchDto {
  expectedVersion: number;
  title?: string; category?: string; primaryKeyword?: string | null; searchIntent?: string | null; hookText?: string | null; hookType?: string | null;
  closing?: string | null; cta?: string | null; question?: string | null; pinnedComment?: string | null;
}
export interface ScenePatchDto { expectedVersion: number; text?: string; searchTerms?: string[] }
export interface PublicationPatchDto { expectedVersion: number; title?: string | null; caption?: string | null; description?: string | null; hashtags?: string[]; cta?: string | null; pinnedComment?: string | null }
export interface VideoEditResultDto { title: string; category: string; primaryKeyword: string | null; searchIntent: string | null; hookText: string | null; hookType: string | null; closing: string | null; cta: string | null; question: string | null; pinnedComment: string | null; version: number }
export interface SceneEditResultDto { id: string; position: number; text: string; searchTerms: string[]; version: number; updatedAt: string }
export interface PublicationEditResultDto { id: string; videoId: string; platform: PlatformDto; title: string | null; caption: string | null; description: string | null; hashtags: string[]; cta: string | null; pinnedComment: string | null; version: number; updatedAt: string }

export interface HistoryItemDto {
  id: string; source: 'AUDIT' | 'JOB_EVENT'; timestamp: string; actorType: string; actor: string; action: string; entityType: string; entityId: string | null;
  summary: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}
export interface VideoHistoryDto { items: HistoryItemDto[] }

export interface ApiErrorDto { error: { code: string; message: string; requestId?: string } }
