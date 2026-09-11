import type { NextFunction, Request, Response } from 'express';

const SENSITIVE_KEY = /(authorization|cookie|cf-access-jwt-assertion|token|accessToken|refreshToken|clientSecret|database.?url)/i;
const SENSITIVE_URL = /^(mysql|mariadb):\/\//i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item)]));
  }
  if (typeof value === 'string' && SENSITIVE_URL.test(value)) return '[REDACTED]';
  return value;
}

export interface Logger {
  log(entry: Record<string, unknown>): void;
}

export const consoleJsonLogger: Logger = {
  log(entry) {
    process.stdout.write(`${JSON.stringify(redact(entry))}\n`);
  },
};

export function requestLogger(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      logger.log({
        timestamp: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        requestId: req.requestId,
        method: req.method,
        route: req.route?.path ?? req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        actorType: req.actor?.type,
        actorEmail: req.actor?.email,
      });
    });
    next();
  };
}
