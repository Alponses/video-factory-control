import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const migration = '20260911211500_v5_phase5_r2_assets';

async function main() {
  // CI reaches this script after an empty-DB migrate deploy. Reconstruct the exact
  // Phase 4 database shape (Phase 4 used the Phase 1 schema) without editing the
  // historical Phase 1 migration, then deploy Phase 5 again.
  await prisma.$executeRawUnsafe('DROP TABLE `asset_upload_sessions`');
  await prisma.$executeRawUnsafe('ALTER TABLE `video_assets` DROP FOREIGN KEY `video_assets_profileId_fkey`');
  await prisma.$executeRawUnsafe('ALTER TABLE `video_assets` DROP INDEX `video_assets_profileId_kind_idx`, DROP INDEX `video_assets_status_kind_idx`, DROP COLUMN `profileId`');
  await prisma.$executeRawUnsafe('DELETE FROM `_prisma_migrations` WHERE `migration_name` = ?', migration);
  await prisma.$disconnect();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });

  const verify = new PrismaClient();
  try {
    const columns = await verify.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_assets' AND COLUMN_NAME = 'profileId'",
    );
    const tables = await verify.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_upload_sessions'",
    );
    if (Number(columns[0]?.count ?? 0n) !== 1 || Number(tables[0]?.count ?? 0n) !== 1) {
      throw new Error('Phase 4 -> Phase 5 migration verification failed');
    }
    process.stdout.write(`${JSON.stringify({ phase4ToPhase5: 'PASS', migration })}\n`);
  } finally {
    await verify.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
