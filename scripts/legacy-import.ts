import { disconnectPrisma, getPrisma } from '../src/db/prisma.js';
import { importLegacy } from '../src/legacy/importer.js';

try {
  const report = await importLegacy(getPrisma(), process.env.VIDEO_FACTORY_ROOT ?? process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Legacy import failed');
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
