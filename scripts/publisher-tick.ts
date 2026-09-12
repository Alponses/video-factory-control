import { loadConfig } from '../src/config.js';
import { disconnectPrisma, getPrisma } from '../src/db/prisma.js';
import { FetchHttpTransport } from '../src/publishing/http.js';
import { createJsonPublisherLogger } from '../src/publishing/logging.js';
import { runPublisherTick } from '../src/publishing/publisher.js';
import { createPublishingProviderRegistry } from '../src/publishing/runtime.js';
import { AwsR2Storage } from '../src/storage/r2.js';

const logger = createJsonPublisherLogger((line) => process.stdout.write(`${line}\n`));

try {
  const config = loadConfig();
  if (!config.r2) throw new Error('Publisher requires configured private R2 storage');
  if (!config.appEncryptionKey) throw new Error('Publisher requires APP_ENCRYPTION_KEY');
  const transport = new FetchHttpTransport(config.publisherHttpTimeoutMs ?? 30_000);
  const storage = new AwsR2Storage(config.r2);
  const registry = createPublishingProviderRegistry(config, transport, storage);
  await runPublisherTick(getPrisma(), config, registry, transport, { logger });
} catch {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'publisher_tick_failed' })}\n`);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
