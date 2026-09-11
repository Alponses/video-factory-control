import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { ControlPlaneClient, UploadSession } from './api-client.js';
import type { WorkerConfig } from './config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function putStream(url: string, headers: Record<string, string>, filePath: string): Promise<string | null> {
  const init: RequestInit & { duplex: 'half' } = { method: 'PUT', headers, body: createReadStream(filePath) as unknown as BodyInit, duplex: 'half' };
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`R2_PUT_${response.status}`);
  return response.headers.get('etag');
}

async function putPart(url: string, buffer: Uint8Array): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body: buffer });
  if (!response.ok) throw new Error(`R2_PART_${response.status}`);
  const eTag = response.headers.get('etag');
  if (!eTag) throw new Error('R2_PART_ETAG_MISSING');
  return eTag;
}

function isRetryableUpload(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof TypeError || error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return /^R2_(?:PUT|PART)_(?:401|403|408|409|425|429|5\d\d)$/.test(error.message)
    || /^HTTP_(?:408|409|425|429|5\d\d)$/.test(error.message)
    || ['UPLOAD_SESSION_EXPIRED', 'R2_UPLOAD_FAILED', 'R2_FINALIZE_FAILED'].includes(error.message);
}

async function freshSession(client: ControlPlaneClient, videoId: string, leaseToken: string, createKey: string, filePath: string, size: bigint, sha256: string): Promise<UploadSession> {
  return client.createOutputUpload(videoId, leaseToken, createKey, {
    mimeType: 'video/mp4',
    size: size.toString(),
    sha256,
    originalFilename: filePath.split('/').pop() ?? 'video.mp4',
  });
}

async function singleUpload(config: WorkerConfig, client: ControlPlaneClient, session: UploadSession, videoId: string, leaseToken: string, createKey: string, filePath: string, size: bigint, sha256: string): Promise<UploadSession> {
  let current = session;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.r2UploadMaxRetries; attempt += 1) {
    try {
      if (!current.uploadUrl) current = await freshSession(client, videoId, leaseToken, createKey, filePath, size, sha256);
      if (!current.uploadUrl) throw new Error('R2_UPLOAD_URL_MISSING');
      await putStream(current.uploadUrl, current.requiredHeaders, filePath);
      return current;
    } catch (error) {
      lastError = error;
      if (attempt >= config.r2UploadMaxRetries || !isRetryableUpload(error)) throw error;
      await sleep(150 * attempt);
      current = await freshSession(client, videoId, leaseToken, createKey, filePath, size, sha256);
    }
  }
  throw lastError;
}

async function multipartUpload(config: WorkerConfig, client: ControlPlaneClient, session: UploadSession, leaseToken: string, filePath: string, size: bigint): Promise<Array<{ partNumber: number; eTag: string }>> {
  if (!session.partSizeBytes || session.partSizeBytes < 5 * 1024 * 1024) throw new Error('MULTIPART_PART_SIZE_INVALID');
  const partSize = BigInt(session.partSizeBytes);
  const partCount = Number((size + partSize - 1n) / partSize);
  if (partCount < 1 || partCount > 10_000) throw new Error('MULTIPART_PART_COUNT_INVALID');
  const handle = await open(filePath, 'r');
  const completed: Array<{ partNumber: number; eTag: string }> = [];
  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const offset = BigInt(partNumber - 1) * partSize;
      const remaining = size - offset;
      const length = Number(remaining < partSize ? remaining : partSize);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, Number(offset));
      let lastError: unknown;
      for (let attempt = 1; attempt <= config.r2UploadMaxRetries; attempt += 1) {
        try {
          const signed = await client.uploadParts(session.sessionId, leaseToken, [partNumber]);
          const url = signed.parts[0]?.uploadUrl;
          if (!url) throw new Error('R2_PART_URL_MISSING');
          const eTag = await putPart(url, buffer);
          completed.push({ partNumber, eTag });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= config.r2UploadMaxRetries || !isRetryableUpload(error)) throw error;
          await sleep(150 * attempt);
        }
      }
      if (lastError) throw lastError;
    }
    return completed;
  } finally {
    await handle.close();
  }
}

export interface DurableUploadResult {
  assetId: string;
  sessionId: string;
  size: bigint;
  sha256: string;
}

export async function uploadDurableOutput(config: WorkerConfig, client: ControlPlaneClient, videoId: string, leaseToken: string, filePath: string): Promise<DurableUploadResult> {
  const info = await stat(filePath);
  const size = BigInt(info.size);
  const sha256 = await sha256File(filePath);
  const createKey = `asset-create-${randomUUID()}`;
  const finalizeKey = `asset-finalize-${randomUUID()}`;
  let session = await freshSession(client, videoId, leaseToken, createKey, filePath, size, sha256);
  try {
    let parts: Array<{ partNumber: number; eTag: string }> = [];
    if (session.mode === 'SINGLE') {
      session = await singleUpload(config, client, session, videoId, leaseToken, createKey, filePath, size, sha256);
    } else {
      parts = await multipartUpload(config, client, session, leaseToken, filePath, size);
    }
    const asset = await client.finalizeUpload(session.sessionId, leaseToken, finalizeKey, parts);
    if (asset.status !== 'READY') throw new Error('R2_ASSET_NOT_READY');
    return { assetId: asset.id, sessionId: session.sessionId, size, sha256 };
  } catch (error) {
    try { await client.abortUpload(session.sessionId, leaseToken); } catch { /* lease expiry/server reconciliation owns cleanup */ }
    throw error;
  }
}
