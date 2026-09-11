import type { R2CompletedPart, R2HeadResult, R2Storage } from '../../src/storage/r2.js';

export class FakeR2Storage implements R2Storage {
  readonly bucket = 'video-factory-test';
  readonly origin = 'https://test-account.r2.cloudflarestorage.com';
  readonly objects = new Map<string, R2HeadResult>();
  readonly aborted: string[] = [];
  readonly completed: Array<{ key: string; uploadId: string; parts: R2CompletedPart[] }> = [];
  private counter = 0;

  async presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<string> {
    this.counter += 1;
    return `${this.origin}/${this.bucket}/${encodeURIComponent(objectKey)}?X-Amz-Signature=fake-${this.counter}&X-Amz-Expires=${expiresIn}&content-type=${encodeURIComponent(contentType)}`;
  }

  async createMultipart(objectKey: string, _contentType: string): Promise<string> {
    this.counter += 1;
    return `upload-${this.counter}-${objectKey.length}`;
  }

  async presignPart(objectKey: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string> {
    this.counter += 1;
    return `${this.origin}/${this.bucket}/${encodeURIComponent(objectKey)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&X-Amz-Signature=fake-${this.counter}&X-Amz-Expires=${expiresIn}`;
  }

  async completeMultipart(objectKey: string, uploadId: string, parts: R2CompletedPart[]): Promise<void> {
    this.completed.push({ key: objectKey, uploadId, parts });
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    this.aborted.push(`${objectKey}:${uploadId}`);
  }

  async headObject(objectKey: string): Promise<R2HeadResult> {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error('NoSuchKey');
    return object;
  }

  async presignGet(objectKey: string, expiresIn: number): Promise<string> {
    this.counter += 1;
    return `${this.origin}/${this.bucket}/${encodeURIComponent(objectKey)}?X-Amz-Signature=get-${this.counter}&X-Amz-Expires=${expiresIn}`;
  }

  putObject(objectKey: string, size: bigint, contentType: string): void {
    this.objects.set(objectKey, { size, contentType, etag: '"fake-etag"', metadata: {} });
  }
}
