import { loadConfig } from '../src/config.js';
import { runR2Smoke } from '../src/storage/r2.js';

const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
const missing = required.filter((key) => !process.env[key]?.trim());

if (missing.length > 0) {
  process.stdout.write(`${JSON.stringify({ result: 'SKIPPED', reason: 'R2 credentials not configured', missing })}\n`);
  process.exitCode = 0;
} else {
  const config = loadConfig();
  if (!config.r2) throw new Error('R2 configuration was expected but is unavailable');
  await runR2Smoke(config.r2);
  process.stdout.write(`${JSON.stringify({ result: 'PASS', prefix: 'smoke-tests/' })}\n`);
}
