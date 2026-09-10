import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const JOBS_DIR = path.join(ROOT, 'db', 'jobs');
const V3_DIR = path.join(ROOT, 'db', 'migrations', 'v3');
const V4_DIR = path.join(ROOT, 'db', 'migrations', 'v4');
const DASHBOARD_DIR = path.join(ROOT, 'db', 'dashboard');
const RULES_PATH = path.join(ROOT, 'config', 'publishing-rules.json');
const PROFILES_PATH = path.join(ROOT, 'config', 'profiles.json');

const ADMIN_STATUSES = new Set(['review', 'ready', 'scheduled', 'published', 'needs_changes']);
const PLATFORM_STATUSES = new Set(['pending', 'ready', 'scheduled', 'published', 'failed']);
const EDITABLE_FIELDS = {
  tiktok: ['caption', 'hashtags', 'searchKeyword', 'coverText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
  youtube: ['title', 'description', 'hashtags', 'tags', 'thumbnailText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
  facebook: ['description', 'hashtags', 'coverText', 'cta', 'pinnedComment', 'audience', 'status', 'scheduledAt', 'publishedAt', 'url', 'postId']
};

function isPlainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function deepMerge(...objects) {
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

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function safeJobId(value) { if (!/^religion-\d{6}$/.test(value)) throw new Error('Invalid job id'); return value; }

async function getMergedJob(jobId) {
  safeJobId(jobId);
  const file = `${jobId}.json`;
  const original = await readJson(path.join(JOBS_DIR, file));
  if (!original) return null;
  const v3 = await readJson(path.join(V3_DIR, file), {});
  const v4 = await readJson(path.join(V4_DIR, file), {});
  const dashboard = await readJson(path.join(DASHBOARD_DIR, file), {});
  const merged = deepMerge(original, v3, v4, dashboard);
  merged._layers = { original: true, v3: Object.keys(v3).length > 0, v4: Object.keys(v4).length > 0, dashboard: Object.keys(dashboard).length > 0 };
  merged._summary = summarizeJob(merged);
  return merged;
}

function summarizeJob(job) {
  const platforms = ['tiktok', 'youtube', 'facebook'];
  const publishing = job.publishing || {};
  const performance = job.performance || {};
  const knownViews = platforms.reduce((sum, name) => Number.isFinite(performance?.[name]?.views) ? sum + performance[name].views : sum, 0);
  const hasKnownViews = platforms.some(name => Number.isFinite(performance?.[name]?.views));
  const scheduled = platforms.map(name => publishing?.[name]?.scheduledAt).filter(Boolean).sort();
  const states = Object.fromEntries(platforms.map(name => [name, platformConnectionState(name, publishing[name] || {}, performance[name] || {})]));
  return {
    effectiveStatus: job.admin?.status || (platforms.every(name => publishing?.[name]?.status === 'published') ? 'published' : job.status || 'review'),
    durationSeconds: job.render?.durationSeconds ?? null,
    sceneCount: Array.isArray(job.scenes) ? job.scenes.length : 0,
    nextScheduledAt: scheduled[0] || null,
    knownViews: hasKnownViews ? knownViews : null,
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

async function listJobs() {
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  const ids = entries.filter(e => e.isFile() && /^religion-\d{6}\.json$/.test(e.name)).map(e => e.name.replace('.json', '')).sort();
  const jobs = await Promise.all(ids.map(getMergedJob));
  return jobs.filter(Boolean);
}

function sanitizeOverride(input = {}) {
  const out = {};
  if (input.admin?.status && ADMIN_STATUSES.has(input.admin.status)) out.admin = { status: input.admin.status };
  if (isPlainObject(input.publishing)) {
    out.publishing = {};
    for (const platform of Object.keys(EDITABLE_FIELDS)) {
      const source = input.publishing[platform];
      if (!isPlainObject(source)) continue;
      const target = {};
      for (const field of EDITABLE_FIELDS[platform]) {
        if (!(field in source)) continue;
        let value = source[field];
        if (field === 'status' && !PLATFORM_STATUSES.has(value)) continue;
        if ((field === 'hashtags' || field === 'tags') && !Array.isArray(value)) continue;
        if (Array.isArray(value)) value = value.map(v => String(v).trim()).filter(Boolean);
        else if (value !== null) value = String(value);
        target[field] = value === '' && ['url', 'videoId', 'postId', 'scheduledAt', 'publishedAt'].includes(field) ? null : value;
      }
      if (Object.keys(target).length) out.publishing[platform] = target;
    }
  }
  return out;
}

async function writeDashboardOverride(jobId, input) {
  safeJobId(jobId);
  const override = sanitizeOverride(input);
  await fs.mkdir(DASHBOARD_DIR, { recursive: true });
  const target = path.join(DASHBOARD_DIR, `${jobId}.json`);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(override, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
  return override;
}

async function loadSecrets() {
  const candidates = [path.join(__dirname, '.secrets.json'), path.join(ROOT, '.secrets.json')];
  for (const candidate of candidates) {
    const value = await readJson(candidate, null);
    if (value?.github?.token) return value;
  }
  return {};
}
async function githubStatus() {
  const secrets = await loadSecrets();
  const github = secrets.github || {};
  return { configured: Boolean(github.token && github.repo), repo: github.repo || null, branch: github.branch || 'main' };
}

async function saveOverrideToGithub(jobId, override) {
  const secrets = await loadSecrets();
  const { token, repo, branch = 'main' } = secrets.github || {};
  if (!token || !repo) throw Object.assign(new Error('GitHub no está configurado en dashboard/.secrets.json'), { statusCode: 400 });
  const repoPath = `db/dashboard/${jobId}.json`;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${repoPath}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'video-factory-dashboard-v4' };
  let sha;
  const existing = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) throw Object.assign(new Error(`GitHub GET ${existing.status}: ${await existing.text()}`), { statusCode: existing.status });
  const body = { message: `dashboard: update ${jobId}`, content: Buffer.from(`${JSON.stringify(override, null, 2)}\n`, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) };
  const saved = await fetch(apiUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!saved.ok) throw Object.assign(new Error(`GitHub PUT ${saved.status}: ${await saved.text()}`), { statusCode: saved.status });
  const json = await saved.json();
  return { path: repoPath, commit: json.commit?.sha || null, branch };
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}
async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > 1_000_000) throw Object.assign(new Error('Payload too large'), { statusCode: 413 }); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, normalized);
  if (!file.startsWith(PUBLIC)) return false;
  try { const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const { pathname } = url;
    if (req.method === 'GET' && pathname === '/api/health') return jsonResponse(res, 200, { ok:true, version:4 });
    if (req.method === 'GET' && pathname === '/api/config') {
      const [rules, profiles, github] = await Promise.all([readJson(RULES_PATH, {}), readJson(PROFILES_PATH, {}), githubStatus()]);
      return jsonResponse(res, 200, { rules, profiles, github });
    }
    if (req.method === 'GET' && pathname === '/api/jobs') return jsonResponse(res, 200, { jobs: await listJobs() });
    const jobMatch = pathname.match(/^\/api\/jobs\/(religion-\d{6})$/);
    if (req.method === 'GET' && jobMatch) { const job = await getMergedJob(jobMatch[1]); return job ? jsonResponse(res,200,{job}) : jsonResponse(res,404,{error:'Job not found'}); }
    const localMatch = pathname.match(/^\/api\/dashboard\/(religion-\d{6})$/);
    if (req.method === 'PUT' && localMatch) { const override = await writeDashboardOverride(localMatch[1], await readBody(req)); return jsonResponse(res,200,{ok:true,override,job:await getMergedJob(localMatch[1])}); }
    const githubMatch = pathname.match(/^\/api\/github\/(religion-\d{6})$/);
    if (req.method === 'PUT' && githubMatch) { const override = sanitizeOverride(await readBody(req)); const result = await saveOverrideToGithub(githubMatch[1], override); return jsonResponse(res,200,{ok:true,result}); }
    if (req.method === 'GET' && await serveStatic(res, pathname)) return;
    jsonResponse(res, 404, { error:'Not found' });
  } catch (error) { console.error(error); jsonResponse(res, error.statusCode || 500, { error:error.message || 'Internal server error' }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Video Factory V4 dashboard: http://127.0.0.1:${PORT}`));
