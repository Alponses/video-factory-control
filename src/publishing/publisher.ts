import { randomUUID } from 'node:crypto';
import {
  ActorType,
  Platform,
  Prisma,
  PublicationAttemptStage,
  PublicationAttemptStatus,
  PublicationDispatchStatus,
  PublicationStatus,
  type PrismaClient,
} from '@prisma/client';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret, integrationAad } from '../integrations/crypto.js';
import { IntegrationError } from '../integrations/errors.js';
import { refreshOAuthToken } from '../integrations/oauth.js';
import { claimTokenRefresh, loadIntegrationForProfile, persistRefreshedTokens, releaseTokenRefresh, type DecryptedIntegration } from '../integrations/service.js';
import type { HttpTransport } from './http.js';
import type { PublisherLogger } from './logging.js';
import { PublishingError, safePublishingError } from './errors.js';
import type { ProviderAccount, ProviderContext, ProviderOperationState, ProviderReadiness, PublisherSnapshot, PublishingProviderRegistry } from './provider.js';
import { exponentialBackoffMs } from './retry.js';

const READINESS = new Set<ProviderReadiness>(['READY', 'PRIVATE_ONLY_UNAUDITED', 'PRIVATE_ONLY_UNVERIFIED', 'INSUFFICIENT_SCOPE', 'REAUTH_REQUIRED', 'PLATFORM_ASSET_INCOMPATIBLE']);

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function object(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseSnapshot(value: Prisma.JsonValue): PublisherSnapshot & { durationSeconds: number | null } {
  const data = object(value);
  const platform = data.platform;
  if (!Object.values(Platform).includes(platform as Platform)) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Dispatch snapshot platform is invalid');
  const tiktok = object((data.tiktok ?? null) as Prisma.JsonValue | null);
  const youtube = object((data.youtube ?? null) as Prisma.JsonValue | null);
  const duration = typeof data.durationSeconds === 'number' && Number.isFinite(data.durationSeconds) ? data.durationSeconds : null;
  return {
    publicationId: typeof data.publicationId === 'string' ? data.publicationId : '',
    videoId: typeof data.videoId === 'string' ? data.videoId : '',
    platform: platform as Platform,
    profileId: nullableString(data.profileId),
    title: nullableString(data.title),
    caption: nullableString(data.caption),
    description: nullableString(data.description),
    hashtags: strings(data.hashtags),
    tags: strings(data.tags),
    tiktok: data.tiktok && typeof data.tiktok === 'object' && !Array.isArray(data.tiktok) ? {
      privacyLevel: nullableString(tiktok.privacyLevel),
      allowComment: nullableBoolean(tiktok.allowComment),
      allowDuet: nullableBoolean(tiktok.allowDuet),
      allowStitch: nullableBoolean(tiktok.allowStitch),
      isAigc: nullableBoolean(tiktok.isAigc),
    } : null,
    youtube: data.youtube && typeof data.youtube === 'object' && !Array.isArray(data.youtube) ? {
      privacyStatus: nullableString(youtube.privacyStatus),
      categoryId: nullableString(youtube.categoryId),
      madeForKids: nullableBoolean(youtube.madeForKids),
      containsSyntheticMedia: nullableBoolean(youtube.containsSyntheticMedia),
    } : null,
    durationSeconds: duration,
  };
}

function providerReadiness(value: string | null): ProviderReadiness {
  return value && READINESS.has(value as ProviderReadiness) ? value as ProviderReadiness : 'REAUTH_REQUIRED';
}

export interface ClaimedPublicationDispatch {
  dispatchId: string;
  publicationId: string;
  attemptId: string;
  provider: Platform;
  mode: 'execute' | 'reconcile';
}

export interface PublisherTickResult {
  publisherRunId: string;
  claimed: number;
  completed: number;
  processing: number;
  retryScheduled: number;
  failed: number;
  unknown: number;
  needsAttention: number;
}

async function failMaxAttempts(tx: Prisma.TransactionClient, dispatchId: string, publicationId: string, maxAttempts: number): Promise<void> {
  await tx.publicationDispatch.update({ where: { id: dispatchId }, data: { status: PublicationDispatchStatus.FAILED, lastError: 'PUBLISHING_MAX_ATTEMPTS_EXCEEDED', needsAttention: true, claimedAt: null, claimExpiresAt: null, claimedBy: null } });
  await tx.publication.update({ where: { id: publicationId }, data: { status: PublicationStatus.FAILED, error: 'PUBLISHING_MAX_ATTEMPTS_EXCEEDED' } });
  await tx.publicationEvent.create({ data: { publicationId, dispatchId, type: 'PUBLICATION_FAILED', payload: json({ errorCode: 'PUBLISHING_MAX_ATTEMPTS_EXCEEDED', maxAttempts }) } });
}

export async function claimNextDispatch(prisma: PrismaClient, owner: string, now: Date, claimSeconds: number, maxAttempts: number): Promise<ClaimedPublicationDispatch | null> {
  const expiresAt = new Date(now.getTime() + claimSeconds * 1000);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM publication_dispatches
      WHERE (
        (status = 'PENDING' AND notBefore <= ${now} AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now}))
        OR
        (status = 'CLAIMED' AND claimExpiresAt IS NOT NULL AND claimExpiresAt <= ${now} AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now}))
      )
      ORDER BY notBefore ASC, createdAt ASC
      LIMIT 1
      FOR UPDATE
    `);
    const id = rows[0]?.id;
    if (!id) return null;
    const dispatch = await tx.publicationDispatch.findUnique({ where: { id }, include: { publication: true, attempts: { orderBy: { attempt: 'desc' }, take: 1 } } });
    if (!dispatch) return null;
    const latest = dispatch.attempts[0] ?? null;

    if (dispatch.status === PublicationDispatchStatus.CLAIMED && latest) {
      const externallyStarted = latest.stage !== PublicationAttemptStage.CLAIMED && latest.stage !== PublicationAttemptStage.TOKEN_READY;
      const recoverable = Boolean(latest.recoveryStateEncrypted || latest.externalOperationId || latest.platformMediaId);
      if (externallyStarted || latest.status === PublicationAttemptStatus.UNKNOWN || recoverable) {
        await tx.publicationDispatch.update({ where: { id }, data: { claimedAt: now, claimExpiresAt: expiresAt, claimedBy: owner, nextAttemptAt: null } });
        if (latest.status !== PublicationAttemptStatus.UNKNOWN) await tx.publicationAttempt.update({ where: { id: latest.id }, data: { status: PublicationAttemptStatus.UNKNOWN, stage: PublicationAttemptStage.RECONCILING, errorCode: 'PROVIDER_STATE_UNKNOWN', safeErrorMessage: 'Publisher claim expired after an external operation; reconciliation is required' } });
        await tx.publicationEvent.create({ data: { publicationId: dispatch.publicationId, dispatchId: id, type: 'RECONCILIATION_CLAIMED', payload: json({ attemptId: latest.id, publisherRunId: owner }) } });
        return { dispatchId: id, publicationId: dispatch.publicationId, attemptId: latest.id, provider: dispatch.publication.platform, mode: 'reconcile' };
      }
      await tx.publicationAttempt.update({ where: { id: latest.id }, data: { status: PublicationAttemptStatus.FAILED, retryable: true, errorCode: 'CLAIM_EXPIRED_BEFORE_EXTERNAL_OPERATION', safeErrorMessage: 'Publisher claim expired before an external operation started', finishedAt: now } });
    }

    if (dispatch.attemptCount >= maxAttempts) {
      await failMaxAttempts(tx, id, dispatch.publicationId, maxAttempts);
      return null;
    }

    const attemptNumber = dispatch.attemptCount + 1;
    const attempt = await tx.publicationAttempt.create({ data: {
      dispatchId: id,
      publicationId: dispatch.publicationId,
      provider: dispatch.publication.platform,
      attempt: attemptNumber,
      status: PublicationAttemptStatus.RUNNING,
      stage: PublicationAttemptStage.CLAIMED,
      startedAt: now,
    } });
    await tx.publicationDispatch.update({ where: { id }, data: { status: PublicationDispatchStatus.CLAIMED, claimedAt: now, claimExpiresAt: expiresAt, claimedBy: owner, nextAttemptAt: null, attemptCount: attemptNumber, lastError: null, needsAttention: false } });
    if ([PublicationStatus.SCHEDULED, PublicationStatus.FAILED, PublicationStatus.NEEDS_ATTENTION].includes(dispatch.publication.status)) {
      await tx.publication.update({ where: { id: dispatch.publicationId }, data: { status: PublicationStatus.PUBLISHING, error: null } });
    }
    await tx.publicationEvent.create({ data: { publicationId: dispatch.publicationId, dispatchId: id, type: 'DISPATCH_CLAIMED', fromStatus: dispatch.status, toStatus: PublicationDispatchStatus.CLAIMED, payload: json({ attemptId: attempt.id, attempt: attemptNumber, publisherRunId: owner }) } });
    return { dispatchId: id, publicationId: dispatch.publicationId, attemptId: attempt.id, provider: dispatch.publication.platform, mode: 'execute' };
  });
}

export async function renewDispatchClaim(prisma: PrismaClient, dispatchId: string, owner: string, now: Date, claimSeconds: number): Promise<boolean> {
  const updated = await prisma.publicationDispatch.updateMany({ where: { id: dispatchId, status: PublicationDispatchStatus.CLAIMED, claimedBy: owner }, data: { claimExpiresAt: new Date(now.getTime() + claimSeconds * 1000) } });
  return updated.count === 1;
}

function recoveryAad(provider: Platform, attemptId: string): string {
  return integrationAad(provider, attemptId, 'recovery');
}

function decryptRecovery(encrypted: string | null, key: string, provider: Platform, attemptId: string): Record<string, unknown> | null {
  if (!encrypted) return null;
  try {
    const parsed = JSON.parse(decryptSecret(encrypted, key, recoveryAad(provider, attemptId))) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    throw new PublishingError('PROVIDER_STATE_UNKNOWN', 'Publisher recovery state cannot be decrypted', false, true);
  }
}

async function persistOperation(prisma: PrismaClient, key: string, claimed: ClaimedPublicationDispatch, operation: ProviderOperationState, stage: PublicationAttemptStage, status?: PublicationAttemptStatus): Promise<void> {
  const recoveryStateEncrypted = operation.recovery ? encryptSecret(JSON.stringify(operation.recovery), key, recoveryAad(claimed.provider, claimed.attemptId)) : null;
  const attemptStatus = status ?? (operation.status === 'SUCCEEDED' ? PublicationAttemptStatus.SUCCEEDED : operation.status === 'FAILED' ? PublicationAttemptStatus.FAILED : operation.status === 'UNKNOWN' ? PublicationAttemptStatus.UNKNOWN : operation.status === 'PROCESSING' ? PublicationAttemptStatus.PROCESSING : PublicationAttemptStatus.RUNNING);
  await prisma.publicationAttempt.update({ where: { id: claimed.attemptId }, data: {
    status: attemptStatus,
    stage,
    externalOperationId: operation.externalOperationId ?? null,
    platformMediaId: operation.platformMediaId ?? null,
    recoveryStateEncrypted,
    retryable: operation.retryable ?? false,
    errorCode: operation.errorCode ?? null,
    safeErrorMessage: operation.safeErrorMessage ?? null,
  } });
}

async function loadAccount(prisma: PrismaClient, config: AppConfig, transport: HttpTransport, claimed: ClaimedPublicationDispatch, profileId: string, now: Date): Promise<DecryptedIntegration> {
  const key = config.appEncryptionKey;
  if (!key) throw new PublishingError('INTEGRATION_NOT_CONNECTED', 'Social credential encryption is not configured');
  let integration;
  try { integration = await loadIntegrationForProfile(prisma, key, profileId, claimed.provider); }
  catch (error) {
    if (error instanceof IntegrationError) throw new PublishingError(error.code === 'PROFILE_PROVIDER_MISMATCH' ? 'PROFILE_INTEGRATION_MISMATCH' : 'INTEGRATION_NOT_CONNECTED', error.message, error.retryable);
    throw error;
  }
  if (!integration.expiresAt || integration.expiresAt.getTime() > now.getTime() + 90_000) return integration;
  if (!integration.refreshToken) {
    await prisma.integrationAccount.update({ where: { id: integration.id }, data: { status: 'REAUTH_REQUIRED', readiness: 'REAUTH_REQUIRED', version: { increment: 1 } } });
    throw new PublishingError('TOKEN_REFRESH_FAILED', 'Integration requires reauthorization');
  }
  const refreshOwner = `${claimed.attemptId}:${randomUUID()}`;
  const acquired = await claimTokenRefresh(prisma, integration.id, refreshOwner, now, 60);
  if (!acquired) throw new PublishingError('TOKEN_REFRESH_FAILED', 'Another publisher is refreshing this integration', true);
  try {
    const refreshed = await refreshOAuthToken(transport, config, claimed.provider, integration.refreshToken, now);
    await persistRefreshedTokens(prisma, key, integration, refreshOwner, refreshed);
  } catch (error) {
    await releaseTokenRefresh(prisma, integration.id, refreshOwner).catch(() => undefined);
    if (error instanceof IntegrationError) throw new PublishingError('TOKEN_REFRESH_FAILED', error.message, error.retryable);
    throw error;
  }
  return loadIntegrationForProfile(prisma, key, profileId, claimed.provider);
}

async function completeSuccess(prisma: PrismaClient, claimed: ClaimedPublicationDispatch, operation: ProviderOperationState, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.SUCCEEDED, stage: PublicationAttemptStage.COMPLETED, platformMediaId: operation.platformMediaId ?? null, retryable: false, errorCode: null, safeErrorMessage: null, finishedAt: now } });
    await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.COMPLETED, claimedAt: null, claimExpiresAt: null, claimedBy: null, nextAttemptAt: null, lastError: null, needsAttention: false } });
    await tx.publication.update({ where: { id: claimed.publicationId }, data: { status: PublicationStatus.PUBLISHED, platformId: operation.platformMediaId ?? operation.externalOperationId ?? null, url: operation.publishedUrl ?? null, publishedAt: now, error: null } });
    await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_CONFIRMED', fromStatus: PublicationStatus.PUBLISHING, toStatus: PublicationStatus.PUBLISHED, payload: json({ attemptId: claimed.attemptId, platformMediaId: operation.platformMediaId ?? null }) } });
  });
}

async function scheduleProcessing(prisma: PrismaClient, claimed: ClaimedPublicationDispatch, now: Date, attempt: number): Promise<void> {
  const next = new Date(now.getTime() + exponentialBackoffMs(Math.max(1, attempt), 0.5));
  await prisma.$transaction(async (tx) => {
    await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.PROCESSING, stage: PublicationAttemptStage.RECONCILING } });
    await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.CLAIMED, claimedBy: null, claimedAt: null, claimExpiresAt: next, nextAttemptAt: next } });
    await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PROVIDER_PROCESSING', payload: json({ attemptId: claimed.attemptId, nextAttemptAt: next.toISOString() }) } });
  });
}

async function handleFailedOperation(prisma: PrismaClient, config: AppConfig, claimed: ClaimedPublicationDispatch, operation: ProviderOperationState, now: Date): Promise<'retry' | 'failed'> {
  const dispatch = await prisma.publicationDispatch.findUniqueOrThrow({ where: { id: claimed.dispatchId }, select: { attemptCount: true } });
  const retryable = operation.retryable === true && dispatch.attemptCount < (config.publisherMaxAttempts ?? 5);
  if (retryable) {
    const next = new Date(now.getTime() + exponentialBackoffMs(dispatch.attemptCount, 0.5));
    await prisma.$transaction(async (tx) => {
      await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.FAILED, retryable: true, errorCode: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', safeErrorMessage: operation.safeErrorMessage ?? 'Temporary provider failure', finishedAt: now } });
      await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.PENDING, claimedAt: null, claimExpiresAt: null, claimedBy: null, nextAttemptAt: next, lastError: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', needsAttention: false } });
      await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_RETRY_SCHEDULED', payload: json({ attemptId: claimed.attemptId, errorCode: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', nextAttemptAt: next.toISOString() }) } });
    });
    return 'retry';
  }
  await prisma.$transaction(async (tx) => {
    await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.FAILED, retryable: false, errorCode: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', safeErrorMessage: operation.safeErrorMessage ?? 'Provider publishing failed', finishedAt: now } });
    await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.FAILED, claimedAt: null, claimExpiresAt: null, claimedBy: null, nextAttemptAt: null, lastError: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', needsAttention: true } });
    await tx.publication.update({ where: { id: claimed.publicationId }, data: { status: PublicationStatus.FAILED, error: operation.safeErrorMessage ?? operation.errorCode ?? 'Provider publishing failed' } });
    await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_FAILED', fromStatus: PublicationStatus.PUBLISHING, toStatus: PublicationStatus.FAILED, payload: json({ attemptId: claimed.attemptId, errorCode: operation.errorCode ?? 'PROVIDER_UPLOAD_FAILED', retryable: false }) } });
  });
  return 'failed';
}

async function handleUnknown(prisma: PrismaClient, config: AppConfig, claimed: ClaimedPublicationDispatch, hasRecovery: boolean, error: PublishingError, now: Date): Promise<'unknown' | 'attention'> {
  if (hasRecovery) {
    const next = new Date(now.getTime() + exponentialBackoffMs(1, 0.5));
    await prisma.$transaction(async (tx) => {
      await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.UNKNOWN, stage: PublicationAttemptStage.RECONCILING, retryable: false, errorCode: 'PROVIDER_STATE_UNKNOWN', safeErrorMessage: error.message } });
      await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.CLAIMED, claimedAt: null, claimedBy: null, claimExpiresAt: next, nextAttemptAt: next, lastError: 'PROVIDER_STATE_UNKNOWN', needsAttention: false } });
      await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_UNKNOWN', payload: json({ attemptId: claimed.attemptId, reconciliationRequired: true, nextAttemptAt: next.toISOString() }) } });
    });
    return 'unknown';
  }
  await prisma.$transaction(async (tx) => {
    await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.UNKNOWN, stage: PublicationAttemptStage.RECONCILING, retryable: false, errorCode: 'PROVIDER_STATE_UNKNOWN', safeErrorMessage: error.message } });
    await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.NEEDS_ATTENTION, claimedAt: null, claimExpiresAt: null, claimedBy: null, nextAttemptAt: null, lastError: 'PROVIDER_STATE_UNKNOWN', needsAttention: true } });
    await tx.publication.update({ where: { id: claimed.publicationId }, data: { status: PublicationStatus.NEEDS_ATTENTION, error: 'External provider state is unknown; manual reconciliation is required' } });
    await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_UNKNOWN', fromStatus: PublicationStatus.PUBLISHING, toStatus: PublicationStatus.NEEDS_ATTENTION, payload: json({ attemptId: claimed.attemptId, reconciliationRequired: true }) } });
  });
  return 'attention';
}

async function processClaim(prisma: PrismaClient, config: AppConfig, registry: PublishingProviderRegistry, transport: HttpTransport, claimed: ClaimedPublicationDispatch, owner: string, logger?: PublisherLogger): Promise<'completed' | 'processing' | 'retry' | 'failed' | 'unknown' | 'attention'> {
  const key = config.appEncryptionKey;
  if (!key) throw new PublishingError('INTEGRATION_NOT_CONNECTED', 'APP_ENCRYPTION_KEY is required for publishing');
  const row = await prisma.publicationDispatch.findUnique({ where: { id: claimed.dispatchId }, include: { asset: true, attempts: { where: { id: claimed.attemptId }, take: 1 } } });
  if (!row) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Claimed dispatch no longer exists');
  const attempt = row.attempts[0];
  if (!attempt) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Publication attempt no longer exists');
  const snapshot = parseSnapshot(row.payloadSnapshot);
  if (!snapshot.profileId) throw new PublishingError('PROFILE_INTEGRATION_MISMATCH', 'Dispatch snapshot has no platform profile');
  if (!row.asset.objectKey || row.asset.storageProvider !== 'R2' || !row.asset.mimeType || row.asset.size === null) throw new PublishingError('PLATFORM_ASSET_INCOMPATIBLE', 'Frozen dispatch asset is not a durable R2 video');
  if (snapshot.publicationId !== claimed.publicationId || snapshot.platform !== claimed.provider || row.assetId !== (object(row.payloadSnapshot).videoAssetId ?? row.assetId)) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Dispatch snapshot does not match durable dispatch identity');

  let operation: ProviderOperationState = {
    status: attempt.status === PublicationAttemptStatus.UNKNOWN ? 'UNKNOWN' : attempt.status === PublicationAttemptStatus.PROCESSING ? 'PROCESSING' : 'READY_TO_UPLOAD',
    ...(attempt.externalOperationId ? { externalOperationId: attempt.externalOperationId } : {}),
    ...(attempt.platformMediaId ? { platformMediaId: attempt.platformMediaId } : {}),
    ...(attempt.recoveryStateEncrypted ? { recovery: decryptRecovery(attempt.recoveryStateEncrypted, key, claimed.provider, claimed.attemptId) ?? undefined } : {}),
  };
  let sideEffectStarted = Boolean(operation.externalOperationId || operation.recovery || claimed.mode === 'reconcile');
  const started = Date.now();
  try {
    if (!(await renewDispatchClaim(prisma, claimed.dispatchId, owner, new Date(), config.publisherClaimSeconds ?? 300))) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Publisher claim ownership was lost');
    const integration = await loadAccount(prisma, config, transport, claimed, snapshot.profileId, new Date());
    const account: ProviderAccount = { integrationId: integration.id, accountId: integration.accountId, displayName: integration.displayName, accessToken: integration.accessToken, scopes: integration.scopes, readiness: providerReadiness(integration.readiness), metadata: integration.metadata };
    const context: ProviderContext = { dispatchId: claimed.dispatchId, publicationId: claimed.publicationId, attemptId: claimed.attemptId, snapshot, asset: { id: row.asset.id, objectKey: row.asset.objectKey, mimeType: row.asset.mimeType, size: row.asset.size, durationSeconds: snapshot.durationSeconds }, account, recovery: operation.recovery ?? null };
    const provider = registry.get(claimed.provider);

    if (claimed.mode === 'reconcile') {
      operation = await provider.reconcile(context, operation);
      await persistOperation(prisma, key, claimed, operation, PublicationAttemptStage.RECONCILING);
    } else {
      await prisma.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { stage: PublicationAttemptStage.TOKEN_READY } });
      const preflight = await provider.preflight(context);
      if (!preflight.ready) {
        operation = { status: 'FAILED', retryable: false, errorCode: preflight.errorCode ?? 'PROVIDER_PERMISSION_DENIED', safeErrorMessage: preflight.safeErrorMessage ?? 'Provider preflight requires operator attention' };
        await persistOperation(prisma, key, claimed, operation, PublicationAttemptStage.TOKEN_READY);
        await prisma.$transaction(async (tx) => {
          await tx.publicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: PublicationAttemptStatus.FAILED, finishedAt: new Date() } });
          await tx.publicationDispatch.update({ where: { id: claimed.dispatchId }, data: { status: PublicationDispatchStatus.NEEDS_ATTENTION, claimedAt: null, claimExpiresAt: null, claimedBy: null, needsAttention: true, lastError: operation.errorCode ?? null } });
          await tx.publication.update({ where: { id: claimed.publicationId }, data: { status: PublicationStatus.NEEDS_ATTENTION, error: operation.safeErrorMessage ?? operation.errorCode ?? 'Provider preflight blocked publishing' } });
          await tx.publicationEvent.create({ data: { publicationId: claimed.publicationId, dispatchId: claimed.dispatchId, type: 'PUBLICATION_FAILED', payload: json({ attemptId: claimed.attemptId, errorCode: operation.errorCode ?? 'PROVIDER_PERMISSION_DENIED', needsAttention: true }) } });
        });
        return 'attention';
      }
      sideEffectStarted = true;
      operation = await provider.initialize(context);
      await persistOperation(prisma, key, claimed, operation, PublicationAttemptStage.INITIALIZED);
    }

    if (operation.status === 'UNKNOWN') return await handleUnknown(prisma, config, claimed, Boolean(operation.externalOperationId || operation.recovery), new PublishingError('PROVIDER_STATE_UNKNOWN', 'Provider state requires reconciliation', false, true), new Date());
    if (operation.status === 'FAILED') return await handleFailedOperation(prisma, config, claimed, operation, new Date());

    let uploadSteps = 0;
    while (operation.status === 'READY_TO_UPLOAD' && uploadSteps < 20) {
      uploadSteps += 1;
      if (!(await renewDispatchClaim(prisma, claimed.dispatchId, owner, new Date(), config.publisherClaimSeconds ?? 300))) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Publisher claim ownership was lost during upload');
      const uploadContext: ProviderContext = { ...context, recovery: operation.recovery ?? null };
      operation = await provider.upload(uploadContext, operation);
      await persistOperation(prisma, key, claimed, operation, PublicationAttemptStage.UPLOADING);
      if (operation.status === 'UNKNOWN') return await handleUnknown(prisma, config, claimed, Boolean(operation.externalOperationId || operation.recovery), new PublishingError('PROVIDER_STATE_UNKNOWN', 'Provider upload state requires reconciliation', false, true), new Date());
      if (operation.status === 'FAILED') return await handleFailedOperation(prisma, config, claimed, operation, new Date());
    }
    if (operation.status === 'READY_TO_UPLOAD') {
      await scheduleProcessing(prisma, claimed, new Date(), row.attemptCount || 1);
      return 'processing';
    }

    if (operation.status === 'PROCESSING') {
      if (!(await renewDispatchClaim(prisma, claimed.dispatchId, owner, new Date(), config.publisherClaimSeconds ?? 300))) throw new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Publisher claim ownership was lost during finalization');
      const finalContext: ProviderContext = { ...context, recovery: operation.recovery ?? null };
      operation = await provider.finalize(finalContext, operation);
      await persistOperation(prisma, key, claimed, operation, operation.status === 'SUCCEEDED' ? PublicationAttemptStage.COMPLETED : PublicationAttemptStage.RECONCILING);
    }
    if (operation.status === 'SUCCEEDED') {
      await completeSuccess(prisma, claimed, operation, new Date());
      logger?.log({ publisherRunId: owner, dispatchId: claimed.dispatchId, publicationId: claimed.publicationId, attemptId: claimed.attemptId, provider: claimed.provider, stage: PublicationAttemptStage.COMPLETED, status: PublicationAttemptStatus.SUCCEEDED, durationMs: Date.now() - started, retryable: false });
      return 'completed';
    }
    if (operation.status === 'FAILED') return await handleFailedOperation(prisma, config, claimed, operation, new Date());
    if (operation.status === 'UNKNOWN') return await handleUnknown(prisma, config, claimed, Boolean(operation.externalOperationId || operation.recovery), new PublishingError('PROVIDER_STATE_UNKNOWN', 'Provider state requires reconciliation', false, true), new Date());
    await scheduleProcessing(prisma, claimed, new Date(), row.attemptCount || 1);
    return 'processing';
  } catch (caught) {
    const error = safePublishingError(caught);
    const persisted = await prisma.publicationAttempt.findUnique({ where: { id: claimed.attemptId }, select: { recoveryStateEncrypted: true, externalOperationId: true, platformMediaId: true, stage: true } });
    const hasRecovery = Boolean(persisted?.recoveryStateEncrypted || persisted?.externalOperationId || persisted?.platformMediaId);
    if (error.ambiguous || (sideEffectStarted && error.retryable)) return handleUnknown(prisma, config, claimed, hasRecovery, new PublishingError('PROVIDER_STATE_UNKNOWN', error.message, false, true), new Date());
    const failed: ProviderOperationState = { status: 'FAILED', retryable: error.retryable, errorCode: error.code, safeErrorMessage: error.message };
    logger?.log({ publisherRunId: owner, dispatchId: claimed.dispatchId, publicationId: claimed.publicationId, attemptId: claimed.attemptId, provider: claimed.provider, stage: persisted?.stage, status: PublicationAttemptStatus.FAILED, durationMs: Date.now() - started, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}), providerErrorCode: error.code, retryable: error.retryable });
    return handleFailedOperation(prisma, config, claimed, failed, new Date());
  }
}

export async function runPublisherTick(prisma: PrismaClient, config: AppConfig, registry: PublishingProviderRegistry, transport: HttpTransport, options: { publisherRunId?: string; logger?: PublisherLogger; now?: () => Date } = {}): Promise<PublisherTickResult> {
  const publisherRunId = options.publisherRunId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const result: PublisherTickResult = { publisherRunId, claimed: 0, completed: 0, processing: 0, retryScheduled: 0, failed: 0, unknown: 0, needsAttention: 0 };
  const batchSize = config.publisherBatchSize ?? 5;
  const claimSeconds = config.publisherClaimSeconds ?? 300;
  const maxAttempts = config.publisherMaxAttempts ?? 5;
  for (let index = 0; index < batchSize; index += 1) {
    const claimed = await claimNextDispatch(prisma, publisherRunId, now(), claimSeconds, maxAttempts);
    if (!claimed) break;
    result.claimed += 1;
    const outcome = await processClaim(prisma, config, registry, transport, claimed, publisherRunId, options.logger);
    if (outcome === 'completed') result.completed += 1;
    else if (outcome === 'processing') result.processing += 1;
    else if (outcome === 'retry') result.retryScheduled += 1;
    else if (outcome === 'failed') result.failed += 1;
    else if (outcome === 'unknown') result.unknown += 1;
    else result.needsAttention += 1;
  }
  options.logger?.log({ publisherRunId, status: 'COMPLETE' });
  return result;
}
