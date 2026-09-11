import type { RenderAttemptStatus, VideoStatus } from '@prisma/client';

declare global {
  interface ReadonlyArray<T> {
    includes(
      searchElement:
        | T
        | (T extends RenderAttemptStatus ? RenderAttemptStatus : never)
        | (T extends VideoStatus ? VideoStatus : never),
      fromIndex?: number,
    ): boolean;
  }
}

export {};
