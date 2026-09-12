export type PublishingErrorCode =
  | 'INTEGRATION_NOT_CONNECTED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'TOKEN_REFRESH_IN_PROGRESS'
  | 'INSUFFICIENT_SCOPE'
  | 'PROVIDER_AUDIT_REQUIRED'
  | 'PROVIDER_PERMISSION_DENIED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PLATFORM_ASSET_INCOMPATIBLE'
  | 'PROVIDER_UPLOAD_FAILED'
  | 'PROVIDER_PROCESSING_FAILED'
  | 'PROVIDER_STATE_UNKNOWN'
  | 'PROVIDER_TEMPORARY_UNAVAILABLE'
  | 'PUBLISHING_MAX_ATTEMPTS_EXCEEDED'
  | 'PROFILE_INTEGRATION_MISMATCH'
  | 'PUBLISHING_SETTINGS_REQUIRED'
  | 'PUBLISHER_INTERNAL_ERROR';

export class PublishingError extends Error {
  constructor(
    public readonly code: PublishingErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly ambiguous = false,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PublishingError';
  }
}

export function safePublishingError(error: unknown): PublishingError {
  if (error instanceof PublishingError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new PublishingError('PROVIDER_STATE_UNKNOWN', 'Provider request timed out with unknown external state', false, true);
  }
  return new PublishingError('PUBLISHER_INTERNAL_ERROR', 'Publisher operation failed safely');
}
