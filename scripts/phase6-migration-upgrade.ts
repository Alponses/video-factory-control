import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const migration = '20260911233000_v5_phase6_scheduler';

async function main() {
  // CI reaches this after applying all migrations to an empty DB. Reconstruct the
  // exact Phase 5 shape, then deploy Phase 6 again without editing old migrations.
  await prisma.$executeRawUnsafe('DROP TABLE `publication_events`');
  await prisma.$executeRawUnsafe('DROP TABLE `publication_dispatches`');

  // Phase 1/5 declared the schedules -> publications FK without an explicit
  // publicationId index, so InnoDB supplied the supporting index automatically.
  // After Phase 6 adds (publicationId,status), MariaDB may use that composite for
  // the FK and discard the generated single-column index. Restore the Phase 5 FK
  // support first; otherwise MariaDB correctly refuses to drop the Phase 6 index.
  await prisma.$executeRawUnsafe('CREATE INDEX `schedules_publicationId_fkey` ON `schedules`(`publicationId`)');
  await prisma.$executeRawUnsafe('ALTER TABLE `schedules` DROP INDEX `schedules_status_scheduledAt_idx`, DROP INDEX `schedules_publicationId_status_idx`');
  await prisma.$executeRawUnsafe("ALTER TABLE `schedules` MODIFY COLUMN `status` VARCHAR(64) NOT NULL");
  await prisma.$executeRawUnsafe('CREATE INDEX `schedules_scheduledAt_status_idx` ON `schedules`(`scheduledAt`, `status`)');
  await prisma.$executeRawUnsafe('DELETE FROM `_prisma_migrations` WHERE `migration_name` = ?', migration);
  await prisma.$disconnect();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });

  const verify = new PrismaClient();
  try {
    const dispatchTable = await verify.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publication_dispatches'",
    );
    const eventTable = await verify.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publication_events'",
    );
    const statusType = await verify.$queryRawUnsafe<Array<{ columnType: string }>>(
      "SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules' AND COLUMN_NAME = 'status'",
    );
    const publicationIndex = await verify.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules' AND INDEX_NAME = 'schedules_publicationId_status_idx' AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = 'publicationId'",
    );
    if (
      Number(dispatchTable[0]?.count ?? 0n) !== 1
      || Number(eventTable[0]?.count ?? 0n) !== 1
      || !statusType[0]?.columnType.includes('DISPATCHED')
      || Number(publicationIndex[0]?.count ?? 0n) !== 1
    ) {
      throw new Error('Phase 5 -> Phase 6 migration verification failed');
    }
    process.stdout.write(`${JSON.stringify({ phase5ToPhase6: 'PASS', migration })}\n`);
  } finally {
    await verify.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
