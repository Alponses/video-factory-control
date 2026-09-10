const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const PLATFORM_LABELS = { tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' };
const CONNECTION_LABELS = {
  unpublished: 'Sin publicar',
  published_no_metrics: 'Publicado sin métricas',
  metrics_connected: 'Métricas conectadas',
  sync_error: 'Error de sincronización'
};
const VIDEO_TABS = [
  ['summary', 'Resumen'],
  ['content', 'Contenido'],
  ['cover', 'Cover'],
  ['publishing', 'Publicación'],
  ['links', 'Links'],
  ['metrics', 'Métricas'],
  ['render', 'Render / QA'],
  ['json', 'JSON']
];
const VIEW_META = {
  summary: ['Resumen', 'Estado general de Video Factory.'],
  calendar: ['Calendario', 'Planea publicaciones sin modificar db/jobs.'],
  channels: ['Canales', 'Branding y perfiles locales por plataforma.'],
  videos: ['Biblioteca de videos', 'Administra publicación, enlaces y métricas sin tocar los jobs originales.'],
  publishing: ['Publicación', 'Revisa el estado de cada video por plataforma.'],
  metrics: ['Métricas', 'Visualiza únicamente datos conocidos por job.'],
  integrations: ['Integraciones', 'Credenciales locales para APIs externas.'],
  github: ['GitHub', 'Configura el repositorio y el PAT solo en el backend local.'],
  servers: ['Servidores', 'Controla renderer y factory desde el dashboard local.']
};

const state = {
  jobs: [],
  filtered: [],
  config: null,
  schedule: { version: 1, events: [] },
  channels: {},
  integrations: {},
  currentJob: null,
  draft: null,
  activeTab: 'summary',
  adminStatusWasExplicit: false,
  adminStatusDirty: false,
  hashtagSignatures: {},
  calendarDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function getPath(obj, path) { return path.split('.').reduce((value, key) => value?.[key], obj); }
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cursor = obj;
  for (const key of parts.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[parts.at(-1)] = value;
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function formatMetric(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (typeof value === 'number') return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(value)}${suffix}`;
  return `${escapeHtml(value)}${suffix}`;
}
function inputDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function outputDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function countEmojis(text = '') {
  const allowlist = state.config?.rules?.global?.emojiAllowlist || [];
  return allowlist.reduce((sum, emoji) => sum + String(text).split(emoji).length - 1, 0);
}
function hasLongEmojiRun(text = '') {
  return /(?:\p{Extended_Pictographic}\uFE0F?\s*){5,}/u.test(text);
}
function hashtagSignature(list = []) {
  return [...list].map(item => item.toLowerCase()).sort().join('|');
}
function badge(status) {
  const css = ['published', 'ready', 'approved', 'online', 'configured'].includes(status)
    ? 'success'
    : ['failed', 'needs_changes', 'offline', 'missing'].includes(status)
      ? 'danger'
      : ['scheduled', 'review'].includes(status) ? 'warning' : '';
  return `<span class="badge ${css}">${escapeHtml(status || '—')}</span>`;
}
function kv(label, value) {
  return `<div class="key-value"><span>${escapeHtml(label)}</span><span>${escapeHtml(value ?? '—')}</span></div>`;
}
function showGlobalError(error) {
  const el = $('#globalError');
  el.textContent = error?.message || String(error);
  el.classList.remove('hidden');
}
function clearGlobalError() { $('#globalError').classList.add('hidden'); }

function buildSignatures() {
  state.hashtagSignatures = {};
  for (const platform of Object.keys(PLATFORM_LABELS)) {
    const map = new Map();
    for (const job of state.jobs) {
      const signature = hashtagSignature(job.publishing?.[platform]?.hashtags || []);
      if (signature) map.set(signature, (map.get(signature) || 0) + 1);
    }
    state.hashtagSignatures[platform] = map;
  }
}

function validatePlatform(platform, data) {
  const rules = state.config?.rules?.[platform] || {};
  const global = state.config?.rules?.global || {};
  const hashtags = Array.isArray(data.hashtags) ? data.hashtags : [];
  const mainText = platform === 'tiktok' ? (data.caption || '') : (data.description || '');
  const errors = [];
  const warnings = [];

  if (hashtags.length < rules.hashtagsMin || hashtags.length > rules.hashtagsMax) {
    errors.push(`Hashtags: ${hashtags.length}; permitido ${rules.hashtagsMin}–${rules.hashtagsMax}.`);
  }
  const brand = global.brandHashtag;
  const brandMax = rules.brandHashtagMax ?? global.brandHashtagMax ?? 1;
  if (brand && hashtags.filter(tag => tag.toLowerCase() === brand.toLowerCase()).length > brandMax) {
    errors.push(`Solo se permite un ${brand}.`);
  }
  const blocked = new Set((global.blockedAutomaticHashtags || []).map(tag => tag.toLowerCase()));
  const blockedFound = hashtags.filter(tag => blocked.has(tag.toLowerCase()));
  if (blockedFound.length) errors.push(`Hashtags automáticos bloqueados: ${blockedFound.join(', ')}.`);
  if (hashtags.some(tag => !/^#[^\s#]+$/.test(tag))) errors.push('Hay hashtags con formato inválido.');
  if (hashtags.some(tag => /\p{Extended_Pictographic}/u.test(tag))) errors.push('No se permiten emojis dentro de hashtags.');

  const emojis = countEmojis(mainText);
  if (Number.isFinite(rules.emojiMin) && (emojis < rules.emojiMin || emojis > rules.emojiMax)) {
    errors.push(`Emojis: ${emojis}; permitido ${rules.emojiMin}–${rules.emojiMax}.`);
  }
  if (hasLongEmojiRun(mainText)) errors.push('No se permiten 5 emojis consecutivos.');

  if (Number.isFinite(rules.descriptionTargetMin)
      && (mainText.length < rules.descriptionTargetMin || mainText.length > rules.descriptionTargetMax)) {
    warnings.push(`Longitud objetivo: ${rules.descriptionTargetMin}–${rules.descriptionTargetMax}; actual ${mainText.length}.`);
  }

  if (platform === 'youtube') {
    if ((data.title || '').length > (rules.titleMaxCharacters || 100)) {
      errors.push(`Título supera ${rules.titleMaxCharacters || 100} caracteres.`);
    }
    if ((data.description || '').length > (rules.officialDescriptionMaxCharacters || 5000)) {
      errors.push('Descripción supera el máximo permitido por YouTube.');
    }
    if (countEmojis(data.title || '') > (rules.titleEmojiMax ?? 1)) errors.push('El título tiene demasiados emojis.');
  }

  const signature = hashtagSignature(hashtags);
  if (signature && (state.hashtagSignatures?.[platform]?.get(signature) || 0) > 1) {
    warnings.push('Este bloque de hashtags coincide exactamente con otro video.');
  }
  return { errors, warnings, chars: mainText.length, hashtags: hashtags.length, emojis };
}

function renderSummary() {
  const total = state.jobs.length;
  const published = state.jobs.filter(job => job._summary?.effectiveStatus === 'published').length;
  const scheduled = state.schedule.events.filter(event => event.status === 'scheduled').length;
  const review = state.jobs.filter(job => ['review', 'needs_changes'].includes(job._summary?.effectiveStatus)).length;
  const knownViews = state.jobs
    .map(job => job._summary?.knownViews)
    .filter(value => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  const anyKnownViews = state.jobs.some(job => Number.isFinite(job._summary?.knownViews));

  $('#summaryCards').innerHTML = [
    ['Videos', total],
    ['Publicados', published],
    ['Programados', scheduled],
    ['Por revisar', review],
    ['Views conocidas', anyKnownViews ? new Intl.NumberFormat('es-MX').format(knownViews) : '—']
  ].map(([label, value]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');

  const upcoming = [...state.schedule.events]
    .filter(event => Date.parse(event.scheduledAt) >= Date.now())
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
    .slice(0, 6);
  $('#summarySchedule').innerHTML = upcoming.length
    ? upcoming.map(event => `<button class="list-row schedule-open" data-schedule-id="${escapeHtml(event.id)}"><span><strong>${escapeHtml(event.jobId)}</strong><small>${PLATFORM_LABELS[event.platform]} · ${formatDate(event.scheduledAt)}</small></span>${badge(event.status)}</button>`).join('')
    : '<div class="empty-inline">No hay publicaciones próximas.</div>';

  const counts = { tiktok: 0, youtube: 0, facebook: 0 };
  for (const job of state.jobs) {
    for (const platform of Object.keys(counts)) {
      if (job._summary?.platformStates?.[platform] === 'metrics_connected') counts[platform] += 1;
    }
  }
  $('#summaryPlatforms').innerHTML = Object.entries(counts)
    .map(([platform, count]) => `<div class="list-row static"><span><strong>${PLATFORM_LABELS[platform]}</strong><small>Videos con métricas conectadas</small></span><strong>${count}</strong></div>`)
    .join('');
}

function renderVideoCard(job) {
  const summary = job._summary || {};
  const cover = job.cover || {};
  const platforms = Object.entries(summary.platformStates || {})
    .map(([name, status]) => `<span class="platform-pill ${status}">${PLATFORM_LABELS[name]} · ${CONNECTION_LABELS[status] || status}</span>`)
    .join('');
  return `<article class="video-card" data-job-id="${escapeHtml(job.id)}" tabindex="0" role="button">
    <div class="cover"><strong>${escapeHtml(cover.headline || job.title)}</strong><small>${escapeHtml(cover.subheadline || job.category || '')}</small></div>
    <div class="card-body">
      <div class="card-meta"><span>${escapeHtml(job.id)}</span>${badge(summary.effectiveStatus)}</div>
      <h3>${escapeHtml(job.title)}</h3>
      <div class="card-stats">
        <span>${escapeHtml(job.category)}</span>
        <span>${formatDuration(summary.durationSeconds)}</span>
        <span>${summary.sceneCount || 0} escenas</span>
        <span>${formatDate(job.createdAt)}</span>
        <span>${summary.knownViews === null ? 'Views: —' : `Views: ${formatMetric(summary.knownViews)}`}</span>
        ${summary.nextScheduledAt ? `<span>Próximo: ${formatDate(summary.nextScheduledAt)}</span>` : ''}
      </div>
      <div class="platform-row">${platforms}</div>
    </div>
  </article>`;
}

function applyFilters() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const status = $('#statusFilter').value;
  const sort = $('#sortSelect').value;

  const jobs = state.jobs.filter(job => {
    const haystack = `${job.id} ${job.title} ${job.category}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (!status || job._summary?.effectiveStatus === status || job.status === status);
  });

  jobs.sort((a, b) => {
    if (sort === 'date-asc') return String(a.createdAt).localeCompare(String(b.createdAt));
    if (sort === 'status') return String(a._summary?.effectiveStatus).localeCompare(String(b._summary?.effectiveStatus));
    if (sort === 'views-desc') return (b._summary?.knownViews ?? -1) - (a._summary?.knownViews ?? -1);
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  state.filtered = jobs;
  $('#videoGrid').innerHTML = jobs.map(renderVideoCard).join('');
  $('#videoGrid').classList.toggle('hidden', jobs.length === 0);
  $('#emptyState').classList.toggle('hidden', jobs.length !== 0);
  $('#loadingState').classList.add('hidden');
}

function renderPublishingCenter() {
  const rows = [];
  for (const job of state.jobs) {
    for (const platform of Object.keys(PLATFORM_LABELS)) {
      const p = job.publishing?.[platform] || {};
      rows.push(`<tr>
        <td><button class="link-button video-open" data-job-id="${escapeHtml(job.id)}">${escapeHtml(job.id)}</button><small>${escapeHtml(job.title)}</small></td>
        <td>${PLATFORM_LABELS[platform]}</td>
        <td>${badge(p.status)}</td>
        <td>${p.scheduledAt ? formatDate(p.scheduledAt) : '—'}</td>
        <td>${p.publishedAt ? formatDate(p.publishedAt) : '—'}</td>
        <td>${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noreferrer">Abrir</a>` : '—'}</td>
      </tr>`);
    }
  }
  $('#publishingTable').innerHTML = `<table>
    <thead><tr><th>Video</th><th>Plataforma</th><th>Status</th><th>Programado</th><th>Publicado</th><th>URL</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

const METRIC_DEFS = {
  tiktok: [
    ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comentarios'], ['shares', 'Compartidos'],
    ['saves', 'Guardados'], ['averageWatchTime', 'Watch time promedio'], ['averageWatchTimeSeconds', 'Watch time promedio (s)'],
    ['completionRate', 'Completion rate']
  ],
  youtube: [
    ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comentarios'], ['shares', 'Compartidos'],
    ['averageViewDuration', 'Duración promedio'], ['averageViewDurationSeconds', 'Duración promedio (s)'],
    ['averagePercentageViewed', '% promedio visto'], ['viewedVsSwipedAway', 'Viewed vs swiped'], ['subscribersGained', 'Suscriptores ganados']
  ],
  facebook: [
    ['views', 'Views'], ['qualifiedViews', 'Qualified views'], ['watchTime', 'Watch time'],
    ['watchTimeSeconds', 'Watch time (s)'], ['likes', 'Likes'], ['comments', 'Comentarios'], ['shares', 'Compartidos'], ['earnings', 'Earnings']
  ]
};

function renderMetricsCenter() {
  const select = $('#metricsJobSelect');
  const previous = select.value;
  select.innerHTML = state.jobs.map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.id)} · ${escapeHtml(job.title)}</option>`).join('');
  if (previous && state.jobs.some(job => job.id === previous)) select.value = previous;
  renderMetricsSelected();
}

function renderMetricPlatform(platform, metrics = {}) {
  const seen = new Set();
  const items = [];
  for (const [key, label] of METRIC_DEFS[platform]) {
    if (seen.has(key)) continue;
    const value = metrics[key];
    if (value === undefined && key.endsWith('Seconds')) continue;
    if (value === undefined && (key === 'averageWatchTime' || key === 'averageViewDuration' || key === 'watchTime')) continue;
    seen.add(key);
    items.push(`<div class="metric"><span>${escapeHtml(label)}</span><strong>${formatMetric(value)}</strong></div>`);
  }
  return `<article class="metric-card"><div class="metric-header"><h3>${PLATFORM_LABELS[platform]}</h3></div>${items.join('')}</article>`;
}

function renderMetricsSelected() {
  const job = state.jobs.find(item => item.id === $('#metricsJobSelect').value) || state.jobs[0];
  if (!job) {
    $('#metricsContent').innerHTML = '<div class="empty-inline">No hay jobs.</div>';
    return;
  }
  $('#metricsContent').innerHTML = Object.keys(PLATFORM_LABELS)
    .map(platform => renderMetricPlatform(platform, job.performance?.[platform] || {}))
    .join('');
}

function sameLocalDay(iso, year, month, day) {
  const d = new Date(iso);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
}
function renderCalendar() {
  const date = state.calendarDate;
  const year = date.getFullYear();
  const month = date.getMonth();
  $('#calendarMonthLabel').textContent = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(date);

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const previousDays = new Date(year, month, 0).getDate();
  const cells = [];

  for (let index = 0; index < 42; index++) {
    let cellYear = year;
    let cellMonth = month;
    let day;
    let outside = false;
    if (index < firstWeekday) {
      day = previousDays - firstWeekday + index + 1;
      cellMonth -= 1;
      outside = true;
      if (cellMonth < 0) { cellMonth = 11; cellYear -= 1; }
    } else if (index >= firstWeekday + days) {
      day = index - firstWeekday - days + 1;
      cellMonth += 1;
      outside = true;
      if (cellMonth > 11) { cellMonth = 0; cellYear += 1; }
    } else {
      day = index - firstWeekday + 1;
    }

    const events = state.schedule.events
      .filter(event => sameLocalDay(event.scheduledAt, cellYear, cellMonth, day))
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    const eventHtml = events.map(event => {
      const time = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.scheduledAt));
      return `<button class="calendar-event schedule-open" data-schedule-id="${escapeHtml(event.id)}">
        <strong>${time} · ${PLATFORM_LABELS[event.platform]}</strong>
        <span>${escapeHtml(event.jobId)}</span>
        <small>${escapeHtml(event.status)}</small>
      </button>`;
    }).join('');

    cells.push(`<div class="calendar-day ${outside ? 'outside' : ''}">
      <div class="day-number">${day}</div>${eventHtml}
    </div>`);
  }
  $('#calendarGrid').innerHTML = cells.join('');
}

function renderChannels() {
  const configs = [
    ['tiktok', 'TikTok', 'profileImage', null],
    ['youtube', 'YouTube', 'profileImage', 'bannerImage'],
    ['facebook', 'Facebook', 'profileImage', 'coverImage']
  ];
  $('#channelGrid').innerHTML = configs.map(([platform, label, avatarSlot, heroSlot]) => {
    const data = state.channels[platform] || {};
    return `<article class="channel-card">
      ${heroSlot ? `<img class="channel-hero" src="${escapeHtml(data[heroSlot])}" alt="${label} branding">` : ''}
      <div class="channel-body">
        <img class="channel-avatar" src="${escapeHtml(data[avatarSlot])}" alt="${label}">
        <div class="channel-copy"><h2>${escapeHtml(data.name || label)}</h2><p class="handle">${escapeHtml(data.handle || '—')}</p><p>${escapeHtml(data.bio || '—')}</p></div>
      </div>
      <div class="upload-row">
        <label class="button secondary file-button">Reemplazar foto<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-channel-upload="${platform}:${avatarSlot}"></label>
        ${heroSlot ? `<label class="button secondary file-button">Reemplazar ${platform === 'youtube' ? 'banner' : 'cover'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-channel-upload="${platform}:${heroSlot}"></label>` : ''}
      </div>
      <small class="hint">Se guarda únicamente en dashboard/uploads/.</small>
    </article>`;
  }).join('');
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function uploadChannelFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const [platform, slot] = input.dataset.channelUpload.split(':');
  try {
    const dataUrl = await readFileDataUrl(file);
    await api(`/api/channels/${platform}/assets/${slot}`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
    state.channels = await api('/api/channels');
    renderChannels();
  } catch (error) {
    showGlobalError(error);
  }
}

function renderGithubPanel() {
  const github = state.config?.github || {};
  $('#githubOwner').value = github.owner || '';
  $('#githubRepo').value = github.repo || '';
  $('#githubBranch').value = github.branch || 'video-factory-v4';
  $('#githubToken').value = '';
  $('#githubPanelStatus').textContent = github.tokenConfigured
    ? 'PAT configurado localmente. El valor no se envía al navegador.'
    : 'No hay PAT local configurado.';
  $('#githubPanelStatus').className = `message ${github.tokenConfigured ? 'success' : 'neutral'}`;
  $('#githubDot').className = `status-dot ${github.tokenConfigured ? 'ok' : 'warn'}`;
  $('#githubStatusText').textContent = github.tokenConfigured
    ? `GitHub · ${github.owner}/${github.repo}`
    : 'GitHub sin token local';
  $('#saveGithubBtn').disabled = !github.tokenConfigured;
}

async function saveGithubConfig() {
  clearGlobalError();
  try {
    const result = await api('/api/github/config', {
      method: 'PUT',
      body: JSON.stringify({
        owner: $('#githubOwner').value,
        repo: $('#githubRepo').value,
        branch: $('#githubBranch').value,
        token: $('#githubToken').value
      })
    });
    state.config.github = {
      owner: result.owner,
      repo: result.repo,
      branch: result.branch,
      tokenConfigured: result.tokenConfigured
    };
    renderGithubPanel();
    $('#githubPanelStatus').textContent = `Conexión correcta · ${result.test.repository} · ${result.test.branch}`;
    $('#githubPanelStatus').className = 'message success';
  } catch (error) {
    showGlobalError(error);
  }
}
async function syncGithub() {
  try {
    const result = await api('/api/github/sync', { method: 'POST', body: '{}' });
    $('#githubPanelStatus').textContent = `Sincronizado · ${result.branch} · ${result.headSha ? result.headSha.slice(0, 8) : 'sin SHA'}`;
    $('#githubPanelStatus').className = 'message success';
  } catch (error) { showGlobalError(error); }
}
async function deleteGithubToken() {
  if (!window.confirm('¿Borrar el PAT local de dashboard/.secrets.json?')) return;
  try {
    const config = await api('/api/github/token', { method: 'DELETE' });
    state.config.github = config;
    renderGithubPanel();
  } catch (error) { showGlobalError(error); }
}

function renderIntegrations() {
  const y = state.integrations.youtube || {};
  const t = state.integrations.tiktok || {};
  const f = state.integrations.facebook || {};
  $('#youtubeIntegrationStatus').textContent = y.configured ? 'Configurado' : 'No configurado';
  $('#tiktokIntegrationStatus').textContent = t.configured ? 'Configurado' : 'No configurado';
  $('#facebookIntegrationStatus').textContent = f.configured ? 'Configurado' : 'No configurado';
  $('#facebookGraphVersion').value = f.graphApiVersion || '';
}
async function saveIntegrations() {
  try {
    state.integrations = await api('/api/integrations', {
      method: 'PUT',
      body: JSON.stringify({
        youtube: { apiKey: $('#youtubeApiKey').value },
        tiktok: { accessToken: $('#tiktokAccessToken').value },
        facebook: {
          pageAccessToken: $('#facebookPageToken').value,
          graphApiVersion: $('#facebookGraphVersion').value
        }
      })
    });
    $('#youtubeApiKey').value = '';
    $('#tiktokAccessToken').value = '';
    $('#facebookPageToken').value = '';
    renderIntegrations();
    $('#integrationsMessage').textContent = 'Guardado en .secrets.json.';
  } catch (error) { showGlobalError(error); }
}

async function loadServers() {
  try {
    const status = await api('/api/servers');
    const renderer = status.renderer;
    $('#rendererBadge').outerHTML = badge(renderer.online ? 'online' : 'offline').replace('<span ', '<span id="rendererBadge" ');
    $('#rendererInfo').innerHTML = kv('Health', renderer.online ? 'Online' : 'Offline')
      + kv('PID dashboard', renderer.pid ?? '—') + kv('Ruta', renderer.path)
      + kv('Ruta existe', renderer.pathExists ? 'Sí' : 'No');
    $('#rendererLogs').textContent = (renderer.logs || []).join('\n') || 'Sin logs del dashboard.';

    const factory = status.factory;
    $('#factoryBadge').outerHTML = badge(factory.running ? 'online' : (factory.exists ? 'ready' : 'missing')).replace('<span ', '<span id="factoryBadge" ');
    $('#factoryInfo').innerHTML = kv('Script existe', factory.exists ? 'Sí' : 'No')
      + kv('PID dashboard', factory.pid ?? '—') + kv('Script', factory.script);
    $('#factoryLogs').textContent = (factory.logs || []).join('\n') || 'Sin logs del dashboard.';
    $('#startFactoryBtn').disabled = !factory.exists || factory.running;
    $('#stopFactoryBtn').disabled = !factory.startedByDashboard;
    $('#stopRendererBtn').disabled = !renderer.startedByDashboard;
  } catch (error) { showGlobalError(error); }
}
async function serverAction(path) {
  try {
    await api(path, { method: 'POST', body: '{}' });
    setTimeout(loadServers, 250);
  } catch (error) { showGlobalError(error); }
}

function openScheduleModal(event = null) {
  $('#scheduleModal').classList.remove('hidden');
  $('#scheduleId').value = event?.id || '';
  $('#scheduleJobId').innerHTML = state.jobs.map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.id)} · ${escapeHtml(job.title)}</option>`).join('');
  $('#scheduleJobId').value = event?.jobId || state.jobs[0]?.id || '';
  $('#schedulePlatform').value = event?.platform || 'tiktok';
  $('#scheduleStatus').value = event?.status || 'scheduled';
  $('#scheduleAt').value = inputDate(event?.scheduledAt || new Date(Date.now() + 3600000).toISOString());
  $('#scheduleNote').value = event?.note || '';
  $('#scheduleModalTitle').textContent = event ? 'Editar evento' : 'Crear evento';
  $('#deleteScheduleBtn').classList.toggle('hidden', !event);
}
function closeScheduleModal() { $('#scheduleModal').classList.add('hidden'); }
async function saveScheduleEvent() {
  const id = $('#scheduleId').value;
  const body = {
    jobId: $('#scheduleJobId').value,
    platform: $('#schedulePlatform').value,
    status: $('#scheduleStatus').value,
    scheduledAt: outputDate($('#scheduleAt').value),
    note: $('#scheduleNote').value
  };
  try {
    await api(id ? `/api/schedule/${id}` : '/api/schedule', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body)
    });
    state.schedule = await api('/api/schedule');
    closeScheduleModal();
    renderCalendar();
    renderSummary();
  } catch (error) { showGlobalError(error); }
}
async function deleteScheduleEvent() {
  const id = $('#scheduleId').value;
  if (!id || !window.confirm('¿Eliminar este evento del calendario? Esta acción no modifica db/jobs.')) return;
  try {
    await api(`/api/schedule/${id}`, { method: 'DELETE' });
    state.schedule = await api('/api/schedule');
    closeScheduleModal();
    renderCalendar();
    renderSummary();
  } catch (error) { showGlobalError(error); }
}

