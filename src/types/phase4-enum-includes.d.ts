import type { RenderAttemptStatus, VideoStatus } from '@prisma/client';

type Phase4Membership<T> =
  | T
  | (T extends RenderAttemptStatus ? RenderAttemptStatus : never)
  | (T extends VideoStatus ? VideoStatus : never);

declare global {
  interface ReadonlyArray<T> {
    includes(searchElement: Phase4Membership<T>, fromIndex?: number): boolean;
  }

  interface Array<T> {
    includes(searchElement: Phase4Membership<T>, fromIndex?: number): boolean;
  }
}

export {};
