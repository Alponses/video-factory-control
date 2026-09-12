import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AssetKind,
  AssetStatus,
  Platform,
  PublicationStatus,
  RenderAttemptStatus,
  VideoStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';

export interface PreflightMessage { code: string; message: string }
export interface PreflightPreview {
  publicationId: string;
  videoId: string;
  platform: Platform;
  profileId: string | null;
  title: string | null;
  caption: string | null;
  description: string | null;
  hashtags: string[];
  cta: string | null;
  videoAssetId: string | null;
  coverAssetId: string | null;
  thumbnailAssetId: string | null;
  durationSeconds: number | null;
  internalRuleNotice: string;
}
export interface PreflightResult {
  ready: boolean;
  blockers: PreflightMessage[];
  warnings: PreflightMessage[];
  preview: PreflightPreview | null;
  activeSchedule: { id: string; status: string; scheduledAtUtc: string; timezone: string; version: number } | null;
  latestDispatch: { id: string; status: string; scheduleId: string; createdAt: string } | null;
}

type SchedulingDb = PrismaClient | Prisma.TransactionClient;

type PublishingRules = {
  engagement?: { primaryCtaRequired?: boolean };
  tiktok?: { hashtagsMin?: number; hashtagsMax?: number };
  youtube?: { hashtagsMin?: number; hashtagsMax?: number; titleMaxCharacters?: number | null };
  facebook?: { hashtagsMin?: number; hashtagsMax?: number };
};

