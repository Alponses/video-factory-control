import { disconnectPrisma, getPrisma } from '../src/db/prisma.js';
import { verifyLegacy } from '../src/legacy/verifier.js';

try {
  const report = await verifyLegacy(getPrisma(), process.env.VIDEO_FACTORY_ROOT ?? process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== 'PASS') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Legacy verification failed');
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
