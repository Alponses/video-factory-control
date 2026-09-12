import path from 'node:path';
import { AssetKind } from '@prisma/client';
import { ApiError } from '../http/errors.js';

export const VIDEO_MAX_BYTES = 2n * 1024n * 1024n * 1024n;
export const IMAGE_MAX_BYTES = 20n * 1024n * 1024n;
export const AUDIO_MAX_BYTES = 200n * 1024n * 1024n;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_PART_PRESIGNS_PER_REQUEST = 100;

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav']);

export function normalizeMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function validateAssetInput(kind: AssetKind, mimeType: string, size: bigint): { mimeType: string; maxBytes: bigint } {
  const normalized = normalizeMime(mimeType);
  let allowed: Set<string>;
  let maxBytes: bigint;
  switch (kind) {
    case AssetKind.VIDEO:
      allowed = new Set(['video/mp4']);
      maxBytes = VIDEO_MAX_BYTES;
      break;
    case AssetKind.COVER:
    case AssetKind.THUMBNAIL:
    case AssetKind.AVATAR:
    case AssetKind.BANNER:
      allowed = IMAGE_MIMES;
      maxBytes = IMAGE_MAX_BYTES;
      break;
    case AssetKind.AUDIO:
      allowed = AUDIO_MIMES;
      maxBytes = AUDIO_MAX_BYTES;
      break;
    default:
      throw new ApiError(400, 'ASSET_INVALID_TYPE', 'This asset kind is not uploadable');
  }
  if (!allowed.has(normalized)) throw new ApiError(400, 'ASSET_INVALID_TYPE', 'MIME type is not allowed for this asset kind');
  if (size <= 0n || size > maxBytes) throw new ApiError(413, 'ASSET_TOO_LARGE', 'Asset size is outside the allowed range');
  return { mimeType: normalized, maxBytes };
}

function extensionFor(kind: AssetKind, mimeType: string): string {
  if (kind === AssetKind.VIDEO) return 'mp4';
  if (kind === AssetKind.AUDIO) return mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

function basenameFor(kind: AssetKind): string {
  switch (kind) {
    case AssetKind.VIDEO: return 'video';
    case AssetKind.COVER: return 'cover';
    case AssetKind.THUMBNAIL: return 'thumbnail';
    case AssetKind.AUDIO: return 'audio';
    case AssetKind.AVATAR: return 'avatar';
    case AssetKind.BANNER: return 'banner';
    default: return 'asset';
  }
}

export function videoObjectKey(channelId: string, videoId: string, assetId: string, kind: AssetKind, mimeType: string): string {
  return `channels/${channelId}/videos/${videoId}/assets/${assetId}/${basenameFor(kind)}.${extensionFor(kind, mimeType)}`;
}

export function profileObjectKey(channelId: string, profileId: string, assetId: string, kind: AssetKind, mimeType: string): string {
  return `channels/${channelId}/profiles/${profileId}/assets/${assetId}/${basenameFor(kind)}.${extensionFor(kind, mimeType)}`;
}

export function safeOriginalFilename(value: string | null | undefined): string | null {
  if (!value) return null;
  const slashNormalized = value.replace(/\\/g, '/');
  const base = path.posix.basename(slashNormalized).normalize('NFKC');
  const safe = base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\.{2,}/g, '.').slice(0, 255).trim();
  return safe || null;
}

export function expectedPartCount(size: bigint, partSizeBytes: number): number {
  const partSize = BigInt(partSizeBytes);
  const count = Number((size + partSize - 1n) / partSize);
  if (count < 1 || count > MAX_MULTIPART_PARTS) throw new ApiError(400, 'MULTIPART_INVALID_PART', 'Multipart upload would exceed the allowed part count');
  return count;
}