let cachedRules: PublishingRules | null = null;
function rules(): PublishingRules {
  if (cachedRules) return cachedRules;
  const file = path.resolve(process.cwd(), 'config/publishing-rules.json');
  cachedRules = JSON.parse(readFileSync(file, 'utf8')) as PublishingRules;
  return cachedRules;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function text(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export interface PreflightOptions {
  ignoreScheduleId?: string;
  allowActiveSchedule?: boolean;
}

export async function evaluatePublicationPreflight(db: SchedulingDb, publicationId: string, options: PreflightOptions = {}): Promise<PreflightResult> {
  const publication = await db.publication.findUnique({
    where: { id: publicationId },
    include: {
      video: {
        include: {
          qaResults: { orderBy: { attempt: 'desc' }, take: 1 },
          renderAttempts: { orderBy: { attempt: 'desc' }, take: 1 },
          assets: {
            where: { status: AssetStatus.READY, storageProvider: 'R2', kind: { in: [AssetKind.VIDEO, AssetKind.COVER, AssetKind.THUMBNAIL] } },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
          },
          channel: { include: { profiles: true } },
        },
      },
      schedules: { where: { status: 'SCHEDULED' }, orderBy: { createdAt: 'desc' } },
      dispatches: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!publication) {
    return { ready: false, blockers: [{ code: 'PUBLICATION_NOT_FOUND', message: 'Publication does not exist.' }], warnings: [], preview: null, activeSchedule: null, latestDispatch: null };
  }

  const blockers: PreflightMessage[] = [];
  const warnings: PreflightMessage[] = [];
  const compatibleVideoStatuses = new Set<VideoStatus>([VideoStatus.APPROVED, VideoStatus.SCHEDULED, VideoStatus.PUBLISHING, VideoStatus.PUBLISHED]);
  if (!compatibleVideoStatuses.has(publication.video.status)) blockers.push({ code: 'VIDEO_NOT_APPROVED', message: `Video production status ${publication.video.status} is not approved for distribution.` });

  const videoAsset = publication.video.assets.find((asset) => asset.kind === AssetKind.VIDEO) ?? null;
  const coverAsset = publication.video.assets.find((asset) => asset.kind === AssetKind.COVER) ?? null;
  const thumbnailAsset = publication.video.assets.find((asset) => asset.kind === AssetKind.THUMBNAIL) ?? null;
  if (!videoAsset) blockers.push({ code: 'DURABLE_VIDEO_MISSING', message: 'A current READY R2 VIDEO asset is required.' });

  const qa = publication.video.qaResults[0] ?? null;
  if (!qa || qa.passed !== true) blockers.push({ code: 'QA_NOT_APPROVED', message: 'Latest QA result must be approved.' });

  if (publication.status === PublicationStatus.PUBLISHED) blockers.push({ code: 'PUBLICATION_ALREADY_PUBLISHED', message: 'Published content cannot be scheduled again in Phase 6.' });
  if (publication.status === PublicationStatus.CANCELLED) blockers.push({ code: 'PUBLICATION_CANCELLED', message: 'Cancelled publication cannot be scheduled.' });
  if (publication.status === PublicationStatus.PUBLISHING) blockers.push({ code: 'PUBLICATION_IN_PROGRESS', message: 'Publication is already being processed.' });

  const activeSchedules = publication.schedules.filter((schedule) => schedule.id !== options.ignoreScheduleId);
  if (!options.allowActiveSchedule && activeSchedules.length > 0) blockers.push({ code: 'ACTIVE_SCHEDULE_EXISTS', message: 'Publication already has an active schedule.' });

  const hashtags = stringArray(publication.hashtags);
  const ruleSet = rules();
  const platformRules = publication.platform === Platform.TIKTOK ? ruleSet.tiktok : publication.platform === Platform.YOUTUBE ? ruleSet.youtube : ruleSet.facebook;
  const minHashtags = platformRules?.hashtagsMin ?? 0;
  const maxHashtags = platformRules?.hashtagsMax ?? Number.MAX_SAFE_INTEGER;
  if (hashtags.length < minHashtags || hashtags.length > maxHashtags) {
    blockers.push({ code: 'INTERNAL_HASHTAG_RULE', message: `Video Factory internal rule requires ${minHashtags}–${maxHashtags} hashtags for ${publication.platform}.` });
  }
  if (ruleSet.engagement?.primaryCtaRequired && !text(publication.cta)) blockers.push({ code: 'CTA_REQUIRED', message: 'Video Factory internal rule requires a primary CTA.' });

  if (publication.platform === Platform.TIKTOK) {
    if (!text(publication.caption)) blockers.push({ code: 'TIKTOK_CAPTION_REQUIRED', message: 'TikTok publication caption is required.' });
  } else if (publication.platform === Platform.YOUTUBE) {
    if (!text(publication.title)) blockers.push({ code: 'YOUTUBE_TITLE_REQUIRED', message: 'YouTube title is required.' });
    if (!text(publication.description)) blockers.push({ code: 'YOUTUBE_DESCRIPTION_REQUIRED', message: 'YouTube description is required.' });
    const maxTitle = ruleSet.youtube?.titleMaxCharacters;
    if (maxTitle && (publication.title?.length ?? 0) > maxTitle) blockers.push({ code: 'INTERNAL_TITLE_RULE', message: `Video Factory internal rule limits YouTube titles to ${maxTitle} characters.` });
  } else if (publication.platform === Platform.FACEBOOK) {
    if (!text(publication.description) && !text(publication.caption)) blockers.push({ code: 'FACEBOOK_DESCRIPTION_REQUIRED', message: 'Facebook description/caption is required.' });
  }

  const render = publication.video.renderAttempts[0] ?? null;
  const durationSeconds = decimal(render?.durationSeconds);
  if (publication.platform === Platform.TIKTOK) {
    if (durationSeconds === null) blockers.push({ code: 'TIKTOK_DURATION_UNKNOWN', message: 'TikTok monetization preflight requires a measured duration.' });
    else if (durationSeconds < 61) blockers.push({ code: 'TIKTOK_INTERNAL_61S_RULE', message: 'Video Factory monetization pipeline requires TikTok videos to be at least 61 seconds.' });
  }
  if (render && render.status !== RenderAttemptStatus.SUCCEEDED) warnings.push({ code: 'LATEST_RENDER_NOT_SUCCEEDED', message: `Latest render attempt is ${render.status}; QA and durable asset remain authoritative.` });

  const profile = publication.video.channel.profiles.find((item) => item.platform === publication.platform) ?? null;
  if (!profile) warnings.push({ code: 'PROFILE_NOT_CONFIGURED', message: `No relational ${publication.platform} profile is configured for this channel.` });

  const activeSchedule = publication.schedules[0] ?? null;
  const latestDispatch = publication.dispatches[0] ?? null;
  const preview: PreflightPreview = {
    publicationId: publication.id,
    videoId: publication.videoId,
    platform: publication.platform,
    profileId: profile?.id ?? null,
    title: publication.title,
    caption: publication.caption,
    description: publication.description,
    hashtags,
    cta: publication.cta,
    videoAssetId: videoAsset?.id ?? null,
    coverAssetId: coverAsset?.id ?? null,
    thumbnailAssetId: thumbnailAsset?.id ?? null,
    durationSeconds,
    internalRuleNotice: 'Hashtag, CTA and TikTok 61-second checks are Video Factory internal pipeline rules, not universal platform limits.',
  };
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    preview,
    activeSchedule: activeSchedule ? { id: activeSchedule.id, status: activeSchedule.status, scheduledAtUtc: activeSchedule.scheduledAt.toISOString(), timezone: activeSchedule.timezone, version: activeSchedule.version } : null,
    latestDispatch: latestDispatch ? { id: latestDispatch.id, status: latestDispatch.status, scheduleId: latestDispatch.scheduleId, createdAt: latestDispatch.createdAt.toISOString() } : null,
  };
}
