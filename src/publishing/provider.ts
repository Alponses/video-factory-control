import type { Platform } from '@prisma/client';

export type ProviderReadiness = 'READY' | 'PRIVATE_ONLY_UNAUDITED' | 'PRIVATE_ONLY_UNVERIFIED' | 'INSUFFICIENT_SCOPE' | 'REAUTH_REQUIRED' | 'PLATFORM_ASSET_INCOMPATIBLE';

export interface PublisherAsset {
  id: string;
  objectKey: string;
  mimeType: string;
  size: bigint;
  durationSeconds: number | null;
}

export interface PublisherSnapshot {
  publicationId: string;
  videoId: string;
  platform: Platform;
  profileId: string | null;
  title: string | null;
  caption: string | null;
  description: string | null;
  hashtags: string[];
  tags: string[];
  tiktok: null | { privacyLevel: string | null; allowComment: boolean | null; allowDuet: boolean | null; allowStitch: boolean | null; isAigc: boolean | null };
  youtube: null | { privacyStatus: string | null; categoryId: string | null; madeForKids: boolean | null; containsSyntheticMedia: boolean | null };
}

export interface ProviderAccount {
  integrationId: string;
  accountId: string;
  displayName: string | null;
  accessToken: string;
  scopes: string[];
  readiness: ProviderReadiness;
  metadata: Record<string, unknown>;
}

export interface ProviderContext {
  dispatchId: string;
  publicationId: string;
  attemptId: string;
  snapshot: PublisherSnapshot;
  asset: PublisherAsset;
  account: ProviderAccount;
  recovery: Record<string, unknown> | null;
}

export interface ProviderPreflightResult {
  ready: boolean;
  readiness: ProviderReadiness;
  errorCode?: string;
  safeErrorMessage?: string;
}

export interface ProviderOperationState {
  externalOperationId?: string;
  platformMediaId?: string;
  recovery?: Record<string, unknown>;
  status: 'READY_TO_UPLOAD' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  retryable?: boolean;
  errorCode?: string;
  safeErrorMessage?: string;
  publishedUrl?: string;
}

export interface PublishingProvider {
  readonly platform: Platform;
  preflight(context: ProviderContext): Promise<ProviderPreflightResult>;
  initialize(context: ProviderContext): Promise<ProviderOperationState>;
  upload(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState>;
  reconcile(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState>;
  finalize(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState>;
}

export class PublishingProviderRegistry {
  private readonly providers = new Map<Platform, PublishingProvider>();
  constructor(providers: PublishingProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.platform)) throw new Error(`DUPLICATE_PUBLISHING_PROVIDER:${provider.platform}`);
      this.providers.set(provider.platform, provider);
    }
  }
  get(platform: Platform): PublishingProvider {
    const provider = this.providers.get(platform);
    if (!provider) throw new Error(`PUBLISHING_PROVIDER_NOT_CONFIGURED:${platform}`);
    return provider;
  }
}
