import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT || 4173);

export const ADMIN_STATUSES = new Set(['review', 'ready', 'scheduled', 'published', 'needs_changes']);
export const PLATFORM_STATUSES = new Set(['pending', 'ready', 'scheduled', 'published', 'failed']);
export const EDITABLE_FIELDS = {
  tiktok: ['caption', 'hashtags', 'searchKeyword', 'coverText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
  youtube: ['title', 'description', 'hashtags', 'tags', 'thumbnailText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
  facebook: ['description', 'hashtags', 'coverText', 'cta', 'pinnedComment', 'audience', 'status', 'scheduledAt', 'publishedAt', 'url', 'postId']
};

const DEFAULT_CHANNEL_ASSETS = {
  tiktok: { profileImage: '/assets/pausa-con-fe-avatar.svg' },
  youtube: { profileImage: '/assets/pausa-con-fe-avatar.svg', bannerImage: '/assets/pausa-con-fe-youtube-banner.svg' },
  facebook: { profileImage: '/assets/pausa-con-fe-avatar.svg', coverImage: '/assets/pausa-con-fe-facebook-cover.svg' }
};

const CHANNEL_ASSET_SLOTS = {
  tiktok: new Set(['profileImage']),
  youtube: new Set(['profileImage', 'bannerImage']),
  facebook: new Set(['profileImage', 'coverImage'])
};

const ALLOWED_UPLOAD_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg']
]);

const processState = {
  renderer: { child: null, logs: [] },
  factory: { child: null, logs: [] }
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(...objects) {
  const result = {};
  for (const source of objects) {
    if (!isPlainObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value);
      else if (isPlainObject(value)) result[key] = deepMerge({}, value);
      else result[key] = value;
    }
  }
  return result;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  await fs.rename(temp, filePath);
  if (mode) {
    try { await fs.chmod(filePath, mode); } catch { /* best effort on non-POSIX */ }
  }
}

function safeJobId(value) {
  if (!/^religion-\d{6}$/.test(value)) throw Object.assign(new Error('Invalid job id'), { statusCode: 400 });
  return value;
}

function safePlatform(value) {
  if (!Object.hasOwn(EDITABLE_FIELDS, value)) throw Object.assign(new Error('Invalid platform'), { statusCode: 400 });
  return value;
}

function appPaths(root = DEFAULT_ROOT) {
  return {
    root,
    publicDir: path.join(root, 'dashboard', 'public'),
    jobsDir: path.join(root, 'db', 'jobs'),
    v3Dir: path.join(root, 'db', 'migrations', 'v3'),
    v4Dir: path.join(root, 'db', 'migrations', 'v4'),
    dashboardDir: path.join(root, 'db', 'dashboard'),
    rulesPath: path.join(root, 'config', 'publishing-rules.json'),
    profilesPath: path.join(root, 'config', 'profiles.json'),
    schedulePath: path.join(root, 'dashboard', 'dashboard-schedule.json'),
    channelsPath: path.join(root, 'dashboard', 'dashboard-channels.json'),
    secretsPath: path.join(root, 'dashboard', '.secrets.json'),
    uploadsDir: path.join(root, 'dashboard', 'uploads')
  };
}

export async function getMergedJob(jobId, root = DEFAULT_ROOT) {
  safeJobId(jobId);
  const paths = appPaths(root);
  const file = `${jobId}.json`;
  const original = await readJson(path.join(paths.jobsDir, file));
  if (!original) return null;
  const v3 = await readJson(path.join(paths.v3Dir, file), {});
  const v4 = await readJson(path.join(paths.v4Dir, file), {});
  const dashboard = await readJson(path.join(paths.dashboardDir, file), {});
  const merged = deepMerge(original, v3, v4, dashboard);
  merged._layers = {
    original: true,
    v3: Object.keys(v3).length > 0,
    v4: Object.keys(v4).length > 0,
    dashboard: Object.keys(dashboard).length > 0
  };
  merged._summary = summarizeJob(merged);
  return merged;
}

