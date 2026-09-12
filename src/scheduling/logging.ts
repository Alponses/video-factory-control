import type { Platform } from '@prisma/client';

export interface SchedulerRunLogFields {
  schedulerRunId: string;
  leaseOwner: string;
  startedAt: string;
  durationMs: number;
  dueFound: number;
  dispatched: number;
  alreadyDispatched: number;
  late: number;
  failed: number;
}

export interface SchedulerItemLogFields {
  publicationId?: string;
  scheduleId: string;
  dispatchId?: string;
  platform?: Platform;
  errorCode?: string;
  latenessSeconds?: number;
}

export interface SchedulerLogger {
  logRun(fields: SchedulerRunLogFields): void;
  logItem(fields: SchedulerItemLogFields): void;
}

type WriteLine = (line: string) => void;

function defined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function createJsonSchedulerLogger(writeLine: WriteLine, now: () => Date = () => new Date()): SchedulerLogger {
  const emit = (event: 'scheduler_tick_complete' | 'scheduler_item', fields: Record<string, unknown>) => {
    writeLine(JSON.stringify({ timestamp: now().toISOString(), level: 'info', event, ...defined(fields) }));
  };

  return {
    logRun(input) {
      emit('scheduler_tick_complete', {
        schedulerRunId: input.schedulerRunId,
        leaseOwner: input.leaseOwner,
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        dueFound: input.dueFound,
        dispatched: input.dispatched,
        alreadyDispatched: input.alreadyDispatched,
        late: input.late,
        failed: input.failed,
      });
    },
    logItem(input) {
      emit('scheduler_item', {
        publicationId: input.publicationId,
        scheduleId: input.scheduleId,
        dispatchId: input.dispatchId,
        platform: input.platform,
        errorCode: input.errorCode,
        latenessSeconds: input.latenessSeconds,
      });
    },
  };
}
