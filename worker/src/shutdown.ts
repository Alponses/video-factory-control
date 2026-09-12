import { log } from './logger.js';

export function createShutdown(workerId: string): AbortController {
  const controller = new AbortController();
  const shutdown = (signal: string) => {
    if (controller.signal.aborted) return;
    log('info', { workerId, event: `shutdown_${signal.toLowerCase()}` });
    controller.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return controller;
}
