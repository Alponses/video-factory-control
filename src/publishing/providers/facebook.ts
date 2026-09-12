import { Platform } from '@prisma/client';
import type { R2Storage } from '../../storage/r2.js';
import { PublishingError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type { ProviderContext, ProviderOperationState, ProviderPreflightResult, PublishingProvider } from '../provider.js';
import { requireProviderJson, recoveryString } from './common.js';

export class FacebookPublishingProvider implements PublishingProvider {
  readonly platform = Platform.FACEBOOK;
  constructor(private readonly transport: HttpTransport, private readonly storage: R2Storage, private readonly graphApiVersion: string) {}

  async preflight(context: ProviderContext): Promise<ProviderPreflightResult> {
    if (context.asset.durationSeconds === null || context.asset.durationSeconds > 60) {
      return { ready: false, readiness: 'PLATFORM_ASSET_INCOMPATIBLE', errorCode: 'PLATFORM_ASSET_INCOMPATIBLE', safeErrorMessage: 'Configured Facebook Reels capability supports at most 60 seconds; the master asset will not be trimmed automatically' };
    }
    return { ready: true, readiness: context.account.readiness };
  }

  async initialize(context: ProviderContext): Promise<ProviderOperationState> {
    const existingVideoId = recoveryString(context.recovery, 'videoId');
    const existingUploadUrl = recoveryString(context.recovery, 'uploadUrl');
    if (existingVideoId && existingUploadUrl) return { status: 'READY_TO_UPLOAD', externalOperationId: existingVideoId, platformMediaId: existingVideoId, recovery: context.recovery ?? undefined };
    let response;
    try {
      const url = `https://graph.facebook.com/${this.graphApiVersion}/me/video_reels?upload_phase=start`;
      response = await this.transport.request(url, { method: 'POST', headers: { Authorization: `Bearer ${context.account.accessToken}` } });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel creation response was lost', false, true);
    }
    const body = await requireProviderJson<{ video_id?: string; upload_url?: string }>(response);
    if (!body.video_id || !body.upload_url) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel creation returned no recoverable video identifier', false, true);
    return { status: 'READY_TO_UPLOAD', externalOperationId: body.video_id, platformMediaId: body.video_id, recovery: { videoId: body.video_id, uploadUrl: body.upload_url, uploaded: false, finished: false } };
  }

  async upload(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const videoId = operation.platformMediaId ?? operation.externalOperationId ?? recoveryString(operation.recovery, 'videoId');
    const uploadUrl = recoveryString(operation.recovery, 'uploadUrl');
    if (!videoId || !uploadUrl) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel upload state is missing', false, true);
    if (operation.recovery?.uploaded === true) return { ...operation, status: 'PROCESSING', externalOperationId: videoId, platformMediaId: videoId };
    const source = await this.storage.readObject(context.asset.objectKey);
    let response;
    try {
      response = await this.transport.request(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `OAuth ${context.account.accessToken}`, offset: '0', file_size: context.asset.size.toString(), 'Content-Type': 'application/octet-stream' },
        body: source.body,
      });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel upload response was lost; status reconciliation is required', false, true);
    }
    const body = await requireProviderJson<{ success?: boolean }>(response);
    if (!body.success) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel upload outcome is ambiguous', false, true);
    return { status: 'PROCESSING', externalOperationId: videoId, platformMediaId: videoId, recovery: { ...(operation.recovery ?? {}), videoId, uploadUrl, uploaded: true, finished: false } };
  }

  async reconcile(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const videoId = operation.platformMediaId ?? operation.externalOperationId ?? recoveryString(operation.recovery, 'videoId');
    if (!videoId) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook video_id is unavailable for reconciliation', false, true);
    const url = new URL(`https://graph.facebook.com/${this.graphApiVersion}/${videoId}`);
    url.searchParams.set('fields', 'status,permalink_url');
    const response = await this.transport.request(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${context.account.accessToken}` } });
    const body = await requireProviderJson<{ id?: string; permalink_url?: string; status?: { video_status?: string; uploading_phase?: { status?: string }; processing_phase?: { status?: string }; publishing_phase?: { status?: string } } }>(response, 'PROVIDER_PROCESSING_FAILED');
    const status = body.status;
    const publishing = status?.publishing_phase?.status?.toLowerCase();
    const processing = status?.processing_phase?.status?.toLowerCase();
    const uploading = status?.uploading_phase?.status?.toLowerCase();
    const videoStatus = status?.video_status?.toLowerCase();
    if (publishing === 'complete' || videoStatus === 'published' || videoStatus === 'ready') return { status: 'SUCCEEDED', externalOperationId: videoId, platformMediaId: videoId, recovery: operation.recovery, ...(body.permalink_url ? { publishedUrl: body.permalink_url } : {}) };
    if ([publishing, processing, uploading, videoStatus].some((value) => value === 'error' || value === 'failed')) return { status: 'FAILED', externalOperationId: videoId, platformMediaId: videoId, recovery: operation.recovery, retryable: false, errorCode: 'PROVIDER_PROCESSING_FAILED', safeErrorMessage: 'Facebook Reel processing failed' };
    return { status: 'PROCESSING', externalOperationId: videoId, platformMediaId: videoId, recovery: operation.recovery };
  }

  async finalize(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const videoId = operation.platformMediaId ?? operation.externalOperationId ?? recoveryString(operation.recovery, 'videoId');
    if (!videoId) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook video_id is missing before publish', false, true);
    if (operation.recovery?.finished === true) return this.reconcile(context, operation);
    const body = new URLSearchParams({ video_id: videoId, upload_phase: 'finish', video_state: 'PUBLISHED' });
    if (context.snapshot.description ?? context.snapshot.caption) body.set('description', context.snapshot.description ?? context.snapshot.caption ?? '');
    if (context.snapshot.title) body.set('title', context.snapshot.title);
    let response;
    try {
      response = await this.transport.request(`https://graph.facebook.com/${this.graphApiVersion}/me/video_reels`, { method: 'POST', headers: { Authorization: `Bearer ${context.account.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel finish response was lost; reconciliation is required', false, true);
    }
    const result = await requireProviderJson<{ success?: boolean }>(response, 'PROVIDER_PROCESSING_FAILED');
    if (!result.success) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Facebook Reel finish outcome is ambiguous; reconciliation is required', false, true);
    return { status: 'PROCESSING', externalOperationId: videoId, platformMediaId: videoId, recovery: { ...(operation.recovery ?? {}), videoId, finished: true } };
  }
}
