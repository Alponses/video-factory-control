import type { Platform, PublicationAttemptStage, PublicationAttemptStatus } from '@prisma/client';

export interface PublisherLogFields {
  publisherRunId?: string;
  dispatchId?: string;
  publicationId?: string;
  attemptId?: string;
  provider?: Platform;
  stage?: PublicationAttemptStage;
  status?: PublicationAttemptStatus | string;
  durationMs?: number;
  httpStatus?: number;
  providerErrorCode?: string;
  retryable?: boolean;
}

export interface PublisherLogger { log(fields: PublisherLogFields): void }

type WriteLine = (line: string) => void;

export function createJsonPublisherLogger(writeLine: WriteLine, now: () => Date = () => new Date()): PublisherLogger {
  return {
    log(input) {
      const fields: Record<string, unknown> = {
        publisherRunId: input.publisherRunId,
        dispatchId: input.dispatchId,
        publicationId: input.publicationId,
        attemptId: input.attemptId,
        provider: input.provider,
        stage: input.stage,
        status: input.status,
        durationMs: input.durationMs,
        httpStatus: input.httpStatus,
        providerErrorCode: input.providerErrorCode,
        retryable: input.retryable,
      };
      const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      writeLine(JSON.stringify({ timestamp: now().toISOString(), level: 'info', event: 'publisher', ...defined }));
    },
  };
}
