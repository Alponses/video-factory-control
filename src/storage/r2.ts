import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { R2Config } from '../config.js';

export interface R2HeadResult {
  size: bigint;
  contentType: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface R2CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface R2ReadResult {
  body: Readable;
  size: bigint;
  contentType: string | null;
  contentRange: string | null;
}

export interface R2Storage {
  readonly bucket: string;
  readonly origin: string;
  presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<string>;
  createMultipart(objectKey: string, contentType: string): Promise<string>;
  presignPart(objectKey: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string>;
  completeMultipart(objectKey: string, uploadId: string, parts: R2CompletedPart[]): Promise<void>;
  abortMultipart(objectKey: string, uploadId: string): Promise<void>;
  headObject(objectKey: string): Promise<R2HeadResult>;
  readObject(objectKey: string, range?: { start: number; end: number }): Promise<R2ReadResult>;
  presignGet(objectKey: string, expiresIn: number): Promise<string>;
}

function normalizeContentType(value: string | undefined): string | null {
  if (!value) return null;
  return value.split(';', 1)[0]?.trim().toLowerCase() || null;
}

export class AwsR2Storage implements R2Storage {
  readonly bucket: string;
  readonly origin: string;
  private readonly client: S3Client;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.origin = config.origin;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: contentType }),
      { expiresIn, signableHeaders: new Set(['content-type']) },
    );
  }

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    const result = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey, ContentType: contentType }));
    if (!result.UploadId) throw new Error('R2_MULTIPART_UPLOAD_ID_MISSING');
    return result.UploadId;
  }

  presignPart(objectKey: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: objectKey, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn },
    );
  }

  async completeMultipart(objectKey: string, uploadId: string, parts: R2CompletedPart[]): Promise<void> {
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })) },
    }));
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey, UploadId: uploadId }));
  }

  async headObject(objectKey: string): Promise<R2HeadResult> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return {
      size: BigInt(result.ContentLength ?? 0),
      contentType: normalizeContentType(result.ContentType),
      etag: result.ETag ?? null,
      metadata: result.Metadata ?? {},
    };
  }

  async readObject(objectKey: string, range?: { start: number; end: number }): Promise<R2ReadResult> {
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) {
      throw new Error('R2_RANGE_INVALID');
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    });
    const result = await this.client.send(command);
    if (!(result.Body instanceof Readable)) throw new Error('R2_STREAM_UNAVAILABLE');
    return {
      body: result.Body,
      size: BigInt(result.ContentLength ?? 0),
      contentType: normalizeContentType(result.ContentType),
      contentRange: result.ContentRange ?? null,
    };
  }

  presignGet(objectKey: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), { expiresIn });
  }
}

export async function runR2Smoke(config: R2Config, prefix = 'smoke-tests'): Promise<void> {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const key = `${prefix}/${Date.now()}-video-factory-smoke.txt`;
  try {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: 'video-factory-r2-smoke', ContentType: 'text/plain' }));
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    const get = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    await get.Body?.transformToByteArray();
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => undefined);
  }
}
