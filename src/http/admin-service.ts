import { ActorType, AssetKind, Prisma, PrismaClient, VideoStatus } from '@prisma/client';
import type {
  AdminDashboardDto,
  HistoryItemDto,
  PublicationEditResultDto,
  SceneEditResultDto,
  VideoDetailDto,
  VideoEditResultDto,
  VideoHistoryDto,
  VideoListDto,
} from '../contracts/admin.js';
import { ApiError } from './errors.js';

const videoEditableSelect = {
  title: true,
  category: true,
  primaryKeyword: true,
  searchIntent: true,
  hookText: true,
  hookType: true,
  closing: true,
  cta: true,
  question: true,
  pinnedComment: true,
  version: true,
} as const;

const publicationEditableSelect = {
  id: true,
  videoId: true,
  platform: true,
  title: true,
  caption: true,
  description: true,
  hashtags: true,
  cta: true,
  pinnedComment: true,
  version: true,
  updatedAt: true,
} as const;

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function profileDescription(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (typeof record.description === 'string') return record.description;
  if (typeof record.bio === 'string') return record.bio;
  return null;
}

function sanitizeHistoryValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeHistoryValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(authorization|cookie|jwt|token|secret|password|database.?url|refresh.?token|access.?token)/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = sanitizeHistoryValue(child, depth + 1);
    }
  }
  return output;
}

function historyRecord(value: unknown): Record<string, unknown> | null {
  const sanitized = sanitizeHistoryValue(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : null;
}

export async function getDashboard(prisma: PrismaClient): Promise<AdminDashboardDto> {
  const [groups, totalVideos, recentVideos, legacyIncomplete, recentEvents] = await Promise.all([
    prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.video.count(),
    prisma.video.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, category: true, status: true, legacyIncomplete: true, createdAt: true, updatedAt: true },
    }),
    prisma.video.count({ where: { legacyIncomplete: true } }),
    prisma.jobEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, videoId: true, type: true, fromStatus: true, toStatus: true, createdAt: true },
    }),
  ]);
  const totalsByStatus = Object.fromEntries(Object.values(VideoStatus).map((status) => [status, 0])) as Record<VideoStatus, number>;
  for (const group of groups) totalsByStatus[group.status] = group._count._all;
  return {
    totalVideos,
    totalsByStatus,
    legacyIncomplete,
    recentVideos: recentVideos.map((video) => ({ ...video, createdAt: video.createdAt.toISOString(), updatedAt: video.updatedAt.toISOString() })),
    recentEvents: recentEvents.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  };
}

export interface VideoListInput {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: VideoStatus | undefined;
  category?: string | undefined;
}

export async function listVideos(prisma: PrismaClient, input: VideoListInput): Promise<VideoListDto> {
  const where: Prisma.VideoWhereInput = {};
  if (input.status) where.status = input.status;
  if (input.category) where.category = input.category;
  if (input.search) {
    where.OR = [
      { id: { contains: input.search } },
      { slug: { contains: input.search } },
      { title: { contains: input.search } },
      { category: { contains: input.search } },
      { primaryKeyword: { contains: input.search } },
    ];
  }
  const [rows, total, categories] = await Promise.all([
    prisma.video.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        category: true,
        status: true,
        version: true,
        legacyIncomplete: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { scenes: true } },
        renderAttempts: { orderBy: { attempt: 'desc' }, take: 1, select: { durationSeconds: true } },
        publications: { orderBy: { platform: 'asc' }, select: { id: true, platform: true, status: true } },
        assets: { where: { kind: AssetKind.THUMBNAIL }, take: 1, select: { id: true } },
      },
    }),
    prisma.video.count({ where }),
    prisma.video.findMany({ distinct: ['category'], orderBy: { category: 'asc' }, select: { category: true } }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: row.category,
      status: row.status,
      version: row.version,
      legacyIncomplete: row.legacyIncomplete,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      sceneCount: row._count.scenes,
      durationSeconds: decimalNumber(row.renderAttempts[0]?.durationSeconds),
      publications: row.publications,
      hasThumbnailReference: row.assets.length > 0,
    })),
    page: input.page,
    pageSize: input.pageSize,
    total,
    categories: categories.map((item) => item.category),
  };
}

