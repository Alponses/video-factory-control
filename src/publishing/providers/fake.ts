import type { Platform } from '@prisma/client';
import type { ProviderContext, ProviderOperationState, ProviderPreflightResult, PublishingProvider } from '../provider.js';

export type FakeStep = 'success' | 'processing' | 'unknown-after-create' | 'retryable-failure' | 'permanent-failure';

export class FakePublishingProvider implements PublishingProvider {
  public initializeCalls = 0;
  public uploadCalls = 0;
  public reconcileCalls = 0;
  public finalizeCalls = 0;

  constructor(readonly platform: Platform, private readonly behavior: FakeStep = 'success') {}

  async preflight(_context: ProviderContext): Promise<ProviderPreflightResult> {
    return { ready: true, readiness: 'READY' };
  }

  async initialize(context: ProviderContext): Promise<ProviderOperationState> {
    this.initializeCalls += 1;
    const existing = typeof context.recovery?.operationId === 'string' ? context.recovery.operationId : undefined;
    if (existing) return { status: 'READY_TO_UPLOAD', externalOperationId: existing, recovery: context.recovery ?? undefined };
    if (this.behavior === 'unknown-after-create') return { status: 'UNKNOWN', externalOperationId: `fake-op-${context.dispatchId}`, recovery: { operationId: `fake-op-${context.dispatchId}`, accepted: true } };
    if (this.behavior === 'retryable-failure') return { status: 'FAILED', retryable: true, errorCode: 'PROVIDER_TEMPORARY_UNAVAILABLE', safeErrorMessage: 'temporary' };
    if (this.behavior === 'permanent-failure') return { status: 'FAILED', retryable: false, errorCode: 'PROVIDER_PERMISSION_DENIED', safeErrorMessage: 'permanent' };
    return { status: 'READY_TO_UPLOAD', externalOperationId: `fake-op-${context.dispatchId}`, recovery: { operationId: `fake-op-${context.dispatchId}` } };
  }

  async upload(_context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    this.uploadCalls += 1;
    return { ...operation, status: this.behavior === 'processing' ? 'PROCESSING' : 'PROCESSING' };
  }

  async reconcile(_context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    this.reconcileCalls += 1;
    if (this.behavior === 'processing') return { ...operation, status: 'PROCESSING' };
    return { ...operation, status: 'SUCCEEDED', platformMediaId: `media-${operation.externalOperationId ?? 'unknown'}`, publishedUrl: `https://example.test/${this.platform.toLowerCase()}/${operation.externalOperationId ?? 'unknown'}` };
  }

  async finalize(context: ProviderContext, operation: ProviderOperationState): Promise<ProviderOperationState> {
    this.finalizeCalls += 1;
    return this.reconcile(context, operation);
  }
}