export function summarizeJob(job) {
  const platforms = ['tiktok', 'youtube', 'facebook'];
  const publishing = job.publishing || {};
  const performance = job.performance || {};
  const viewValues = platforms
    .map(name => performance?.[name]?.views)
    .filter(value => Number.isFinite(value));
  const scheduled = platforms.map(name => publishing?.[name]?.scheduledAt).filter(Boolean).sort();
  const states = Object.fromEntries(platforms.map(name => [
    name,
    platformConnectionState(name, publishing[name] || {}, performance[name] || {})
  ]));
  return {
    effectiveStatus: job.admin?.status
      || (platforms.every(name => publishing?.[name]?.status === 'published') ? 'published' : (job.status || 'review')),
    durationSeconds: job.render?.durationSeconds ?? null,
    sceneCount: Array.isArray(job.scenes) ? job.scenes.length : 0,
    nextScheduledAt: scheduled[0] || null,
    knownViews: viewValues.length ? viewValues.reduce((sum, value) => sum + value, 0) : null,
    platformStates: states
  };
}

function platformConnectionState(name, publishing, metrics) {
  if (publishing.status === 'failed') return 'sync_error';
  const id = name === 'facebook' ? publishing.postId : publishing.videoId;
  const linked = Boolean(publishing.url || id);
  if (!linked) return 'unpublished';
  const hasMetric = Object.values(metrics || {}).some(value => value !== null && value !== undefined);
  return hasMetric ? 'metrics_connected' : 'published_no_metrics';
}

export async function listJobs(root = DEFAULT_ROOT) {
  const { jobsDir } = appPaths(root);
  let entries = [];
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ids = entries
    .filter(entry => entry.isFile() && /^religion-\d{6}\.json$/.test(entry.name))
    .map(entry => entry.name.replace('.json', ''))
    .sort();
  const jobs = await Promise.all(ids.map(id => getMergedJob(id, root)));
  return jobs.filter(Boolean);
}

export function sanitizeOverride(input = {}) {
  const out = {};

  // V4.1: never invent an admin status. Persist it only when explicitly supplied
  // and valid. Omitting admin from a replacement override removes the admin layer.
  if (isPlainObject(input.admin) && Object.hasOwn(input.admin, 'status')) {
    if (input.admin.status !== null && input.admin.status !== '' && ADMIN_STATUSES.has(input.admin.status)) {
      out.admin = { status: input.admin.status };
    }
  }

  if (isPlainObject(input.publishing)) {
    const publishing = {};
    for (const platform of Object.keys(EDITABLE_FIELDS)) {
      const source = input.publishing[platform];
      if (!isPlainObject(source)) continue;
      const target = {};
      for (const field of EDITABLE_FIELDS[platform]) {
        if (!Object.hasOwn(source, field)) continue;
        let value = source[field];
        if (field === 'status' && !PLATFORM_STATUSES.has(value)) continue;
        if ((field === 'hashtags' || field === 'tags') && !Array.isArray(value)) continue;
        if (Array.isArray(value)) value = value.map(item => String(item).trim()).filter(Boolean);
        else if (value !== null) value = String(value);
        target[field] = value === '' && ['url', 'videoId', 'postId', 'scheduledAt', 'publishedAt'].includes(field)
          ? null
          : value;
      }
      if (Object.keys(target).length) publishing[platform] = target;
    }
    if (Object.keys(publishing).length) out.publishing = publishing;
  }
  return out;
}

function countConfiguredEmojis(text = '', allowlist = []) {
  return allowlist.reduce((sum, emoji) => sum + String(text).split(emoji).length - 1, 0);
}

