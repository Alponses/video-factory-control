import { loadConfig } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/db/prisma.js';
import { createJsonSchedulerLogger } from '../src/scheduling/logging.js';
import { runSchedulerTick } from '../src/scheduling/scheduler.js';

const logger = createJsonSchedulerLogger((line) => process.stdout.write(`${line}\n`));

try {
  const config = loadConfig();
  await runSchedulerTick(getPrisma(), config, { logger });
} catch {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'scheduler_tick_failed' })}\n`);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
