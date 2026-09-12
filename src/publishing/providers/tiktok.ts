import { Platform } from '@prisma/client';
import type { R2Storage } from '../../storage/r2.js';
import { PublishingError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type { ProviderContext, ProviderOperationState, ProviderPreflightResult, PublishingProvider } from '../provider.js';
import { requireProviderJson, recoveryNumber, recoveryString, safeIntegerSize } from './common.js';

interface TikTokCreatorInfo {
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };
const TIKTOK_CHUNK_BYTES = 10_000_000;

export class TikTokPublishingProvider implements PublishingProvider {
  readonly platform = Platform.TIKTOK;
  private readonly creatorByAttempt = new Map<string, TikTokCreatorInfo>();

  constructor(private readonly transport: HttpTransport, private readonly storage: R2Storage) {}

  private async creatorInfo(context: ProviderContext): Promise<TikTokCreatorInfo> {
    const cached = this.creatorByAttempt.get(context.attemptId);
    if (cached) return cached;
    const response = await this.transport.request('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${context.account.accessToken}` },
      body: '{}',
    });
    const body = await requireProviderJson<TikTokEnvelope<TikTokCreatorInfo>>(response, 'PROVIDER_PROCESSING_FAILED');
    if (body.error?.code && body.error.code !== 'ok') {
      if (body.error.code === 'scope_not_authorized') throw new PublishingError('INSUFFICIENT_SCOPE', 'TikTok video.publish scope is required');
      if (body.error.code === 'rate_limit_exceeded') throw new PublishingError('PROVIDER_RATE_LIMITED', 'TikTok creator-info rate limit reached', true);
      throw new PublishingError('PROVIDER_PROCESSING_FAILED', 'TikTok creator information is unavailable');
    }
    if (!body.data) throw new PublishingError('PROVIDER_PROCESSING_FAILED', 'TikTok creator information is missing');
    this.creatorByAttempt.set(context.attemptId, body.data);
    return body.data;
  }

  async preflight(context: ProviderContext): Promise<ProviderPreflightResult> {
    if (!context.account.scopes.includes('video.publish')) return { ready: false, readiness: 'INSUFFICIENT_SCOPE', errorCode: 'INSUFFICIENT_SCOPE', safeErrorMessage: 'TikTok video.publish scope is required' };
    const settings = context.snapshot.tiktok;
    if (!settings || !settings.privacyLevel || settings.allowComment === null || settings.allowDuet === null || settings.allowStitch === null || settings.isAigc === null) {
      return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'TikTok privacy, interactions and AIGC choice must be explicit' };
    }
    if (context.account.readiness === 'PRIVATE_ONLY_UNAUDITED' && settings.privacyLevel !== 'SELF_ONLY') {
      return { ready: false, readiness: 'PRIVATE_ONLY_UNAUDITED', errorCode: 'PROVIDER_AUDIT_REQUIRED', safeErrorMessage: 'Unaudited TikTok clients may only post privately' };
    }
    const creator = await this.creatorInfo(context);
    if (!(creator.privacy_level_options ?? []).includes(settings.privacyLevel)) {
      return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'Selected TikTok privacy level is no longer available' };
    }
    if (settings.allowComment && creator.comment_disabled) return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'TikTok comments are disabled for this creator' };
    if (settings.allowDuet && creator.duet_disabled) return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'TikTok Duet is disabled for this creator' };
    if (settings.allowStitch && creator.stitch_disabled) return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'TikTok Stitch is disabled for this creator' };
    if (context.asset.durationSeconds === null || context.asset.durationSeconds < 61) {
      return { ready: false, readiness: 'PLATFORM_ASSET_INCOMPATIBLE', errorCode: 'PLATFORM_ASSET_INCOMPATIBLE', safeErrorMessage: 'TikTok production policy requires a video of at least 61 seconds' };
    }
    const creatorMax = creator.max_video_post_duration_sec;
    if (typeof creatorMax !== 'number' || context.asset.durationSeconds > creatorMax) {
      return { ready: false, readiness: 'PLATFORM_ASSET_INCOMPATIBLE', errorCode: 'PLATFORM_ASSET_INCOMPATIBLE', safeErrorMessage: 'Video exceeds the creator current TikTok duration capability' };
    }
    return { ready: true, readiness: context.account.readiness };
  }

  async initialize(context: ProviderContext): Promise<ProviderOperationState> {
    const existingPublishId = recoveryString(context.recovery, 'publishId');
    const existingUploadUrl = recoveryString(context.recovery, 'uploadUrl');
    if (existingPublishId && existingUploadUrl) return { status: 'READY_TO_UPLOAD', externalOperationId: existingPublishId, recovery: context.recovery ?? undefined };
    const settings = context.snapshot.tiktok;
    if (!settings?.privacyLevel || settings.allowComment === null || settings.allowDuet === null || settings.allowStitch === null || settings.isAigc === null) {
      throw new PublishingError('PUBLISHING_SETTINGS_REQUIRED', 'TikTok publishing settings are incomplete');
    }
    await this.creatorInfo(context);
    const videoSize = safeIntegerSize(context.asset.size);
    const chunkSize = Math.min(TIKTOK_CHUNK_BYTES, videoSize);
    const totalChunkCount = Math.ceil(videoSize / chunkSize);
    const text = [context.snapshot.caption ?? context.snapshot.title ?? '', ...context.snapshot.hashtags].filter(Boolean).join(' ').trim();
    let response;
    try {
      response = await this.transport.request('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${context.account.accessToken}` },
        body: JSON.stringify({
          post_info: {
            title: text,
            privacy_level: settings.privacyLevel,
            disable_duet: !settings.allowDuet,
            disable_comment: !settings.allowComment,
            disable_stitch: !settings.allowStitch,
            is_aigc: settings.isAigc,
          },
          source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunkCount },
        }),
      });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok Direct Post initialization response was lost', false, true);
    }
    const body = await requireProviderJson<TikTokEnvelope<{ publish_id?: string; upload_url?: string }>>(response);
    if (body.error?.code && body.error.code !== 'ok') throw new PublishingError('PROVIDER_UPLOAD_FAILED', 'TikTok rejected Direct Post initialization');
    const publishId = body.data?.publish_id;
    const uploadUrl = body.data?.upload_url;
    if (!publishId || !uploadUrl) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok Direct Post initialization returned no recoverable identifier', false, true);
    return { status: 'READY_TO_UPLOAD', externalOperationId: publishId, recovery: { publishId, uploadUrl, uploadedBytes: 0, chunkSize } };
  }

  async upload(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const publishId = operation.externalOperationId ?? recoveryString(operation.recovery, 'publishId');
    const uploadUrl = recoveryString(operation.recovery, 'uploadUrl');
    if (!publishId || !uploadUrl) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok upload state is missing', false, true);
    const size = safeIntegerSize(context.asset.size);
    const start = Math.min(recoveryNumber(operation.recovery, 'uploadedBytes') ?? 0, size);
    if (start >= size) return { ...operation, status: 'PROCESSING', externalOperationId: publishId };
    const configuredChunk = recoveryNumber(operation.recovery, 'chunkSize') ?? Math.min(TIKTOK_CHUNK_BYTES, size);
    const end = Math.min(size - 1, start + configuredChunk - 1);
    const source = await this.storage.readObject(context.asset.objectKey, { start, end });
    let response;
    try {
      response = await this.transport.request(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': context.asset.mimeType,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: source.body,
      });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok upload response was lost; reconciliation is required', false, true);
    }
    if (!response.ok) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok upload outcome is ambiguous; reconciliation is required', false, true, response.status);
    const next = end + 1;
    return { status: next >= size ? 'PROCESSING' : 'READY_TO_UPLOAD', externalOperationId: publishId, recovery: { ...(operation.recovery ?? {}), publishId, uploadUrl, uploadedBytes: next, chunkSize: configuredChunk } };
  }

  async reconcile(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const publishId = operation.externalOperationId ?? recoveryString(operation.recovery, 'publishId');
    if (!publishId) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'TikTok publish_id is unavailable for reconciliation', false, true);
    const response = await this.transport.request('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${context.account.accessToken}` },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const body = await requireProviderJson<TikTokEnvelope<{ status?: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number>; uploaded_bytes?: number }>>(response, 'PROVIDER_PROCESSING_FAILED');
    if (body.error?.code && body.error.code !== 'ok') throw new PublishingError('PROVIDER_PROCESSING_FAILED', 'TikTok status reconciliation failed', body.error.code === 'internal_error');
    const data = body.data;
    if (!data?.status) throw new PublishingError('PROVIDER_PROCESSING_FAILED', 'TikTok status response is incomplete');
    if (data.status === 'PUBLISH_COMPLETE') {
      const postId = data.publicaly_available_post_id?.[0];
      return { status: 'SUCCEEDED', externalOperationId: publishId, ...(postId !== undefined ? { platformMediaId: String(postId), publishedUrl: `https://www.tiktok.com/@${context.account.accountId}/video/${String(postId)}` } : {}), recovery: operation.recovery };
    }
    if (data.status === 'FAILED') {
      return { status: 'FAILED', externalOperationId: publishId, recovery: operation.recovery, retryable: data.fail_reason === 'internal', errorCode: 'PROVIDER_PROCESSING_FAILED', safeErrorMessage: `TikTok processing failed${data.fail_reason ? `: ${data.fail_reason}` : ''}` };
    }
    const uploadedBytes = typeof data.uploaded_bytes === 'number' && data.uploaded_bytes >= 0 ? data.uploaded_bytes : recoveryNumber(operation.recovery, 'uploadedBytes');
    if (data.status === 'PROCESSING_UPLOAD' && uploadedBytes !== undefined && uploadedBytes < safeIntegerSize(context.asset.size)) {
      return { status: 'READY_TO_UPLOAD', externalOperationId: publishId, recovery: { ...(operation.recovery ?? {}), uploadedBytes } };
    }
    return { status: 'PROCESSING', externalOperationId: publishId, recovery: operation.recovery };
  }

  finalize(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    return this.reconcile(context, operation);
  }
}