export async function getVideoDetail(prisma: PrismaClient, id: string): Promise<VideoDetailDto> {
  const video = await prisma.video.findUnique({
    where: { id },
    select: {
      id: true,
      channelId: true,
      slug: true,
      title: true,
      category: true,
      status: true,
      legacyStatus: true,
      schemaVersion: true,
      legacyIncomplete: true,
      version: true,
      primaryKeyword: true,
      secondaryKeywords: true,
      searchIntent: true,
      hookText: true,
      hookType: true,
      closing: true,
      cta: true,
      question: true,
      pinnedComment: true,
      wordCount: true,
      createdAt: true,
      updatedAt: true,
      channel: {
        select: {
          id: true,
          displayName: true,
          language: true,
          profiles: { orderBy: { platform: 'asc' }, select: { id: true, platform: true, displayName: true, username: true, metadata: true } },
        },
      },
      scenes: { orderBy: { position: 'asc' }, select: { id: true, position: true, text: true, searchTerms: true, version: true, updatedAt: true } },
      publications: {
        orderBy: { platform: 'asc' },
        select: {
          id: true,
          platform: true,
          status: true,
          legacyStatus: true,
          version: true,
          title: true,
          caption: true,
          description: true,
          hashtags: true,
          cta: true,
          pinnedComment: true,
          platformId: true,
          url: true,
          scheduledAt: true,
          publishedAt: true,
          updatedAt: true,
          metrics: { orderBy: { key: 'asc' }, select: { key: true, availability: true, numericValue: true, capturedAt: true } },
          snapshots: {
            orderBy: { capturedAt: 'desc' },
            take: 20,
            select: {
              id: true, capturedAt: true, views: true, likes: true, comments: true, shares: true, saves: true, watchTime: true,
              averageViewDuration: true, averagePercentageViewed: true, completionRate: true, followersGained: true, revenue: true,
            },
          },
        },
      },
      renderAttempts: {
        orderBy: { attempt: 'desc' },
        select: {
          id: true, attempt: true, status: true, workerId: true, workerLabel: true, rendererVideoId: true, startedAt: true, finishedAt: true,
          durationSeconds: true, width: true, height: true, hasAudio: true, error: true,
        },
      },
      qaResults: { orderBy: { attempt: 'desc' }, select: { id: true, attempt: true, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: true, createdAt: true } },
      assets: {
        where: { storageProvider: 'LEGACY_LOCAL' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, status: true, storageProvider: true, localPath: true, mimeType: true, size: true, createdAt: true },
      },
    },
  });
  if (!video) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
  return {
    video: {
      id: video.id,
      channelId: video.channelId,
      slug: video.slug,
      title: video.title,
      category: video.category,
      status: video.status,
      legacyStatus: video.legacyStatus,
      schemaVersion: video.schemaVersion,
      legacyIncomplete: video.legacyIncomplete,
      version: video.version,
      primaryKeyword: video.primaryKeyword,
      secondaryKeywords: stringArray(video.secondaryKeywords),
      searchIntent: video.searchIntent,
      hookText: video.hookText,
      hookType: video.hookType,
      closing: video.closing,
      cta: video.cta,
      question: video.question,
      pinnedComment: video.pinnedComment,
      wordCount: video.wordCount,
      createdAt: video.createdAt.toISOString(),
      updatedAt: video.updatedAt.toISOString(),
    },
    channel: {
      id: video.channel.id,
      displayName: video.channel.displayName,
      language: video.channel.language,
      profiles: video.channel.profiles.map((profile) => ({
        id: profile.id,
        platform: profile.platform,
        displayName: profile.displayName,
        username: profile.username,
        description: profileDescription(profile.metadata),
      })),
    },
    scenes: video.scenes.map((scene) => ({ ...scene, searchTerms: stringArray(scene.searchTerms), updatedAt: scene.updatedAt.toISOString() })),
    publications: video.publications.map((publication) => ({
      id: publication.id,
      platform: publication.platform,
      status: publication.status,
      legacyStatus: publication.legacyStatus,
      version: publication.version,
      title: publication.title,
      caption: publication.caption,
      description: publication.description,
      hashtags: stringArray(publication.hashtags),
      cta: publication.cta,
      pinnedComment: publication.pinnedComment,
      platformId: publication.platformId,
      url: publication.url,
      scheduledAt: iso(publication.scheduledAt),
      publishedAt: iso(publication.publishedAt),
      updatedAt: publication.updatedAt.toISOString(),
      metrics: publication.metrics.map((metric) => ({ key: metric.key, availability: metric.availability, numericValue: metric.numericValue?.toString() ?? null, capturedAt: iso(metric.capturedAt) })),
      snapshots: publication.snapshots.map((snapshot) => ({
        id: snapshot.id,
        capturedAt: snapshot.capturedAt.toISOString(),
        views: snapshot.views?.toString() ?? null,
        likes: snapshot.likes?.toString() ?? null,
        comments: snapshot.comments?.toString() ?? null,
        shares: snapshot.shares?.toString() ?? null,
        saves: snapshot.saves?.toString() ?? null,
        watchTime: snapshot.watchTime?.toString() ?? null,
        averageViewDuration: snapshot.averageViewDuration?.toString() ?? null,
        averagePercentageViewed: snapshot.averagePercentageViewed?.toString() ?? null,
        completionRate: snapshot.completionRate?.toString() ?? null,
        followersGained: snapshot.followersGained?.toString() ?? null,
        revenue: snapshot.revenue?.toString() ?? null,
      })),
    })),
    renderAttempts: video.renderAttempts.map((attempt) => ({
      ...attempt,
      startedAt: iso(attempt.startedAt),
      finishedAt: iso(attempt.finishedAt),
      durationSeconds: decimalNumber(attempt.durationSeconds),
    })),
    qa: video.qaResults.map((qa) => ({ ...qa, createdAt: qa.createdAt.toISOString() })),
    legacyAssets: video.assets.map((asset) => ({ ...asset, size: asset.size?.toString() ?? null, createdAt: asset.createdAt.toISOString() })),
  };
}

