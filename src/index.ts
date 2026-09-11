import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { getPrisma } from './db/prisma.js';

export const VIDEO_FACTORY_VERSION = '5.0.0-phase.3';
export const VIDEO_FACTORY_PHASE = 3 as const;

export function runtimeDescriptor() {
  return { name: 'video-factory-v5' as const, phase: VIDEO_FACTORY_PHASE, nodeMajor: 22 as const };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  const app = createApp(config, { prisma });
  const server = app.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event: 'server_started', port: config.port })}\n`);
  });
  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'startup_failed', error: error instanceof Error ? error.message : 'unknown' })}\n`);
    process.exitCode = 1;
  });
}
