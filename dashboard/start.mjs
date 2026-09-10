import { startDashboardServer } from './server.mjs';
import { startTikTokOAuthServer } from './tiktok-oauth.mjs';

const dashboard = await startDashboardServer();
const tiktok = await startTikTokOAuthServer();

console.log(`Video Factory Admin: http://127.0.0.1:${dashboard.address().port}`);
console.log(`TikTok OAuth: http://127.0.0.1:${tiktok.address().port}`);

async function shutdown() {
  await Promise.all([
    new Promise(resolve => dashboard.close(resolve)),
    new Promise(resolve => tiktok.close(resolve))
  ]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    try { await shutdown(); } finally { process.exit(0); }
  });
}