export type AuditWriter = (tx: Prisma.TransactionClient, data: Prisma.AuditLogCreateInput) => Promise<unknown>;
const defaultAuditWriter: AuditWriter = (tx, data) => tx.auditLog.create({ data });

export interface VideoEditableChanges {
  title?: string | undefined;
  category?: string | undefined;
  primaryKeyword?: string | null | undefined;
  searchIntent?: string | null | undefined;
  hookText?: string | null | undefined;
  hookType?: string | null | undefined;
  closing?: string | null | undefined;
  cta?: string | null | undefined;
  question?: string | null | undefined;
  pinnedComment?: string | null | undefined;
}
export interface VideoPatchInput { expectedVersion: number; changes: VideoEditableChanges }

function buildVideoUpdateData(changes: VideoEditableChanges): Prisma.VideoUpdateManyMutationInput {
  const data: Prisma.VideoUpdateManyMutationInput = { version: { increment: 1 } };
  if (changes.title !== undefined) data.title = changes.title;
  if (changes.category !== undefined) data.category = changes.category;
  if (changes.primaryKeyword !== undefined) data.primaryKeyword = changes.primaryKeyword;
  if (changes.searchIntent !== undefined) data.searchIntent = changes.searchIntent;
  if (changes.hookText !== undefined) data.hookText = changes.hookText;
  if (changes.hookType !== undefined) data.hookType = changes.hookType;
  if (changes.closing !== undefined) data.closing = changes.closing;
  if (changes.cta !== undefined) data.cta = changes.cta;
  if (changes.question !== undefined) data.question = changes.question;
  if (changes.pinnedComment !== undefined) data.pinnedComment = changes.pinnedComment;
  return data;
}

