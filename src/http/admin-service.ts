import { ActorType, Prisma, PrismaClient, VideoStatus } from '@prisma/client';
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

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function getDashboard(prisma: PrismaClient) {
  const [groups, recentVideos, legacyIncomplete] = await Promise.all([
    prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.video.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, slug: true, title: true, category: true, status: true, legacyIncomplete: true, createdAt: true, updatedAt: true } }),
    prisma.video.count({ where: { legacyIncomplete: true } }),
  ]);
  const totalsByStatus: Record<string, number> = Object.fromEntries(Object.values(VideoStatus).map((status) => [status, 0]));
  for (const group of groups) totalsByStatus[group.status] = group._count._all;
  return { totalsByStatus, recentVideos, legacyIncomplete };
}

export interface VideoListInput {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: VideoStatus | undefined;
  category?: string | undefined;
}

export async function listVideos(prisma: PrismaClient, input: VideoListInput) {
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
  const [items, total] = await Promise.all([
    prisma.video.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: { id: true, slug: true, title: true, category: true, status: true, version: true, legacyIncomplete: true, createdAt: true, updatedAt: true },
    }),
    prisma.video.count({ where }),
  ]);
  return { items, page: input.page, pageSize: input.pageSize, total };
}

export async function getVideoDetail(prisma: PrismaClient, id: string) {
  const video = await prisma.video.findUnique({
    where: { id },
    include: {
      scenes: { orderBy: { position: 'asc' } },
      publications: { orderBy: { platform: 'asc' } },
      renderAttempts: { orderBy: { attempt: 'desc' } },
      qaResults: { orderBy: { attempt: 'desc' } },
      assets: { where: { storageProvider: 'LEGACY_LOCAL' }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!video) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
  const { scenes, publications, renderAttempts, qaResults, assets, ...videoData } = video;
  return {
    video: videoData,
    scenes,
    publications,
    renderAttempts,
    qa: qaResults,
    legacyAssets: assets.map((asset) => ({ ...asset, size: asset.size?.toString() ?? null })),
    legacyIncomplete: video.legacyIncomplete,
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

export interface VideoPatchInput {
  expectedVersion: number;
  changes: VideoEditableChanges;
}

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

export async function updateVideoWithAudit(prisma: PrismaClient, id: string, input: VideoPatchInput, actorEmail: string, requestId: string, auditWriter: AuditWriter = defaultAuditWriter) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.video.findUnique({ where: { id }, select: videoEditableSelect });
    if (!before) throw new ApiError(404, 'VIDEO_NOT_FOUND', 'Video was not found');
    const updateResult = await tx.video.updateMany({
      where: { id, version: input.expectedVersion },
      data: buildVideoUpdateData(input.changes),
    });
    if (updateResult.count !== 1) throw new ApiError(409, 'VIDEO_VERSION_CONFLICT', 'Video changed since it was loaded');
    const after = await tx.video.findUniqueOrThrow({ where: { id }, select: videoEditableSelect });
    await auditWriter(tx, {
      actorType: ActorType.ADMIN,
      actor: actorEmail,
      action: 'VIDEO_EDIT',
      entityType: 'VIDEO',
      entityId: id,
      requestId,
      beforeData: auditJson(before),
      afterData: auditJson(after),
    });
    return after;
  });
}

export interface ScenePatchInput {
  expectedVersion: number;
  text?: string | undefined;
  searchTerms?: string[] | undefined;
}

export async function updateSceneWithAudit(prisma: PrismaClient, videoId: string, position: number, input: ScenePatchInput, actorEmail: string, requestId: string, auditWriter: AuditWriter = defaultAuditWriter) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.videoScene.findUnique({ where: { videoId_position: { videoId, position } } });
    if (!before) throw new ApiError(404, 'SCENE_NOT_FOUND', 'Scene was not found');
    const data: Prisma.VideoSceneUpdateManyMutationInput = { version: { increment: 1 } };
    if (input.text !== undefined) data.text = input.text;
    if (input.searchTerms !== undefined) data.searchTerms = input.searchTerms;
    const result = await tx.videoScene.updateMany({ where: { videoId, position, version: input.expectedVersion }, data });
    if (result.count !== 1) throw new ApiError(409, 'SCENE_VERSION_CONFLICT', 'Scene changed since it was loaded');
    const after = await tx.videoScene.findUniqueOrThrow({ where: { videoId_position: { videoId, position } } });
    await auditWriter(tx, {
      actorType: ActorType.ADMIN,
      actor: actorEmail,
      action: 'SCENE_EDIT',
      entityType: 'VIDEO_SCENE',
      entityId: after.id,
      requestId,
      beforeData: auditJson(before),
      afterData: auditJson(after),
      metadata: auditJson({ videoId, position }),
    });
    return after;
  });
}
