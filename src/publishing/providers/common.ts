import { PublishingError } from '../errors.js';
import { classifyProviderHttp } from '../retry.js';
import type { HttpResponse } from '../http.js';

export async function requireProviderJson<T>(response: HttpResponse, fallbackCode: 'PROVIDER_UPLOAD_FAILED' | 'PROVIDER_PROCESSING_FAILED' = 'PROVIDER_UPLOAD_FAILED'): Promise<T> {
  const classified = classifyProviderHttp(response.status, response.headers);
  if (classified) throw classified;
  try {
    return await response.json<T>();
  } catch {
    throw new PublishingError(fallbackCode, 'Provider returned an invalid JSON response');
  }
}

export function safeIntegerSize(size: bigint): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value <= 0) throw new PublishingError('PLATFORM_ASSET_INCOMPATIBLE', 'Video size cannot be represented safely for provider upload');
  return value;
}

export function recoveryString(recovery: Record<string, unknown> | undefined | null, key: string): string | undefined {
  const value = recovery?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function recoveryNumber(recovery: Record<string, unknown> | undefined | null, key: string): number | undefined {
  const value = recovery?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