function copyButton(path, label = 'Copiar') {
  return `<button class="small-button copy-btn" data-copy-path="${escapeHtml(path)}">${label}</button>`;
}
function editorField(label, path, value, { textarea = false, type = 'text', full = false, array = null } = {}) {
  let display = value ?? '';
  if (array === 'hashtags') display = Array.isArray(value) ? value.join(' ') : '';
  if (array === 'tags') display = Array.isArray(value) ? value.join(', ') : '';
  if (type === 'datetime-local') display = inputDate(value);
  const control = textarea
    ? `<textarea data-edit-path="${escapeHtml(path)}" data-array="${array || ''}">${escapeHtml(display)}</textarea>`
    : `<input type="${type}" value="${escapeHtml(display)}" data-edit-path="${escapeHtml(path)}" data-array="${array || ''}">`;
  return `<label class="field ${full ? 'full' : ''}"><span>${escapeHtml(label)}</span>${control}<div class="copy-row">${copyButton(path)}</div></label>`;
}
function selectField(label, path, value, options, { includeBlank = false, blankLabel = 'Sin override' } = {}) {
  const blank = includeBlank ? `<option value="" ${value ? '' : 'selected'}>${escapeHtml(blankLabel)}</option>` : '';
  return `<label class="field"><span>${escapeHtml(label)}</span><select data-edit-path="${escapeHtml(path)}">${blank}${options.map(option => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
}
function platformCounters(platform, data) {
  const result = validatePlatform(platform, data);
  const invalid = result.errors.length > 0;
  return `<div data-counter-platform="${platform}">
    <div class="counter-row">
      <span class="counter ${invalid ? 'invalid' : ''}">${result.chars} caracteres</span>
      <span class="counter ${invalid ? 'invalid' : ''}">${result.hashtags} hashtags</span>
      <span class="counter ${invalid ? 'invalid' : ''}">${result.emojis} emojis</span>
    </div>
    ${result.errors.length ? `<ul class="rule-list">${result.errors.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    ${result.warnings.length ? `<div class="message warning">${result.warnings.map(escapeHtml).join(' ')}</div>` : ''}
  </div>`;
}

function renderSummaryTab(job) {
  const summary = job._summary || {};
  const explicit = state.adminStatusWasExplicit;
  const selected = explicit ? (job.admin?.status || '') : '';
  return `<div class="detail-grid">
    <section class="detail-card"><h3>Estado administrativo</h3>
      ${selectField('admin.status', 'admin.status', selected, ['review', 'ready', 'scheduled', 'published', 'needs_changes'], {
        includeBlank: true,
        blankLabel: `Sin override · usar ${job.status || 'status original'}`
      })}
      <p class="hint">Editar publishing no crea un estado administrativo.</p>
    </section>
    <section class="detail-card"><h3>Job</h3>${kv('ID', job.id)}${kv('Título', job.title)}${kv('Categoría', job.category)}${kv('Status original', job.status)}${kv('Status efectivo', summary.effectiveStatus)}${kv('Creado', formatDate(job.createdAt))}</section>
    <section class="detail-card"><h3>Producción</h3>${kv('Duración', formatDuration(summary.durationSeconds))}${kv('Escenas', summary.sceneCount)}${kv('Renderer videoId', job.render?.videoId)}${kv('QA', job.qa?.passed === true ? 'Aprobado' : job.qa?.passed === false ? 'No aprobado' : '—')}</section>
    <section class="detail-card"><h3>Capas</h3>${kv('Job original', job._layers?.original ? 'Sí' : 'No')}${kv('Migración V3', job._layers?.v3 ? 'Sí' : 'No')}${kv('Migración V4', job._layers?.v4 ? 'Sí' : 'No')}${kv('Override dashboard', job._layers?.dashboard ? 'Sí' : 'No')}</section>
  </div>`;
}
function renderContentTab(job) {
  const scenes = (job.scenes || []).map((scene, i) => `<div class="scene"><div class="scene-index">${i + 1}</div><div><strong>${escapeHtml(scene.text)}</strong><div class="card-meta">${(scene.searchTerms || []).map(escapeHtml).join(' · ')}</div></div></div>`).join('');
  return `<div class="detail-grid">
    <section class="detail-card"><h3>Discovery</h3>${kv('Keyword principal', job.discovery?.primaryKeyword)}${kv('Secundarias', (job.discovery?.secondaryKeywords || []).join(', '))}${kv('Intención', job.discovery?.searchIntent)}</section>
    <section class="detail-card"><h3>Contenido</h3>${kv('Hook', job.content?.hook?.text)}${kv('Tipo', job.content?.hook?.type)}${kv('Cierre', job.content?.closing)}${kv('Palabras', job.content?.wordCount)}</section>
  </div><h3 class="section-gap">Escenas</h3><div class="scene-list">${scenes}</div>`;
}
function renderCoverTab(job) {
  const cover = job.cover || {};
  return `<div class="detail-grid">
    <section class="detail-card"><h3>Cover general</h3>${kv('Headline', cover.headline)}${kv('Subheadline', cover.subheadline)}${kv('Visual concept', cover.visualConcept)}${kv('Image prompt', cover.imagePrompt)}${kv('Frame seconds', cover.frameSeconds)}${kv('Asset', cover.asset)}${kv('Status', cover.status)}</section>
    <section class="detail-card"><h3>Texto por plataforma</h3>${kv('TikTok', cover.platforms?.tiktok?.text)}${kv('YouTube', cover.platforms?.youtube?.text)}${kv('Facebook', cover.platforms?.facebook?.text)}</section>
  </div>`;
}
function renderPublishingTab(job) {
  return ['tiktok', 'youtube', 'facebook'].map(platform => {
    const data = job.publishing?.[platform] || {};
    let fields;
    if (platform === 'tiktok') {
      fields = [
        editorField('Caption', `publishing.${platform}.caption`, data.caption, { textarea: true, full: true }),
        editorField('Hashtags', `publishing.${platform}.hashtags`, data.hashtags, { full: true, array: 'hashtags' }),
        editorField('Search keyword', `publishing.${platform}.searchKeyword`, data.searchKeyword),
        editorField('Cover text', `publishing.${platform}.coverText`, data.coverText),
        editorField('CTA', `publishing.${platform}.cta`, data.cta, { textarea: true, full: true }),
        editorField('Pinned comment', `publishing.${platform}.pinnedComment`, data.pinnedComment, { textarea: true, full: true })
      ];
    } else if (platform === 'youtube') {
      fields = [
        editorField('Title', `publishing.${platform}.title`, data.title, { full: true }),
        editorField('Description', `publishing.${platform}.description`, data.description, { textarea: true, full: true }),
        editorField('Hashtags', `publishing.${platform}.hashtags`, data.hashtags, { full: true, array: 'hashtags' }),
        editorField('Tags', `publishing.${platform}.tags`, data.tags, { full: true, array: 'tags' }),
        editorField('Thumbnail text', `publishing.${platform}.thumbnailText`, data.thumbnailText),
        editorField('CTA', `publishing.${platform}.cta`, data.cta, { textarea: true, full: true }),
        editorField('Pinned comment', `publishing.${platform}.pinnedComment`, data.pinnedComment, { textarea: true, full: true })
      ];
    } else {
      fields = [
        editorField('Description', `publishing.${platform}.description`, data.description, { textarea: true, full: true }),
        editorField('Hashtags', `publishing.${platform}.hashtags`, data.hashtags, { full: true, array: 'hashtags' }),
        editorField('Cover text', `publishing.${platform}.coverText`, data.coverText),
        editorField('CTA', `publishing.${platform}.cta`, data.cta, { textarea: true, full: true }),
        editorField('Pinned comment', `publishing.${platform}.pinnedComment`, data.pinnedComment, { textarea: true, full: true }),
        editorField('Audience', `publishing.${platform}.audience`, data.audience)
      ];
    }
    return `<section class="publishing-block"><div class="publishing-title"><h3>${PLATFORM_LABELS[platform]}</h3>${badge(data.status)}</div><div class="form-grid">${fields.join('')}</div>${platformCounters(platform, data)}</section>`;
  }).join('');
}
function renderLinksTab(job) {
  return ['tiktok', 'youtube', 'facebook'].map(platform => {
    const data = job.publishing?.[platform] || {};
    const idField = platform === 'facebook' ? 'postId' : 'videoId';
    return `<section class="publishing-block"><h3>${PLATFORM_LABELS[platform]}</h3><div class="form-grid">
      ${editorField('URL', `publishing.${platform}.url`, data.url, { full: true })}
      ${editorField(platform === 'facebook' ? 'Post ID' : 'Video ID', `publishing.${platform}.${idField}`, data[idField])}
      ${selectField('Status', `publishing.${platform}.status`, data.status || 'pending', ['pending', 'ready', 'scheduled', 'published', 'failed'])}
      ${editorField('Scheduled at', `publishing.${platform}.scheduledAt`, data.scheduledAt, { type: 'datetime-local' })}
      ${editorField('Published at', `publishing.${platform}.publishedAt`, data.publishedAt, { type: 'datetime-local' })}
    </div></section>`;
  }).join('');
}
function renderMetricsTab(job) {
  return `<div class="metrics-grid">${Object.keys(PLATFORM_LABELS).map(platform => renderMetricPlatform(platform, job.performance?.[platform] || {})).join('')}</div>`;
}
function renderRenderTab(job) {
  const render = job.render || {};
  const qa = job.qa || {};
  return `<div class="detail-grid"><section class="detail-card"><h3>Render</h3>${Object.entries(render).map(([key, value]) => kv(key, typeof value === 'object' ? JSON.stringify(value) : value)).join('')}</section><section class="detail-card"><h3>QA</h3>${Object.entries(qa).map(([key, value]) => kv(key, value === null ? '—' : String(value))).join('')}</section></div>`;
}
function renderJsonTab(job) {
  const clean = clone(job);
  delete clean._layers;
  delete clean._summary;
  return `<pre class="json-view">${escapeHtml(JSON.stringify(clean, null, 2))}</pre>`;
}

function renderVideoTab() {
  if (!state.draft) return;
  $('#tabs').innerHTML = VIDEO_TABS.map(([id, label]) => `<button class="tab ${id === state.activeTab ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('');
  const renderers = {
    summary: renderSummaryTab,
    content: renderContentTab,
    cover: renderCoverTab,
    publishing: renderPublishingTab,
    links: renderLinksTab,
    metrics: renderMetricsTab,
    render: renderRenderTab,
    json: renderJsonTab
  };
  $('#modalBody').innerHTML = renderers[state.activeTab](state.draft);
  bindModalBody();
}

function bindModalBody() {
  $$('[data-edit-path]', $('#modalBody')).forEach(input => {
    input.addEventListener('input', () => {
      const path = input.dataset.editPath;
      let value = input.value;
      if (input.dataset.array === 'hashtags') value = value.split(/\s+/).map(item => item.trim()).filter(Boolean);
      if (input.dataset.array === 'tags') value = value.split(',').map(item => item.trim()).filter(Boolean);
      if (input.type === 'datetime-local') value = outputDate(value);
      setPath(state.draft, path, value);

      if (path === 'admin.status') {
        state.adminStatusDirty = true;
        if (value) {
          state.draft.admin ||= {};
          state.draft.admin.status = value;
        } else {
          delete state.draft.admin?.status;
        }
      }
      if (path.startsWith('publishing.')) refreshCountersOnly();
    });
  });

  $$('.copy-btn', $('#modalBody')).forEach(button => {
    button.addEventListener('click', async () => {
      const value = getPath(state.draft, button.dataset.copyPath);
      const text = Array.isArray(value) ? value.join(button.dataset.copyPath.endsWith('.tags') ? ', ' : ' ') : (value ?? '');
      await navigator.clipboard.writeText(String(text));
      button.textContent = 'Copiado';
      setTimeout(() => { button.textContent = 'Copiar'; }, 1000);
    });
  });
}
function refreshCountersOnly() {
  ['tiktok', 'youtube', 'facebook'].forEach(platform => {
    const container = $(`[data-counter-platform="${platform}"]`, $('#modalBody'));
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = platformCounters(platform, state.draft.publishing?.[platform] || {});
    container.replaceWith(wrapper.firstElementChild);
  });
}

function showModalMessage(text, type = 'success', timeout = 0) {
  const el = $('#modalMessage');
  el.textContent = text;
  el.className = `message ${type}`;
  if (timeout) setTimeout(() => el.classList.add('hidden'), timeout);
}

async function openJob(jobId) {
  $('#videoModal').classList.remove('hidden');
  $('#modalBody').innerHTML = '<div class="state-panel">Cargando video…</div>';
  try {
    const { job } = await api(`/api/jobs/${jobId}`);
    state.currentJob = job;
    state.draft = clone(job);
    state.activeTab = 'summary';
    state.adminStatusWasExplicit = Object.hasOwn(job.admin || {}, 'status');
    state.adminStatusDirty = false;
    $('#modalJobId').textContent = job.id;
    $('#modalTitle').textContent = job.title;
    renderVideoTab();
  } catch (error) { showModalMessage(error.message, 'error'); }
}
function closeVideoModal() {
  $('#videoModal').classList.add('hidden');
  state.currentJob = null;
  state.draft = null;
}

function buildOverridePayloadFor(job, { adminStatusWasExplicit = false, adminStatusDirty = false } = {}) {
  const fields = {
    tiktok: ['caption', 'hashtags', 'searchKeyword', 'coverText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
    youtube: ['title', 'description', 'hashtags', 'tags', 'thumbnailText', 'cta', 'pinnedComment', 'status', 'scheduledAt', 'publishedAt', 'url', 'videoId'],
    facebook: ['description', 'hashtags', 'coverText', 'cta', 'pinnedComment', 'audience', 'status', 'scheduledAt', 'publishedAt', 'url', 'postId']
  };
  const payload = { publishing: {} };

  if ((adminStatusWasExplicit || adminStatusDirty) && job.admin?.status) {
    payload.admin = { status: job.admin.status };
  }

  for (const platform of Object.keys(fields)) {
    payload.publishing[platform] = {};
    for (const field of fields[platform]) {
      payload.publishing[platform][field] = job.publishing?.[platform]?.[field] ?? null;
    }
  }
  return payload;
}

function buildOverridePayload() {
  return buildOverridePayloadFor(state.draft, {
    adminStatusWasExplicit: state.adminStatusWasExplicit,
    adminStatusDirty: state.adminStatusDirty
  });
}
function validateAllDraft() {
  return Object.keys(PLATFORM_LABELS).flatMap(platform => {
    const result = validatePlatform(platform, state.draft.publishing?.[platform] || {});
    return result.errors.map(error => `${PLATFORM_LABELS[platform]}: ${error}`);
  });
}
async function saveLocal() {
  const errors = validateAllDraft();
  if (errors.length) {
    showModalMessage(errors.join(' '), 'error');
    state.activeTab = 'publishing';
    renderVideoTab();
    return;
  }
  $('#saveLocalBtn').disabled = true;
  try {
    const { job } = await api(`/api/dashboard/${state.draft.id}`, { method: 'PUT', body: JSON.stringify(buildOverridePayload()) });
    state.currentJob = job;
    state.draft = clone(job);
    state.adminStatusWasExplicit = Object.hasOwn(job.admin || {}, 'status');
    state.adminStatusDirty = false;
    showModalMessage('Cambios guardados localmente en db/dashboard.', 'success', 2200);
    renderVideoTab();
    await loadCoreData();
  } catch (error) { showModalMessage(error.message, 'error'); }
  finally { $('#saveLocalBtn').disabled = false; }
}
async function saveGithub() {
  const errors = validateAllDraft();
  if (errors.length) {
    showModalMessage(errors.join(' '), 'error');
    state.activeTab = 'publishing';
    renderVideoTab();
    return;
  }
  $('#saveGithubBtn').disabled = true;
  try {
    const { result } = await api(`/api/github/${state.draft.id}`, { method: 'PUT', body: JSON.stringify(buildOverridePayload()) });
    showModalMessage(`Guardado en GitHub: ${result.path}${result.commit ? ` · ${result.commit.slice(0, 7)}` : ''}`, 'success');
  } catch (error) { showModalMessage(error.message, 'error'); }
  finally { $('#saveGithubBtn').disabled = !(state.config?.github?.tokenConfigured); }
}

function switchView(view) {
  $$('.view').forEach(element => element.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  $$('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  const [title, subtitle] = VIEW_META[view];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = subtitle;
  if (view === 'servers') loadServers();
  if (view === 'calendar') renderCalendar();
  if (view === 'metrics') renderMetricsCenter();
}

async function loadCoreData() {
  clearGlobalError();
  try {
    const [config, jobsResponse, schedule, channels, integrations] = await Promise.all([
      api('/api/config'),
      api('/api/jobs'),
      api('/api/schedule'),
      api('/api/channels'),
      api('/api/integrations')
    ]);
    state.config = config;
    state.jobs = jobsResponse.jobs || [];
    state.schedule = schedule;
    state.channels = channels;
    state.integrations = integrations;
    buildSignatures();
    renderSummary();
    applyFilters();
    renderPublishingCenter();
    renderMetricsCenter();
    renderCalendar();
    renderChannels();
    renderGithubPanel();
    renderIntegrations();
  } catch (error) {
    $('#loadingState').classList.add('hidden');
    showGlobalError(error);
  }
}

document.addEventListener('click', event => {
  const card = event.target.closest('.video-card, .video-open');
  if (card?.dataset.jobId) openJob(card.dataset.jobId);

  const tab = event.target.closest('[data-tab]');
  if (tab) {
    state.activeTab = tab.dataset.tab;
    renderVideoTab();
  }

  const scheduleButton = event.target.closest('.schedule-open');
  if (scheduleButton) {
    const item = state.schedule.events.find(entry => entry.id === scheduleButton.dataset.scheduleId);
    if (item) openScheduleModal(item);
  }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-channel-upload]')) uploadChannelFile(event.target);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('#videoModal').classList.contains('hidden')) closeVideoModal();
    else if (!$('#scheduleModal').classList.contains('hidden')) closeScheduleModal();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('video-card')) {
    event.preventDefault();
    openJob(event.target.dataset.jobId);
  }
});

$('#searchInput').addEventListener('input', applyFilters);
$('#statusFilter').addEventListener('change', applyFilters);
$('#sortSelect').addEventListener('change', applyFilters);
$('#metricsJobSelect').addEventListener('change', renderMetricsSelected);
$('#refreshBtn').addEventListener('click', loadCoreData);
$('#closeModalBtn').addEventListener('click', closeVideoModal);
$('#saveLocalBtn').addEventListener('click', saveLocal);
$('#saveGithubBtn').addEventListener('click', saveGithub);
$('#videoModal').addEventListener('click', event => { if (event.target === $('#videoModal')) closeVideoModal(); });

$$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

$('#prevMonthBtn').addEventListener('click', () => {
  state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() - 1, 1);
  renderCalendar();
});
$('#nextMonthBtn').addEventListener('click', () => {
  state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + 1, 1);
  renderCalendar();
});
$('#newScheduleBtn').addEventListener('click', () => openScheduleModal());
$('#closeScheduleModalBtn').addEventListener('click', closeScheduleModal);
$('#cancelScheduleBtn').addEventListener('click', closeScheduleModal);
$('#saveScheduleBtn').addEventListener('click', saveScheduleEvent);
$('#deleteScheduleBtn').addEventListener('click', deleteScheduleEvent);
$('#scheduleModal').addEventListener('click', event => { if (event.target === $('#scheduleModal')) closeScheduleModal(); });

$('#saveGithubConfigBtn').addEventListener('click', saveGithubConfig);
$('#syncGithubBtn').addEventListener('click', syncGithub);
$('#deleteGithubTokenBtn').addEventListener('click', deleteGithubToken);

$('#saveIntegrationsBtn').addEventListener('click', saveIntegrations);

$('#startRendererBtn').addEventListener('click', () => serverAction('/api/servers/renderer/start'));
$('#stopRendererBtn').addEventListener('click', () => serverAction('/api/servers/renderer/stop'));
$('#startFactoryBtn').addEventListener('click', () => serverAction('/api/servers/factory/start'));
$('#stopFactoryBtn').addEventListener('click', () => serverAction('/api/servers/factory/stop'));

loadCoreData();
