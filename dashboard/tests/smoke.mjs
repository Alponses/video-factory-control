import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDashboardServer,
  deepMerge,
  getMergedJob,
  sanitizeOverride
} from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-factory-v41-'));
const mkdir = relative => fs.mkdir(path.join(root, relative), { recursive: true });
const write = async (relative, value) => {
  await mkdir(path.dirname(relative));
  await fs.writeFile(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
};

const validPublishing = {
  tiktok: {
    status: 'pending',
    caption: 'Una pausa sencilla para terminar el día con calma. 🌙🙏❤️',
    hashtags: ['#OracionDeLaNoche', '#PazInterior', '#Fe', '#PausaConFe'],
    searchKeyword: 'oración para dormir',
    coverText: 'Descansa esta noche',
    cta: 'Guárdalo para escucharlo después.',
    pinnedComment: '¿Qué quieres dejar para mañana?',
    url: null,
    videoId: null,
    scheduledAt: null,
    publishedAt: null
  },
  youtube: {
    status: 'pending',
    title: 'Una reflexión para descansar esta noche',
    description: 'Esta reflexión nocturna te acompaña a cerrar el día con calma. 🌙🙏',
    hashtags: ['#ReflexionNocturna', '#Fe', '#PausaConFe'],
    tags: ['reflexión nocturna'],
    thumbnailText: 'Descansa esta noche',
    cta: 'Guárdalo.',
    pinnedComment: '¿Qué agradeces hoy?',
    url: null,
    videoId: null,
    scheduledAt: null,
    publishedAt: null
  },
  facebook: {
    status: 'pending',
    description: 'Termina el día con una pausa tranquila, agradece lo bueno y deja lo pendiente para mañana. 🌙🙏❤️',
    hashtags: ['#BuenasNoches', '#Fe', '#PausaConFe'],
    coverText: 'Una pausa para ti',
    cta: 'Compártelo.',
    pinnedComment: '¿Qué te dio paz hoy?',
    audience: 'public',
    url: null,
    postId: null,
    scheduledAt: null,
    publishedAt: null
  }
};

await write('config/publishing-rules.json', {
  global: {
    brandHashtag: '#PausaConFe',
    brandHashtagMax: 1,
    blockedAutomaticHashtags: ['#fyp', '#viral', '#parati'],
    emojiAllowlist: ['🙏', '❤️', '✨', '🌅', '🌙', '🕊️', '💛', '🙌', '🌿', '☀️']
  },
  tiktok: { hashtagsMin: 4, hashtagsMax: 6, emojiMin: 3, emojiMax: 6 },
  youtube: { hashtagsMin: 3, hashtagsMax: 5, emojiMin: 2, emojiMax: 4, titleMaxCharacters: 100, officialDescriptionMaxCharacters: 5000 },
  facebook: { hashtagsMin: 3, hashtagsMax: 5, emojiMin: 3, emojiMax: 6 }
});
await write('config/profiles.json', { brand: { displayName: 'Pausa con Fe' }, platforms: {} });
await write('db/jobs/religion-000002.json', {
  id: 'religion-000002',
  title: 'Original title',
  category: 'oracion-noche',
  status: 'approved',
  createdAt: '2026-09-09T14:17:00-06:00',
  scenes: [{ text: 'Narración original', searchTerms: ['night'] }],
  renderConfig: { voice: 'ef_dora' },
  render: { videoId: 'renderer-video-id', durationSeconds: 66.3 },
  qa: { passed: true },
  publishing: { tiktok: { status: 'pending' }, youtube: { status: 'pending' }, facebook: { status: 'pending' } }
});
await write('db/migrations/v3/religion-000002.json', {
  schemaVersion: 3,
  discovery: { primaryKeyword: 'oración de noche' },
  cover: { headline: 'Cover V3' }
});
await write('db/migrations/v4/religion-000002.json', {
  schemaVersion: 4,
  publishing: validPublishing,
  performance: {
    tiktok: { views: null },
    youtube: { views: null },
    facebook: { views: null }
  }
});
await write('dashboard/dashboard-schedule.json', { version: 1, events: [] });

assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: { y: 2 } }), { a: { x: 1, y: 2 } });
const merged = await getMergedJob('religion-000002', root);
assert.equal(merged.title, 'Original title');
assert.equal(merged.discovery.primaryKeyword, 'oración de noche');
assert.equal(merged.cover.headline, 'Cover V3');
assert.equal(merged.publishing.youtube.title, validPublishing.youtube.title);
assert.equal(merged.render.videoId, 'renderer-video-id');
assert.equal(merged.scenes[0].text, 'Narración original');
assert.equal(merged._summary.effectiveStatus, 'approved');
assert.equal(merged._summary.knownViews, null);

const sanitized = sanitizeOverride({
  admin: {},
  publishing: validPublishing,
  scenes: [{ text: 'NO' }],
  render: { videoId: 'NO' },
  renderConfig: { voice: 'NO' },
  qa: { passed: false }
});
assert.equal(Object.hasOwn(sanitized, 'admin'), false);
assert.equal(Object.hasOwn(sanitized, 'scenes'), false);
assert.equal(Object.hasOwn(sanitized, 'render'), false);
assert.equal(Object.hasOwn(sanitized, 'renderConfig'), false);
assert.equal(Object.hasOwn(sanitized, 'qa'), false);

const server = createDashboardServer({ root });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.equal(address.address, '127.0.0.1');
const base = `http://127.0.0.1:${address.port}`;

const configResponse = await fetch(`${base}/api/config`);
assert.equal(configResponse.status, 200);
const configBody = await configResponse.json();
assert.equal(configBody.github.branch, 'main');
assert.equal(configBody.github.tokenConfigured, false);

const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);

const jobs = await fetch(`${base}/api/jobs`);
assert.equal(jobs.status, 200);
const jobsBody = await jobs.json();
assert.equal(jobsBody.jobs.length, 1);
assert.equal(jobsBody.jobs[0].render.videoId, 'renderer-video-id');

const publishingEdit = await fetch(`${base}/api/dashboard/religion-000002`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ publishing: validPublishing })
});
assert.equal(publishingEdit.status, 200);
const savedOverride = JSON.parse(await fs.readFile(path.join(root, 'db/dashboard/religion-000002.json'), 'utf8'));
assert.equal(Object.hasOwn(savedOverride, 'admin'), false);
assert.equal((await getMergedJob('religion-000002', root))._summary.effectiveStatus, 'approved');

const invalid = structuredClone(validPublishing);
invalid.tiktok.hashtags = ['#SoloUno'];
const badResponse = await fetch(`${base}/api/dashboard/religion-000002`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ publishing: invalid })
});
assert.equal(badResponse.status, 400);

await new Promise(resolve => server.close(resolve));

const ignored = execFileSync('git', ['check-ignore', 'dashboard/.secrets.json'], { cwd: repoRoot, encoding: 'utf8' }).trim();
assert.equal(ignored, 'dashboard/.secrets.json');
const repoSecret = path.join(repoRoot, 'dashboard', '.secrets.json');
await fs.writeFile(repoSecret, JSON.stringify({ github: { token: 'test-only-not-a-real-token' } }));
try {
  const gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(gitStatus.includes('dashboard/.secrets.json'), false);
} finally {
  await fs.rm(repoSecret, { force: true });
}

console.log('Smoke tests V4.1: OK');
