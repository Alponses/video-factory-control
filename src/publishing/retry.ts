import { PublishingError } from './errors.js';
import { retryAfterMs } from './http.js';

export function classifyProviderHttp(status: number, headers: Headers): PublishingError | null {
  if (status >= 200 && status < 400) return null;
  const retryAfter = retryAfterMs(headers);
  if (status === 429) return new PublishingError('PROVIDER_RATE_LIMITED', 'Provider rate limit reached', true, false, status, retryAfter);
  if ([500, 502, 503, 504].includes(status)) return new PublishingError('PROVIDER_TEMPORARY_UNAVAILABLE', 'Provider is temporarily unavailable', true, false, status, retryAfter);
  if (status === 401) return new PublishingError('TOKEN_EXPIRED', 'Provider access token is no longer valid', false, false, status);
  if (status === 403) return new PublishingError('PROVIDER_PERMISSION_DENIED', 'Provider denied this operation', false, false, status);
  return new PublishingError('PROVIDER_UPLOAD_FAILED', `Provider rejected request with HTTP ${status}`, false, false, status);
}

export function exponentialBackoffMs(attempt: number, seed = 0.5): number {
  const safeAttempt = Math.max(1, Math.min(10, attempt));
  const base = Math.min(60 * 60 * 1000, 5_000 * (2 ** (safeAttempt - 1)));
  const jitter = 0.75 + Math.max(0, Math.min(1, seed)) * 0.5;
  return Math.round(base * jitter);
}