export async function updateVideoWithAudit(prisma: PrismaClient, id: string, input: VideoPatchInput, actorEmail: string, requestId: string, auditWriter: AuditWriter = defaultAuditWriter): Promise<VideoEditResultDto> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.video.findUnique({ where: { id }, select: videoEditableSelect });
    if (!before) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
    const updateResult = await tx.video.updateMany({ where: { id, version: input.expectedVersion }, data: buildVideoUpdateData(input.changes) });
    if (updateResult.count !== 1) throw new ApiError(409, 'VIDEO_VERSION_CONFLICT', 'Video changed since it was loaded');
    const after = await tx.video.findUniqueOrThrow({ where: { id }, select: videoEditableSelect });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'VIDEO_EDIT', entityType: 'VIDEO', entityId: id, requestId, beforeData: auditJson(before), afterData: auditJson(after) });
    return after;
  });
}

export interface ScenePatchInput { expectedVersion: number; text?: string | undefined; searchTerms?: string[] | undefined }
export async function updateSceneWithAudit(prisma: PrismaClient, videoId: string, position: number, input: ScenePatchInput, actorEmail: string, requestId: string, auditWriter: AuditWriter = defaultAuditWriter): Promise<SceneEditResultDto> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.videoScene.findUnique({ where: { videoId_position: { videoId, position } } });
    if (!before) throw new ApiError(404, 'SCENE_NOT_FOUND', 'Scene was not found');
    const data: Prisma.VideoSceneUpdateManyMutationInput = { version: { increment: 1 } };
    if (input.text !== undefined) data.text = input.text;
    if (input.searchTerms !== undefined) data.searchTerms = input.searchTerms;
    const result = await tx.videoScene.updateMany({ where: { videoId, position, version: input.expectedVersion }, data });
    if (result.count !== 1) throw new ApiError(409, 'SCENE_VERSION_CONFLICT', 'Scene changed since it was loaded');
    const after = await tx.videoScene.findUniqueOrThrow({ where: { videoId_position: { videoId, position } } });
    await auditWriter(tx, { actorType: ActorType.ADMIN, actor: actorEmail, action: 'SCENE_EDIT', entityType: 'VIDEO_SCENE', entityId: after.id, requestId, beforeData: auditJson(before), afterData: auditJson(after), metadata: auditJson({ videoId, position }) });
    return { id: after.id, position: after.position, text: after.text, searchTerms: stringArray(after.searchTerms), version: after.version, updatedAt: after.updatedAt.toISOString() };
  });
}

export interface PublicationEditableChanges {
  title?: string | null | undefined;
  caption?: string | null | undefined;
  description?: string | null | undefined;
  hashtags?: string[] | undefined;
  cta?: string | null | undefined;
  pinnedComment?: string | null | undefined;
}
export interface PublicationPatchInput { expectedVersion: number; changes: PublicationEditableChanges }

function buildPublicationUpdateData(changes: PublicationEditableChanges): Prisma.PublicationUpdateManyMutationInput {
  const data: Prisma.PublicationUpdateManyMutationInput = { version: { increment: 1 } };
  if (changes.title !== undefined) data.title = changes.title;
  if (changes.caption !== undefined) data.caption = changes.caption;
  if (changes.description !== undefined) data.description = changes.description;
  if (changes.hashtags !== undefined) data.hashtags = changes.hashtags;
  if (changes.cta !== undefined) data.cta = changes.cta;
  if (changes.pinnedComment !== undefined) data.pinnedComment = changes.pinnedComment;
  return data;
}

function publicationAuditSnapshot(value: Prisma.PublicationGetPayload<{ select: typeof publicationEditableSelect }>) {
  return {
    title: value.title,
    caption: value.caption,
    description: value.description,
    hashtags: stringArray(value.hashtags),
    cta: value.cta,
    pinnedComment: value.pinnedComment,
    version: value.version,
  };
}

