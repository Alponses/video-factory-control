import { Platform } from '@prisma/client';
import type { R2Storage } from '../../storage/r2.js';
import { PublishingError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type { ProviderContext, ProviderOperationState, ProviderPreflightResult, PublishingProvider } from '../provider.js';
import { requireProviderJson, recoveryNumber, recoveryString, safeIntegerSize } from './common.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };

function uploadedOffset(range: string | null): number {
  if (!range) return 0;
  const match = /bytes=0-(\d+)/i.exec(range);
  return match ? Number(match[1]) + 1 : 0;
}

export class YouTubePublishingProvider implements PublishingProvider {
  readonly platform = Platform.YOUTUBE;
  constructor(private readonly transport: HttpTransport, private readonly storage: R2Storage) {}

  async preflight(context: ProviderContext): Promise<ProviderPreflightResult> {
    if (!context.account.scopes.includes('https://www.googleapis.com/auth/youtube.upload')) return { ready: false, readiness: 'INSUFFICIENT_SCOPE', errorCode: 'INSUFFICIENT_SCOPE', safeErrorMessage: 'YouTube upload scope is required' };
    const settings = context.snapshot.youtube;
    if (!settings?.privacyStatus || !settings.categoryId || settings.madeForKids === null || settings.containsSyntheticMedia === null || !context.snapshot.title) {
      return { ready: false, readiness: context.account.readiness, errorCode: 'PUBLISHING_SETTINGS_REQUIRED', safeErrorMessage: 'YouTube title, category, privacy, made-for-kids and synthetic-media choices must be explicit' };
    }
    if (context.account.readiness === 'PRIVATE_ONLY_UNVERIFIED' && settings.privacyStatus !== 'private') return { ready: false, readiness: 'PRIVATE_ONLY_UNVERIFIED', errorCode: 'PROVIDER_AUDIT_REQUIRED', safeErrorMessage: 'Unverified YouTube API projects may only upload private videos' };
    return { ready: true, readiness: context.account.readiness };
  }

  async initialize(context: ProviderContext): Promise<ProviderOperationState> {
    const existing = recoveryString(context.recovery, 'sessionUri');
    if (existing) return { status: 'READY_TO_UPLOAD', externalOperationId: existing, recovery: context.recovery ?? undefined };
    const settings = context.snapshot.youtube;
    if (!settings?.privacyStatus || !settings.categoryId || settings.madeForKids === null || settings.containsSyntheticMedia === null || !context.snapshot.title) throw new PublishingError('PUBLISHING_SETTINGS_REQUIRED', 'YouTube publishing settings are incomplete');
    const url = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
    url.search = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' }).toString();
    let response;
    try {
      response = await this.transport.request(url.toString(), {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          Authorization: `Bearer ${context.account.accessToken}`,
          'X-Upload-Content-Length': context.asset.size.toString(),
          'X-Upload-Content-Type': context.asset.mimeType,
        },
        body: JSON.stringify({
          snippet: { title: context.snapshot.title, description: context.snapshot.description ?? context.snapshot.caption ?? '', tags: context.snapshot.tags, categoryId: settings.categoryId },
          status: { privacyStatus: settings.privacyStatus, selfDeclaredMadeForKids: settings.madeForKids, containsSyntheticMedia: settings.containsSyntheticMedia },
        }),
      });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable-session creation response was lost', false, true);
    }
    if (!response.ok) throw new PublishingError(response.status >= 500 ? 'PROVIDER_TEMPORARY_UNAVAILABLE' : 'PROVIDER_UPLOAD_FAILED', 'YouTube rejected resumable upload initialization', response.status >= 500, false, response.status);
    const sessionUri = response.headers.get('location');
    if (!sessionUri) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable upload session URI was not returned', false, true);
    return { status: 'READY_TO_UPLOAD', externalOperationId: sessionUri, recovery: { sessionUri, offset: 0 } };
  }

  async upload(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const sessionUri = recoveryString(operation.recovery, 'sessionUri') ?? operation.externalOperationId;
    if (!sessionUri) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable session is missing', false, true);
    const size = safeIntegerSize(context.asset.size);
    const offset = Math.min(recoveryNumber(operation.recovery, 'offset') ?? 0, size);
    if (offset >= size) return { ...operation, status: 'PROCESSING', externalOperationId: sessionUri };
    const source = await this.storage.readObject(context.asset.objectKey, { start: offset, end: size - 1 });
    let response;
    try {
      response = await this.transport.request(sessionUri, {
        method: 'PUT',
        headers: { 'Content-Type': context.asset.mimeType, 'Content-Length': String(size - offset), 'Content-Range': `bytes ${offset}-${size - 1}/${size}` },
        body: source.body,
      });
    } catch {
      throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable upload response was lost', false, true);
    }
    if (response.status === 308) {
      const next = uploadedOffset(response.headers.get('range'));
      return { status: 'READY_TO_UPLOAD', externalOperationId: sessionUri, recovery: { ...(operation.recovery ?? {}), sessionUri, offset: next } };
    }
    const body = await requireProviderJson<{ id?: string }>(response);
    if (!body.id) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube accepted upload bytes but returned no video ID', false, true);
    return { status: 'PROCESSING', externalOperationId: sessionUri, platformMediaId: body.id, recovery: { ...(operation.recovery ?? {}), sessionUri, offset: size, videoId: body.id } };
  }

  async reconcile(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    const sessionUri = recoveryString(operation.recovery, 'sessionUri') ?? operation.externalOperationId;
    let videoId = operation.platformMediaId ?? recoveryString(operation.recovery, 'videoId');
    if (!videoId) {
      if (!sessionUri) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable session is unavailable', false, true);
      const size = safeIntegerSize(context.asset.size);
      const response = await this.transport.request(sessionUri, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
      if (response.status === 308) {
        const next = uploadedOffset(response.headers.get('range'));
        return { status: 'READY_TO_UPLOAD', externalOperationId: sessionUri, recovery: { ...(operation.recovery ?? {}), sessionUri, offset: next } };
      }
      const body = await requireProviderJson<{ id?: string }>(response, 'PROVIDER_PROCESSING_FAILED');
      videoId = body.id;
      if (!videoId) throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'YouTube resumable reconciliation returned no video ID', false, true);
    }
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ part: 'status', id: videoId }).toString();
    const response = await this.transport.request(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${context.account.accessToken}` } });
    const body = await requireProviderJson<{ items?: Array<{ id?: string; status?: { uploadStatus?: string } }> }>(response, 'PROVIDER_PROCESSING_FAILED');
    const item = body.items?.[0];
    const uploadStatus = item?.status?.uploadStatus;
    if (!item?.id) throw new PublishingError('PROVIDER_PROCESSING_FAILED', 'YouTube video status is unavailable');
    if (uploadStatus === 'processed') return { status: 'SUCCEEDED', externalOperationId: sessionUri, platformMediaId: item.id, recovery: { ...(operation.recovery ?? {}), sessionUri, videoId: item.id }, publishedUrl: `https://www.youtube.com/watch?v=${item.id}` };
    if (uploadStatus === 'failed' || uploadStatus === 'rejected' || uploadStatus === 'deleted') return { status: 'FAILED', externalOperationId: sessionUri, platformMediaId: item.id, recovery: operation.recovery, retryable: false, errorCode: 'PROVIDER_PROCESSING_FAILED', safeErrorMessage: `YouTube processing ended with ${uploadStatus}` };
    return { status: 'PROCESSING', externalOperationId: sessionUri, platformMediaId: item.id, recovery: { ...(operation.recovery ?? {}), sessionUri, videoId: item.id } };
  }

  finalize(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    return this.reconcile(context, operation);
  }
}
