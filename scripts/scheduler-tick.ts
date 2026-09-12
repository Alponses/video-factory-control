import { loadConfig } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/db/prisma.js';
import { runSchedulerTick } from '../src/scheduling/scheduler.js';

try {
  const config = loadConfig();
  const result = await runSchedulerTick(getPrisma(), config);
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event: 'scheduler_tick_complete', ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'scheduler_tick_failed', error: error instanceof Error ? error.message : 'unknown' })}\n`);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