export async function updatePublicationWithAudit(prisma: PrismaClient, id: string, input: PublicationPatchInput, actorEmail: string, requestId: string, auditWriter: AuditWriter = defaultAuditWriter): Promise<PublicationEditResultDto> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.publication.findUnique({ where: { id }, select: publicationEditableSelect });
    if (!before) throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Publication was not found');
    const result = await tx.publication.updateMany({ where: { id, version: input.expectedVersion }, data: buildPublicationUpdateData(input.changes) });
    if (result.count !== 1) throw new ApiError(409, 'PUBLICATION_VERSION_CONFLICT', 'Publication changed since it was loaded');
    const after = await tx.publication.findUniqueOrThrow({ where: { id }, select: publicationEditableSelect });
    await auditWriter(tx, {
      actorType: ActorType.ADMIN,
      actor: actorEmail,
      action: 'PUBLICATION_EDIT',
      entityType: 'PUBLICATION',
      entityId: id,
      requestId,
      beforeData: auditJson(publicationAuditSnapshot(before)),
      afterData: auditJson(publicationAuditSnapshot(after)),
      metadata: auditJson({ videoId: after.videoId, platform: after.platform }),
    });
    return {
      id: after.id,
      videoId: after.videoId,
      platform: after.platform,
      title: after.title,
      caption: after.caption,
      description: after.description,
      hashtags: stringArray(after.hashtags),
      cta: after.cta,
      pinnedComment: after.pinnedComment,
      version: after.version,
      updatedAt: after.updatedAt.toISOString(),
    };
  });
}

function auditBelongsToVideo(entry: { entityType: string; entityId: string | null; metadata: unknown }, videoId: string): boolean {
  if (entry.entityType === 'VIDEO' && entry.entityId === videoId) return true;
  if (!entry.metadata || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata)) return false;
  return (entry.metadata as Record<string, unknown>).videoId === videoId;
}

function auditSummary(entry: { action: string; metadata: unknown }): string {
  const metadata = entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata as Record<string, unknown> : {};
  if (entry.action === 'VIDEO_EDIT') return 'Video metadata updated';
  if (entry.action === 'SCENE_EDIT') return `Scene ${String(metadata.position ?? '')} updated`.trim();
  if (entry.action === 'PUBLICATION_EDIT') return `${String(metadata.platform ?? 'Publication')} editorial metadata updated`;
  return entry.action.replaceAll('_', ' ').toLowerCase();
}

export async function getVideoHistory(prisma: PrismaClient, videoId: string): Promise<VideoHistoryDto> {
  const exists = await prisma.video.count({ where: { id: videoId } });
  if (!exists) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
  const [auditRows, eventRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entityType: { in: ['VIDEO', 'VIDEO_SCENE', 'PUBLICATION'] } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, actorType: true, actor: true, action: true, entityType: true, entityId: true, beforeData: true, afterData: true, metadata: true, createdAt: true },
    }),
    prisma.jobEvent.findMany({
      where: { videoId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, type: true, fromStatus: true, toStatus: true, workerId: true, createdAt: true },
    }),
  ]);
  const auditItems: HistoryItemDto[] = auditRows.filter((entry) => auditBelongsToVideo(entry, videoId)).map((entry) => ({
    id: entry.id,
    source: 'AUDIT',
    timestamp: entry.createdAt.toISOString(),
    actorType: entry.actorType,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: auditSummary(entry),
    before: historyRecord(entry.beforeData),
    after: historyRecord(entry.afterData),
  }));
  const eventItems: HistoryItemDto[] = eventRows.map((event) => ({
    id: event.id,
    source: 'JOB_EVENT',
    timestamp: event.createdAt.toISOString(),
    actorType: event.workerId ? 'WORKER' : 'SYSTEM',
    actor: event.workerId ?? 'system',
    action: event.type,
    entityType: 'VIDEO',
    entityId: videoId,
    summary: event.fromStatus || event.toStatus ? `${event.fromStatus ?? '—'} → ${event.toStatus ?? '—'}` : event.type,
    before: null,
    after: null,
  }));
  return { items: [...auditItems, ...eventItems].sort((a, b) => b.timestamp.localeCompare(a.timestamp)) };
}
