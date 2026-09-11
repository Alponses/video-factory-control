import {
  Platform,
  PublicationStatus,
  RenderAttemptStatus,
  VideoStatus,
} from '@prisma/client';
import { isPlainObject, type JsonObject } from './deep-merge.js';
import type { LegacySourceJob } from './source.js';

export interface NormalizedPublication {
  platform: Platform;
  status: PublicationStatus;
  legacyStatus: string | null;
  title: string | null;
  caption: string | null;
  description: string | null;
  hashtags: unknown[] | null;
  tags: unknown[] | null;
  searchKeyword: string | null;
  coverText: string | null;
  thumbnailText: string | null;
  cta: string | null;
  pinnedComment: string | null;
  platformId: string | null;
  url: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  raw: JsonObject;
  performanceRaw?: JsonObject;
}

export interface NormalizedRender {
  workerLabel: string | null;
  status: RenderAttemptStatus;
  rendererVideoId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  localFile: string | null;
  error: string | null;
  raw: JsonObject;
}

export interface NormalizedQa {
  passed: boolean | null;
  durationPassed: boolean | null;
  resolutionPassed: boolean | null;
  audioPassed: boolean | null;
  captionsPassed: boolean | null;
  raw: JsonObject;
}

export interface NormalizedLegacyJob {
  id: string;
  channelId: string;
  slug: string;
  title: string;
  category: string;
  status: VideoStatus;
  legacyStatus: string | null;
  schemaVersion: number | null;
  legacyIncomplete: boolean;
  warnings: string[];
  primaryKeyword: string | null;
  secondaryKeywords: unknown[] | null;
  searchIntent: string | null;
  hookText: string | null;
  hookType: string | null;
  closing: string | null;
  cta: string | null;
  question: string | null;
  pinnedComment: string | null;
  wordCount: number | null;
  cover: JsonObject | null;
  renderConfig: JsonObject | null;
  engagement: JsonObject | null;
  metadata: JsonObject;
  createdAt: Date;
  scenes: Array<{ position: number; text: string; searchTerms: unknown[] }>;
  publications: NormalizedPublication[];
  render: NormalizedRender | null;
  qa: NormalizedQa | null;
  legacyAssets: Array<{ kind: 'VIDEO' | 'COVER' | 'THUMBNAIL'; localPath: string; metadata: JsonObject }>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function arrayOrNull(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function objectOrNull(value: unknown): JsonObject | null {
  return isPlainObject(value) ? value : null;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredString(value: unknown, field: string, fileId: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fileId}: missing ${field}`);
  return value;
}

export function mapVideoStatus(effective: JsonObject): VideoStatus {
  const admin = objectOrNull(effective.admin);
  const adminStatus = stringOrNull(admin?.status)?.toLowerCase();
  if (adminStatus) {
    if (adminStatus === 'ready') return VideoStatus.READY;
    if (adminStatus === 'scheduled') return VideoStatus.SCHEDULED;
    if (adminStatus === 'published') return VideoStatus.PUBLISHED;
    if (adminStatus === 'review' || adminStatus === 'needs_changes') return VideoStatus.DRAFT;
  }

  switch (stringOrNull(effective.status)?.toLowerCase()) {
    case 'pending': return VideoStatus.READY;
    case 'processing': return VideoStatus.RENDERING;
    case 'approved': return VideoStatus.APPROVED;
    case 'publishing': return VideoStatus.PUBLISHING;
    case 'published': return VideoStatus.PUBLISHED;
    case 'failed': return VideoStatus.FAILED;
    case 'cancelled': return VideoStatus.CANCELLED;
    default: return VideoStatus.DRAFT;
  }
}

export function mapPublicationStatus(value: unknown): PublicationStatus {
  switch (stringOrNull(value)?.toLowerCase()) {
    case 'ready': return PublicationStatus.READY;
    case 'scheduled': return PublicationStatus.SCHEDULED;
    case 'publishing': return PublicationStatus.PUBLISHING;
    case 'published': return PublicationStatus.PUBLISHED;
    case 'failed': return PublicationStatus.FAILED;
    case 'cancelled': return PublicationStatus.CANCELLED;
    default: return PublicationStatus.DRAFT;
  }
}

function normalizePublication(platform: Platform, rawValue: unknown, performanceValue: unknown): NormalizedPublication | null {
  if (!isPlainObject(rawValue)) return null;
  const performanceRaw = objectOrNull(performanceValue);
  const platformId = platform === Platform.FACEBOOK
    ? stringOrNull(rawValue.postId)
    : stringOrNull(rawValue.videoId);

  return {
    platform,
    status: mapPublicationStatus(rawValue.status),
    legacyStatus: stringOrNull(rawValue.status),
    title: stringOrNull(rawValue.title),
    caption: stringOrNull(rawValue.caption),
    description: stringOrNull(rawValue.description),
    hashtags: arrayOrNull(rawValue.hashtags),
    tags: arrayOrNull(rawValue.tags),
    searchKeyword: stringOrNull(rawValue.searchKeyword),
    coverText: stringOrNull(rawValue.coverText),
    thumbnailText: stringOrNull(rawValue.thumbnailText),
    cta: stringOrNull(rawValue.cta),
    pinnedComment: stringOrNull(rawValue.pinnedComment),
    platformId,
    url: stringOrNull(rawValue.url),
    scheduledAt: dateOrNull(rawValue.scheduledAt),
    publishedAt: dateOrNull(rawValue.publishedAt),
    raw: rawValue,
    ...(performanceRaw ? { performanceRaw } : {}),
  };
}

function normalizeRender(value: unknown): NormalizedRender | null {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return null;
  const error = stringOrNull(value.error);
  const finishedAt = dateOrNull(value.finishedAt);
  const startedAt = dateOrNull(value.startedAt);
  const qaPassed = booleanOrNull(value.qaPassed);
  const status = error
    ? RenderAttemptStatus.FAILED
    : qaPassed === true || finishedAt
      ? RenderAttemptStatus.SUCCEEDED
      : startedAt
        ? RenderAttemptStatus.RUNNING
        : RenderAttemptStatus.QUEUED;

  return {
    workerLabel: stringOrNull(value.worker),
    status,
    rendererVideoId: stringOrNull(value.videoId),
    startedAt,
    finishedAt,
    durationSeconds: numberOrNull(value.durationSeconds),
    width: numberOrNull(value.width),
    height: numberOrNull(value.height),
    hasAudio: booleanOrNull(value.hasAudio),
    localFile: stringOrNull(value.localFile),
    error,
    raw: value,
  };
}

function normalizeQa(value: unknown): NormalizedQa | null {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return null;
  return {
    passed: booleanOrNull(value.passed),
    durationPassed: booleanOrNull(value.durationPassed),
    resolutionPassed: booleanOrNull(value.resolutionPassed),
    audioPassed: booleanOrNull(value.audioPassed),
    captionsPassed: booleanOrNull(value.captionsPassed),
    raw: value,
  };
}

function modernCompletenessReasons(effective: JsonObject): string[] {
  const reasons: string[] = [];
  const scenes = Array.isArray(effective.scenes) ? effective.scenes : [];
  if (scenes.length !== 16) reasons.push(`scenes:${scenes.length}`);
  if (typeof effective.schemaVersion !== 'number') reasons.push('missing schemaVersion');
  if (typeof effective.channelId !== 'string') reasons.push('missing channelId');
  for (const field of ['discovery', 'content', 'cover', 'publishing', 'engagement', 'performance']) {
    if (!isPlainObject(effective[field])) reasons.push(`missing ${field}`);
  }
  return reasons;
}

function extractLegacyAssets(effective: JsonObject): NormalizedLegacyJob['legacyAssets'] {
  const assets: NormalizedLegacyJob['legacyAssets'] = [];
  const render = objectOrNull(effective.render);
  const cover = objectOrNull(effective.cover);

  const renderFile = stringOrNull(render?.localFile);
  if (renderFile) assets.push({ kind: 'VIDEO', localPath: renderFile, metadata: { source: 'render.localFile' } });

  const coverAsset = stringOrNull(cover?.asset);
  if (coverAsset) assets.push({ kind: 'COVER', localPath: coverAsset, metadata: { source: 'cover.asset' } });

  const platforms = objectOrNull(cover?.platforms);
  const youtube = objectOrNull(platforms?.youtube);
  const facebook = objectOrNull(platforms?.facebook);
  const youtubeAsset = stringOrNull(youtube?.asset);
  const facebookAsset = stringOrNull(facebook?.asset);
  if (youtubeAsset) assets.push({ kind: 'THUMBNAIL', localPath: youtubeAsset, metadata: { source: 'cover.platforms.youtube.asset' } });
  if (facebookAsset) assets.push({ kind: 'COVER', localPath: facebookAsset, metadata: { source: 'cover.platforms.facebook.asset' } });

  return assets;
}

export function normalizeLegacyJob(source: LegacySourceJob, fallbackChannel: string): NormalizedLegacyJob {
  const effective = source.effective;
  const id = requiredString(effective.id ?? source.fileId, 'id', source.fileId);
  if (id !== source.fileId) throw new Error(`${source.fileId}: internal id ${id} does not match filename`);

  const channelId = stringOrNull(effective.channelId) ?? fallbackChannel;
  const warnings = modernCompletenessReasons(effective);
  if (!stringOrNull(effective.channelId)) warnings.push(`normalized channelId from config/factory.json: ${fallbackChannel}`);

  const sceneValues = Array.isArray(effective.scenes) ? effective.scenes : [];
  const scenes = sceneValues.map((scene, index) => {
    if (!isPlainObject(scene)) throw new Error(`${source.fileId}: scene ${index + 1} is not an object`);
    const searchTerms = Array.isArray(scene.searchTerms) ? scene.searchTerms : [];
    return {
      position: index + 1,
      text: requiredString(scene.text, `scenes[${index}].text`, source.fileId),
      searchTerms,
    };
  });

  const discovery = objectOrNull(effective.discovery);
  const content = objectOrNull(effective.content);
  const hook = objectOrNull(content?.hook);
  const engagement = objectOrNull(effective.engagement);
  const publishing = objectOrNull(effective.publishing);
  const performance = objectOrNull(effective.performance);

  const platformInputs: Array<[Platform, string]> = [
    [Platform.TIKTOK, 'tiktok'],
    [Platform.YOUTUBE, 'youtube'],
    [Platform.FACEBOOK, 'facebook'],
  ];
  const publications = platformInputs
    .map(([platform, key]) => normalizePublication(platform, publishing?.[key], performance?.[key]))
    .filter((value): value is NormalizedPublication => value !== null);

  const createdAt = dateOrNull(effective.createdAt);
  if (!createdAt) throw new Error(`${source.fileId}: invalid or missing createdAt`);

  const metadata: JsonObject = {
    legacy: true,
    legacyIncomplete: warnings.length > 0,
    warnings,
    effective,
  };

  return {
    id,
    channelId,
    slug: requiredString(effective.slug, 'slug', source.fileId),
    title: requiredString(effective.title, 'title', source.fileId),
    category: requiredString(effective.category, 'category', source.fileId),
    status: mapVideoStatus(effective),
    legacyStatus: stringOrNull(effective.status),
    schemaVersion: numberOrNull(effective.schemaVersion),
    legacyIncomplete: warnings.length > 0,
    warnings,
    primaryKeyword: stringOrNull(discovery?.primaryKeyword),
    secondaryKeywords: arrayOrNull(discovery?.secondaryKeywords),
    searchIntent: stringOrNull(discovery?.searchIntent),
    hookText: stringOrNull(hook?.text),
    hookType: stringOrNull(hook?.type),
    closing: stringOrNull(content?.closing),
    cta: stringOrNull(engagement?.cta),
    question: stringOrNull(engagement?.question),
    pinnedComment: stringOrNull(engagement?.pinnedComment),
    wordCount: numberOrNull(content?.wordCount),
    cover: objectOrNull(effective.cover),
    renderConfig: objectOrNull(effective.renderConfig),
    engagement,
    metadata,
    createdAt,
    scenes,
    publications,
    render: normalizeRender(effective.render),
    qa: normalizeQa(effective.qa),
    legacyAssets: extractLegacyAssets(effective),
  };
}
