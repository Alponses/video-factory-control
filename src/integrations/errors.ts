export type IntegrationErrorCode =
  | 'SOCIAL_PROVIDER_NOT_CONFIGURED'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_PROVIDER_MISMATCH'
  | 'INTEGRATION_ACCOUNT_CONFLICT'
  | 'INTEGRATION_NOT_CONNECTED'
  | 'INTEGRATION_DECRYPT_FAILED'
  | 'OAUTH_STATE_MISSING'
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_STATE_EXPIRED'
  | 'OAUTH_STATE_USED'
  | 'OAUTH_PROVIDER_MISMATCH'
  | 'OAUTH_TOKEN_EXCHANGE_FAILED'
  | 'OAUTH_IDENTITY_FAILED'
  | 'FACEBOOK_PAGE_SELECTION_REQUIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'TOKEN_REFRESH_IN_PROGRESS';

export class IntegrationError extends Error {
  constructor(public readonly code: IntegrationErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'IntegrationError';
  }
}
