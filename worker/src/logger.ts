export type LogLevel = 'info' | 'warn' | 'error';
export interface LogFields {
  workerId?: string | undefined;
  event?: string | undefined;
  videoId?: string | undefined;
  attempt?: number | undefined;
  progress?: number | undefined;
  durationMs?: number | undefined;
  errorCode?: string | undefined;
}

export function log(level: LogLevel, fields: LogFields): void {
  const entry: Record<string, unknown> = { timestamp: new Date().toISOString(), level };
  for (const key of ['workerId', 'event', 'videoId', 'attempt', 'progress', 'durationMs', 'errorCode'] as const) {
    const value = fields[key];
    if (value !== undefined) entry[key] = value;
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