export async function validateOverrideRules(override, root = DEFAULT_ROOT) {
  const { rulesPath } = appPaths(root);
  const rules = await readJson(rulesPath, {});
  const global = rules.global || {};

  for (const platform of Object.keys(EDITABLE_FIELDS)) {
    const data = override.publishing?.[platform];
    if (!data) continue;
    const r = rules[platform] || {};

    if (Array.isArray(data.hashtags)) {
      const count = data.hashtags.length;
      if (Number.isFinite(r.hashtagsMin) && (count < r.hashtagsMin || count > r.hashtagsMax)) {
        throw Object.assign(new Error(`${platform}: hashtags ${count}; permitido ${r.hashtagsMin}-${r.hashtagsMax}`), { statusCode: 400 });
      }
      if (data.hashtags.some(tag => !/^#[^\s#]+$/.test(tag))) {
        throw Object.assign(new Error(`${platform}: hashtag con formato inválido`), { statusCode: 400 });
      }
      const brand = global.brandHashtag;
      const brandMax = r.brandHashtagMax ?? global.brandHashtagMax ?? 1;
      if (brand && data.hashtags.filter(tag => tag.toLowerCase() === brand.toLowerCase()).length > brandMax) {
        throw Object.assign(new Error(`${platform}: solo se permite un ${brand}`), { statusCode: 400 });
      }
      const blocked = new Set((global.blockedAutomaticHashtags || []).map(tag => tag.toLowerCase()));
      if (data.hashtags.some(tag => blocked.has(tag.toLowerCase()))) {
        throw Object.assign(new Error(`${platform}: contiene hashtag automático bloqueado`), { statusCode: 400 });
      }
      if (data.hashtags.some(tag => /\p{Extended_Pictographic}/u.test(tag))) {
        throw Object.assign(new Error(`${platform}: no se permiten emojis dentro de hashtags`), { statusCode: 400 });
      }
    }

    const mainText = platform === 'tiktok' ? data.caption : data.description;
    if (typeof mainText === 'string') {
      const emojis = countConfiguredEmojis(mainText, global.emojiAllowlist || []);
      if (Number.isFinite(r.emojiMin) && (emojis < r.emojiMin || emojis > r.emojiMax)) {
        throw Object.assign(new Error(`${platform}: emojis ${emojis}; permitido ${r.emojiMin}-${r.emojiMax}`), { statusCode: 400 });
      }
      if (/(?:\p{Extended_Pictographic}\uFE0F?\s*){5,}/u.test(mainText)) {
        throw Object.assign(new Error(`${platform}: no se permiten 5 emojis consecutivos`), { statusCode: 400 });
      }
    }

    if (platform === 'youtube') {
      if (typeof data.title === 'string' && data.title.length > (r.titleMaxCharacters || 100)) {
        throw Object.assign(new Error('youtube: título demasiado largo'), { statusCode: 400 });
      }
      if (typeof data.description === 'string' && data.description.length > (r.officialDescriptionMaxCharacters || 5000)) {
        throw Object.assign(new Error('youtube: descripción demasiado larga'), { statusCode: 400 });
      }
    }
  }
}

export async function writeDashboardOverride(jobId, input, root = DEFAULT_ROOT) {
  safeJobId(jobId);
  const paths = appPaths(root);
  const override = sanitizeOverride(input);
  await validateOverrideRules(override, root);
  await writeJsonAtomic(path.join(paths.dashboardDir, `${jobId}.json`), override);
  return override;
}

async function loadSecrets(root = DEFAULT_ROOT) {
  const { secretsPath } = appPaths(root);
  return await readJson(secretsPath, {});
}

async function saveSecrets(secrets, root = DEFAULT_ROOT) {
  const { secretsPath } = appPaths(root);
  await writeJsonAtomic(secretsPath, secrets, 0o600);
}

function publicGithubConfig(secrets = {}) {
  const github = secrets.github || {};
  return {
    owner: github.owner || '',
    repo: github.repo || '',
    branch: github.branch || 'video-factory-v4',
    tokenConfigured: Boolean(github.token)
  };
}

async function githubRequest(root, suffix, options = {}) {
  const secrets = await loadSecrets(root);
  const github = secrets.github || {};
  if (!github.owner || !github.repo || !github.token) {
    throw Object.assign(new Error('GitHub no está configurado localmente.'), { statusCode: 400 });
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${github.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'video-factory-dashboard-v4.1',
    ...(options.headers || {})
  };
  const url = `https://api.github.com/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}${suffix}`;
  const response = await fetch(url, { ...options, headers });
  return { response, github };
}

async function testGithubConfig(root = DEFAULT_ROOT) {
  const secrets = await loadSecrets(root);
  const github = secrets.github || {};
  if (!github.owner || !github.repo || !github.token) {
    throw Object.assign(new Error('Completa owner, repo y PAT.'), { statusCode: 400 });
  }
  const branch = github.branch || 'video-factory-v4';
  const { response } = await githubRequest(
    root,
    `/contents/README.md?ref=${encodeURIComponent(branch)}`
  );
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub test ${response.status}: ${await response.text()}`), { statusCode: response.status });
  }
  return { ok: true, repository: `${github.owner}/${github.repo}`, branch };
}

async function saveGithubSettings(body, root = DEFAULT_ROOT) {
  const current = await loadSecrets(root);
  const previous = current.github || {};
  const owner = String(body.owner || '').trim();
  const repo = String(body.repo || '').trim();
  const branch = String(body.branch || 'video-factory-v4').trim();
  const incomingToken = typeof body.token === 'string' ? body.token.trim() : '';
  if (!owner || !repo || !branch) throw Object.assign(new Error('Owner, repo y branch son obligatorios.'), { statusCode: 400 });

  current.github = {
    owner,
    repo,
    branch,
    token: incomingToken || previous.token || ''
  };
  await saveSecrets(current, root);
  return testGithubConfig(root);
}

async function deleteGithubToken(root = DEFAULT_ROOT) {
  const current = await loadSecrets(root);
  current.github = { ...(current.github || {}), token: '' };
  await saveSecrets(current, root);
  return publicGithubConfig(current);
}

export async function saveOverrideToGithub(jobId, override, root = DEFAULT_ROOT) {
  safeJobId(jobId);
  await validateOverrideRules(override, root);
  const secrets = await loadSecrets(root);
  const github = secrets.github || {};
  if (!github.owner || !github.repo || !github.token) {
    throw Object.assign(new Error('GitHub no está configurado localmente.'), { statusCode: 400 });
  }
  const branch = github.branch || 'video-factory-v4';
  const repoPath = `db/dashboard/${jobId}.json`;
  const base = `/contents/${repoPath}`;
  const { response: existing } = await githubRequest(root, `${base}?ref=${encodeURIComponent(branch)}`);
  let sha;
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) {
    throw Object.assign(new Error(`GitHub GET ${existing.status}: ${await existing.text()}`), { statusCode: existing.status });
  }

  const content = Buffer.from(`${JSON.stringify(override, null, 2)}\n`, 'utf8').toString('base64');
  const { response: saved } = await githubRequest(root, base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `dashboard: update ${jobId}`,
      content,
      branch,
      ...(sha ? { sha } : {})
    })
  });
  if (!saved.ok) {
    throw Object.assign(new Error(`GitHub PUT ${saved.status}: ${await saved.text()}`), { statusCode: saved.status });
  }
  const json = await saved.json();
  return { path: repoPath, commit: json.commit?.sha || null, branch };
}

async function syncGithub(root = DEFAULT_ROOT) {
  const secrets = await loadSecrets(root);
  const github = secrets.github || {};
  const branch = github.branch || 'video-factory-v4';
  const { response } = await githubRequest(root, `/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!response.ok) throw Object.assign(new Error(`GitHub sync ${response.status}: ${await response.text()}`), { statusCode: response.status });
  const json = await response.json();
  return {
    repository: `${github.owner}/${github.repo}`,
    branch,
    headSha: json.object?.sha || null,
    syncedAt: new Date().toISOString()
  };
}

function defaultSchedule() {
  return { version: 1, events: [] };
}

async function loadSchedule(root = DEFAULT_ROOT) {
  const { schedulePath } = appPaths(root);
  const schedule = await readJson(schedulePath, defaultSchedule());
  if (!Array.isArray(schedule.events)) schedule.events = [];
  return schedule;
}

function normalizeScheduleEvent(input, existing = {}) {
  const platform = safePlatform(String(input.platform || existing.platform || ''));
  const jobId = safeJobId(String(input.jobId || existing.jobId || ''));
  const scheduledAt = String(input.scheduledAt || existing.scheduledAt || '');
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
    throw Object.assign(new Error('scheduledAt inválido'), { statusCode: 400 });
  }
  const status = PLATFORM_STATUSES.has(input.status) ? input.status : (existing.status || 'scheduled');
  return {
    id: existing.id || crypto.randomUUID(),
    jobId,
    platform,
    scheduledAt,
    status,
    note: typeof input.note === 'string' ? input.note.trim() : (existing.note || ''),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function createScheduleEvent(input, root = DEFAULT_ROOT) {
  const paths = appPaths(root);
  const schedule = await loadSchedule(root);
  const event = normalizeScheduleEvent(input);
  schedule.events.push(event);
  await writeJsonAtomic(paths.schedulePath, schedule);
  return event;
}

async function updateScheduleEvent(id, input, root = DEFAULT_ROOT) {
  const paths = appPaths(root);
  const schedule = await loadSchedule(root);
  const index = schedule.events.findIndex(event => event.id === id);
  if (index < 0) throw Object.assign(new Error('Evento no encontrado'), { statusCode: 404 });
  schedule.events[index] = normalizeScheduleEvent(input, schedule.events[index]);
  await writeJsonAtomic(paths.schedulePath, schedule);
  return schedule.events[index];
}

async function deleteScheduleEvent(id, root = DEFAULT_ROOT) {
  const paths = appPaths(root);
  const schedule = await loadSchedule(root);
  const before = schedule.events.length;
  schedule.events = schedule.events.filter(event => event.id !== id);
  if (schedule.events.length === before) throw Object.assign(new Error('Evento no encontrado'), { statusCode: 404 });
  await writeJsonAtomic(paths.schedulePath, schedule);
  return { ok: true };
}

async function channelView(root = DEFAULT_ROOT) {
  const paths = appPaths(root);
  const profiles = await readJson(paths.profilesPath, {});
  const overrides = await readJson(paths.channelsPath, {});
  const source = profiles.platforms || {};
  const brandName = profiles.brand?.displayName || 'Pausa con Fe';
  return {
    tiktok: {
      profileImage: overrides.tiktok?.profileImage || source.tiktok?.profileImage || DEFAULT_CHANNEL_ASSETS.tiktok.profileImage,
      name: source.tiktok?.displayName || brandName,
      handle: source.tiktok?.username || '—',
      bio: source.tiktok?.bio || profiles.brand?.tagline || 'Reflexiones, oraciones y palabras de esperanza.'
    },
    youtube: {
      profileImage: overrides.youtube?.profileImage || source.youtube?.profileImage || DEFAULT_CHANNEL_ASSETS.youtube.profileImage,
      bannerImage: overrides.youtube?.bannerImage || source.youtube?.bannerImage || DEFAULT_CHANNEL_ASSETS.youtube.bannerImage,
      name: source.youtube?.channelName || brandName,
      handle: source.youtube?.handle || '—',
      bio: source.youtube?.description || profiles.brand?.tagline || 'Reflexiones, oraciones y palabras de esperanza.'
    },
    facebook: {
      profileImage: overrides.facebook?.profileImage || source.facebook?.profileImage || DEFAULT_CHANNEL_ASSETS.facebook.profileImage,
      coverImage: overrides.facebook?.coverImage || source.facebook?.coverImage || DEFAULT_CHANNEL_ASSETS.facebook.coverImage,
      name: source.facebook?.pageName || brandName,
      handle: source.facebook?.username || '—',
      bio: source.facebook?.description || profiles.brand?.tagline || 'Reflexiones, oraciones y palabras de esperanza.'
    }
  };
}

async function saveChannelAsset(platform, slot, dataUrl, root = DEFAULT_ROOT) {
  safePlatform(platform);
  if (!CHANNEL_ASSET_SLOTS[platform]?.has(slot)) throw Object.assign(new Error('Asset slot inválido'), { statusCode: 400 });
  if (typeof dataUrl !== 'string' || dataUrl.length > 12_000_000) {
    throw Object.assign(new Error('Imagen inválida o demasiado grande'), { statusCode: 400 });
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match || !ALLOWED_UPLOAD_MIME.has(match[1])) {
    throw Object.assign(new Error('Formato de imagen no permitido'), { statusCode: 400 });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 8_000_000) {
    throw Object.assign(new Error('Imagen vacía o mayor a 8 MB'), { statusCode: 400 });
  }
  const paths = appPaths(root);
  await fs.mkdir(paths.uploadsDir, { recursive: true });
  const ext = ALLOWED_UPLOAD_MIME.get(match[1]);
  const filename = `${platform}-${slot}-${Date.now()}${ext}`;
  await fs.writeFile(path.join(paths.uploadsDir, filename), buffer);
  const overrides = await readJson(paths.channelsPath, {});
  overrides[platform] = { ...(overrides[platform] || {}), [slot]: `/uploads/${filename}` };
  await writeJsonAtomic(paths.channelsPath, overrides);
  return { url: `/uploads/${filename}` };
}

async function integrationStatus(root = DEFAULT_ROOT) {
  const secrets = await loadSecrets(root);
  return {
    youtube: { configured: Boolean(secrets.integrations?.youtube?.apiKey) },
    tiktok: { configured: Boolean(secrets.integrations?.tiktok?.accessToken) },
    facebook: {
      configured: Boolean(secrets.integrations?.facebook?.pageAccessToken),
      graphApiVersion: secrets.integrations?.facebook?.graphApiVersion || ''
    }
  };
}

async function saveIntegrations(body, root = DEFAULT_ROOT) {
  const current = await loadSecrets(root);
  current.integrations ||= {};
  for (const platform of ['youtube', 'tiktok', 'facebook']) {
    const input = isPlainObject(body[platform]) ? body[platform] : {};
    current.integrations[platform] ||= {};
    if (platform === 'youtube' && typeof input.apiKey === 'string' && input.apiKey.trim()) {
      current.integrations.youtube.apiKey = input.apiKey.trim();
    }
    if (platform === 'tiktok' && typeof input.accessToken === 'string' && input.accessToken.trim()) {
      current.integrations.tiktok.accessToken = input.accessToken.trim();
    }
    if (platform === 'facebook') {
      if (typeof input.pageAccessToken === 'string' && input.pageAccessToken.trim()) {
        current.integrations.facebook.pageAccessToken = input.pageAccessToken.trim();
      }
      if (typeof input.graphApiVersion === 'string') {
        current.integrations.facebook.graphApiVersion = input.graphApiVersion.trim();
      }
    }
  }
  await saveSecrets(current, root);
  return integrationStatus(root);
}

function expandHome(relativePath) {
  if (relativePath === '~') return os.homedir();
  if (relativePath.startsWith('~/')) return path.join(os.homedir(), relativePath.slice(2));
  return relativePath;
}

function appendProcessLog(name, chunk) {
  const entry = String(chunk).trimEnd();
  if (!entry) return;
  const state = processState[name];
  state.logs.push(`[${new Date().toISOString()}] ${entry}`);
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

function processSnapshot(name) {
  const state = processState[name];
  return {
    startedByDashboard: Boolean(state.child && !state.child.killed),
    pid: state.child && !state.child.killed ? state.child.pid : null,
    logs: state.logs.slice(-80)
  };
}

async function rendererHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch('http://127.0.0.1:3123/health', { signal: controller.signal });
    return { online: response.ok, statusCode: response.status };
  } catch {
    return { online: false, statusCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function serverStatus() {
  const rendererDir = expandHome('~/video-factory/renderer');
  const factoryScript = expandHome('~/video-factory/factory/scripts/run-factory.mjs');
  const [health, rendererExists, factoryExists] = await Promise.all([
    rendererHealth(),
    fs.access(rendererDir).then(() => true).catch(() => false),
    fs.access(factoryScript).then(() => true).catch(() => false)
  ]);
  return {
    renderer: {
      ...health,
      path: rendererDir,
      pathExists: rendererExists,
      ...processSnapshot('renderer')
    },
    factory: {
      script: factoryScript,
      exists: factoryExists,
      running: Boolean(processState.factory.child && !processState.factory.child.killed),
      ...processSnapshot('factory')
    }
  };
}

function spawnManaged(name, command, args, cwd) {
  const state = processState[name];
  if (state.child && !state.child.killed) throw Object.assign(new Error(`${name} ya fue iniciado por el dashboard.`), { statusCode: 409 });
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  appendProcessLog(name, `START ${command} ${args.join(' ')} (pid ${child.pid})`);
  child.stdout.on('data', chunk => appendProcessLog(name, chunk));
  child.stderr.on('data', chunk => appendProcessLog(name, chunk));
  child.on('exit', (code, signal) => {
    appendProcessLog(name, `EXIT code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    state.child = null;
  });
  child.on('error', error => appendProcessLog(name, `ERROR ${error.message}`));
  return { pid: child.pid };
}

async function startRenderer() {
  const cwd = expandHome('~/video-factory/renderer');
  try { await fs.access(cwd); } catch { throw Object.assign(new Error(`No existe ${cwd}`), { statusCode: 404 }); }
  return spawnManaged('renderer', 'pnpm', ['dev'], cwd);
}

async function startFactory() {
  const script = expandHome('~/video-factory/factory/scripts/run-factory.mjs');
  try { await fs.access(script); } catch { throw Object.assign(new Error(`No existe ${script}`), { statusCode: 404 }); }
  return spawnManaged('factory', process.execPath, [script], path.dirname(script));
}

async function stopManaged(name) {
  const state = processState[name];
  const child = state.child;
  if (!child || child.killed) throw Object.assign(new Error(`${name} no fue iniciado por este dashboard.`), { statusCode: 409 });
  const pid = child.pid;
  child.kill('SIGTERM');
  const wait = new Promise(resolve => child.once('exit', resolve));
  await Promise.race([wait, new Promise(resolve => setTimeout(resolve, 1500))]);
  if (state.child && !state.child.killed) state.child.kill('SIGKILL');
  return { ok: true, pid };
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 12_000_000) throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

async function serveStaticFile(res, pathname, publicDir, uploadsDir) {
  let base = publicDir;
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (pathname.startsWith('/uploads/')) {
    base = uploadsDir;
    relative = pathname.replace(/^\/uploads\//, '');
  }
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(base, normalized);
  if (!file.startsWith(base)) return false;
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function createDashboardServer({ root = process.env.VIDEO_FACTORY_ROOT || DEFAULT_ROOT } = {}) {
  const paths = appPaths(root);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || HOST}`);
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/api/health') {
        return jsonResponse(res, 200, { ok: true, version: '4.1', host: HOST });
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        const [rules, profiles, secrets] = await Promise.all([
          readJson(paths.rulesPath, {}),
          readJson(paths.profilesPath, {}),
          loadSecrets(root)
        ]);
        return jsonResponse(res, 200, { rules, profiles, github: publicGithubConfig(secrets) });
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        return jsonResponse(res, 200, { jobs: await listJobs(root) });
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/(religion-\d{6})$/);
      if (req.method === 'GET' && jobMatch) {
        const job = await getMergedJob(jobMatch[1], root);
        return job ? jsonResponse(res, 200, { job }) : jsonResponse(res, 404, { error: 'Job not found' });
      }

      const dashboardMatch = pathname.match(/^\/api\/dashboard\/(religion-\d{6})$/);
      if (req.method === 'PUT' && dashboardMatch) {
        const override = await writeDashboardOverride(dashboardMatch[1], await readBody(req), root);
        return jsonResponse(res, 200, { ok: true, override, job: await getMergedJob(dashboardMatch[1], root) });
      }

      const githubJobMatch = pathname.match(/^\/api\/github\/(religion-\d{6})$/);
      if (req.method === 'PUT' && githubJobMatch) {
        const override = sanitizeOverride(await readBody(req));
        const result = await saveOverrideToGithub(githubJobMatch[1], override, root);
        return jsonResponse(res, 200, { ok: true, result });
      }

      if (req.method === 'GET' && pathname === '/api/github/config') {
        return jsonResponse(res, 200, publicGithubConfig(await loadSecrets(root)));
      }
      if (req.method === 'PUT' && pathname === '/api/github/config') {
        const result = await saveGithubSettings(await readBody(req), root);
        return jsonResponse(res, 200, { ...publicGithubConfig(await loadSecrets(root)), test: result });
      }
      if (req.method === 'POST' && pathname === '/api/github/sync') {
        return jsonResponse(res, 200, await syncGithub(root));
      }
      if (req.method === 'DELETE' && pathname === '/api/github/token') {
        return jsonResponse(res, 200, await deleteGithubToken(root));
      }

      if (req.method === 'GET' && pathname === '/api/schedule') {
        return jsonResponse(res, 200, await loadSchedule(root));
      }
      if (req.method === 'POST' && pathname === '/api/schedule') {
        return jsonResponse(res, 201, { event: await createScheduleEvent(await readBody(req), root) });
      }
      const scheduleMatch = pathname.match(/^\/api\/schedule\/([a-f0-9-]+)$/i);
      if (req.method === 'PUT' && scheduleMatch) {
        return jsonResponse(res, 200, { event: await updateScheduleEvent(scheduleMatch[1], await readBody(req), root) });
      }
      if (req.method === 'DELETE' && scheduleMatch) {
        return jsonResponse(res, 200, await deleteScheduleEvent(scheduleMatch[1], root));
      }

      if (req.method === 'GET' && pathname === '/api/channels') {
        return jsonResponse(res, 200, await channelView(root));
      }
      const channelUploadMatch = pathname.match(/^\/api\/channels\/(tiktok|youtube|facebook)\/assets\/(profileImage|bannerImage|coverImage)$/);
      if (req.method === 'POST' && channelUploadMatch) {
        const body = await readBody(req);
        return jsonResponse(res, 200, await saveChannelAsset(channelUploadMatch[1], channelUploadMatch[2], body.dataUrl, root));
      }

      if (req.method === 'GET' && pathname === '/api/integrations') {
        return jsonResponse(res, 200, await integrationStatus(root));
      }
      if (req.method === 'PUT' && pathname === '/api/integrations') {
        return jsonResponse(res, 200, await saveIntegrations(await readBody(req), root));
      }

      if (req.method === 'GET' && pathname === '/api/servers') {
        return jsonResponse(res, 200, await serverStatus());
      }
      if (req.method === 'POST' && pathname === '/api/servers/renderer/start') {
        return jsonResponse(res, 200, await startRenderer());
      }
      if (req.method === 'POST' && pathname === '/api/servers/renderer/stop') {
        return jsonResponse(res, 200, await stopManaged('renderer'));
      }
      if (req.method === 'POST' && pathname === '/api/servers/factory/start') {
        return jsonResponse(res, 200, await startFactory());
      }
      if (req.method === 'POST' && pathname === '/api/servers/factory/stop') {
        return jsonResponse(res, 200, await stopManaged('factory'));
      }

      if (req.method === 'GET' && await serveStaticFile(res, pathname, paths.publicDir, paths.uploadsDir)) return;
      return jsonResponse(res, 404, { error: 'Not found' });
    } catch (error) {
      // Never log request bodies or secrets. Errors are message-only.
      console.error(`[dashboard] ${error.message || 'Internal server error'}`);
      return jsonResponse(res, error.statusCode || 500, { error: error.message || 'Internal server error' });
    }
  });
}

export async function startDashboardServer({
  root = process.env.VIDEO_FACTORY_ROOT || DEFAULT_ROOT,
  port = DEFAULT_PORT
} = {}) {
  const server = createDashboardServer({ root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startDashboardServer()
    .then(server => {
      const address = server.address();
      console.log(`Video Factory V4.1 dashboard: http://${HOST}:${address.port}`);
    })
    .catch(error => {
      console.error(`[dashboard] ${error.message}`);
      process.exitCode = 1;
    });
}
