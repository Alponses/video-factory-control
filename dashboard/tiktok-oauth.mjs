import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.TIKTOK_OAUTH_PORT || 3455);
const SCOPES = ['user.info.basic', 'video.list'];
const pending = new Map();

function secretsPath(root = DEFAULT_ROOT) {
  return path.join(root, 'dashboard', '.secrets.json');
}

async function readSecrets(root = DEFAULT_ROOT) {
  try {
    return JSON.parse(await fs.readFile(secretsPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeSecrets(value, root = DEFAULT_ROOT) {
  const file = secretsPath(root);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  try { await fs.chmod(file, 0o600); } catch { /* best effort */ }
}

function redirectUri(port = DEFAULT_PORT) {
  return `http://${HOST}:${port}/callback/`;
}

function cleanPending() {
  const now = Date.now();
  for (const [state, entry] of pending.entries()) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

function verifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function challenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('hex');
}

async function saveClientCredentials({ clientKey, clientSecret }, root = DEFAULT_ROOT) {
  const secrets = await readSecrets(root);
  secrets.integrations ||= {};
  secrets.integrations.tiktok ||= {};
  if (clientKey) secrets.integrations.tiktok.clientKey = clientKey.trim();
  if (clientSecret) secrets.integrations.tiktok.clientSecret = clientSecret.trim();
  await writeSecrets(secrets, root);
}

async function exchangeToken(params, root = DEFAULT_ROOT) {
  const secrets = await readSecrets(root);
  const tiktok = secrets.integrations?.tiktok || {};
  if (!tiktok.clientKey || !tiktok.clientSecret) {
    throw new Error('Primero guarda Client Key y Client Secret.');
  }

  const body = new URLSearchParams({
    client_key: tiktok.clientKey,
    client_secret: tiktok.clientSecret,
    ...params
  });
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.message || data.error || `TikTok OAuth ${response.status}`);
  }
  return data;
}

async function persistTokens(data, root = DEFAULT_ROOT) {
  const secrets = await readSecrets(root);
  secrets.integrations ||= {};
  const current = secrets.integrations.tiktok || {};
  const now = Date.now();
  secrets.integrations.tiktok = {
    ...current,
    accessToken: data.access_token || current.accessToken || '',
    refreshToken: data.refresh_token || current.refreshToken || '',
    openId: data.open_id || current.openId || '',
    scope: data.scope || current.scope || '',
    tokenType: data.token_type || 'Bearer',
    accessExpiresAt: Number.isFinite(Number(data.expires_in)) ? new Date(now + Number(data.expires_in) * 1000).toISOString() : current.accessExpiresAt || null,
    refreshExpiresAt: Number.isFinite(Number(data.refresh_expires_in)) ? new Date(now + Number(data.refresh_expires_in) * 1000).toISOString() : current.refreshExpiresAt || null,
    updatedAt: new Date().toISOString()
  };
  await writeSecrets(secrets, root);
  return secrets.integrations.tiktok;
}

export async function refreshTikTokToken(root = DEFAULT_ROOT, { force = false } = {}) {
  const secrets = await readSecrets(root);
  const tiktok = secrets.integrations?.tiktok || {};
  if (!tiktok.refreshToken || !tiktok.clientKey || !tiktok.clientSecret) return { refreshed: false, reason: 'not-configured' };

  const expiresAt = tiktok.accessExpiresAt ? Date.parse(tiktok.accessExpiresAt) : 0;
  if (!force && expiresAt && expiresAt - Date.now() > 30 * 60 * 1000) {
    return { refreshed: false, reason: 'not-needed' };
  }

  const data = await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: tiktok.refreshToken
  }, root);
  await persistTokens(data, root);
  return { refreshed: true };
}

async function publicStatus(root = DEFAULT_ROOT) {
  try { await refreshTikTokToken(root); } catch { /* status must not expose token errors as secrets */ }
  const secrets = await readSecrets(root);
  const tiktok = secrets.integrations?.tiktok || {};
  return {
    clientConfigured: Boolean(tiktok.clientKey && tiktok.clientSecret),
    connected: Boolean(tiktok.accessToken && tiktok.refreshToken),
    scopes: String(tiktok.scope || '').split(',').map(item => item.trim()).filter(Boolean),
    accessExpiresAt: tiktok.accessExpiresAt || null,
    refreshExpiresAt: tiktok.refreshExpiresAt || null
  };
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>\"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' })[char]);
}

async function page(root = DEFAULT_ROOT, message = '') {
  const status = await publicStatus(root);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar TikTok · Pausa con Fe</title><style>
  :root{color-scheme:dark}body{margin:0;background:#080d16;color:#eef4ff;font-family:Inter,system-ui,sans-serif}.wrap{max-width:760px;margin:40px auto;padding:20px}.card{background:#101a2b;border:1px solid #22334f;border-radius:18px;padding:20px;margin-bottom:14px}h1{margin-top:0}p{color:#c7d4e9;line-height:1.5}.status{padding:10px 12px;border-radius:10px;background:#0a1423;border:1px solid #263b5a;margin:12px 0}.ok{color:#91efb5}.warn{color:#ffd78a}label{display:grid;gap:6px;margin:12px 0;font-size:12px;color:#9cafcc}input{background:#08111f;border:1px solid #263b5a;color:#fff;padding:11px;border-radius:10px}.btn{display:inline-block;border:0;border-radius:10px;padding:10px 13px;background:#72aaff;color:#07101e;font-weight:800;text-decoration:none;cursor:pointer}.secondary{background:#1b2942;color:#dce8ff}.danger{background:#ff7373;color:#1a0909}.actions{display:flex;gap:8px;flex-wrap:wrap}.code{font-family:ui-monospace,monospace;background:#07101e;padding:10px;border-radius:9px;border:1px solid #22334f;word-break:break-all}</style></head><body><div class="wrap">
  <div class="card"><h1>TikTok · Pausa con Fe</h1><p>OAuth 2.0 Desktop con PKCE. Client Secret, access token y refresh token se guardan sólo en <code>dashboard/.secrets.json</code>.</p>${message ? `<div class="status">${escapeHtml(message)}</div>` : ''}<div class="status ${status.connected ? 'ok' : 'warn'}"><b>${status.connected ? 'TikTok conectado' : status.clientConfigured ? 'Credenciales listas; falta autorizar la cuenta' : 'Faltan Client Key y Client Secret'}</b><br>Scopes: ${escapeHtml(status.scopes.join(', ') || '—')}<br>Access expira: ${escapeHtml(status.accessExpiresAt || '—')}</div></div>
  <div class="card"><h2>1. Configuración en TikTok Developer</h2><p>Registra exactamente este Redirect URI en Login Kit:</p><div class="code">${escapeHtml(redirectUri())}</div><p>Scopes requeridos: <code>user.info.basic</code> y <code>video.list</code>.</p></div>
  <form class="card" method="post" action="/config"><h2>2. Credenciales de la app</h2><label>Client Key<input name="clientKey" autocomplete="off" required></label><label>Client Secret<input name="clientSecret" type="password" autocomplete="new-password" required></label><button class="btn" type="submit">Guardar credenciales</button></form>
  <div class="card"><h2>3. Autorizar la cuenta</h2><div class="actions"><a class="btn" href="/oauth/start">Conectar TikTok</a><form method="post" action="/refresh"><button class="btn secondary" type="submit">Refrescar token ahora</button></form><form method="post" action="/disconnect" onsubmit="return confirm('¿Desconectar TikTok y borrar tokens de usuario?')"><button class="btn danger" type="submit">Desconectar</button></form><a class="btn secondary" href="http://127.0.0.1:4173/">Volver al Admin</a></div></div>
</div></body></html>`;
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}

export function createTikTokOAuthServer({ root = process.env.VIDEO_FACTORY_ROOT || DEFAULT_ROOT, port = DEFAULT_PORT } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}:${port}`);
      cleanPending();

      if (req.method === 'GET' && url.pathname === '/') {
        return html(res, 200, await page(root));
      }

      if (req.method === 'POST' && url.pathname === '/config') {
        const form = await readForm(req);
        const clientKey = String(form.get('clientKey') || '').trim();
        const clientSecret = String(form.get('clientSecret') || '').trim();
        if (!clientKey || !clientSecret) throw new Error('Client Key y Client Secret son obligatorios.');
        await saveClientCredentials({ clientKey, clientSecret }, root);
        return html(res, 200, await page(root, 'Credenciales guardadas. Ahora pulsa Conectar TikTok.'));
      }

      if (req.method === 'GET' && url.pathname === '/oauth/start') {
        const secrets = await readSecrets(root);
        const tiktok = secrets.integrations?.tiktok || {};
        if (!tiktok.clientKey || !tiktok.clientSecret) throw new Error('Primero guarda Client Key y Client Secret.');
        const state = crypto.randomBytes(24).toString('hex');
        const codeVerifier = verifier();
        pending.set(state, { codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 });
        const auth = new URL('https://www.tiktok.com/v2/auth/authorize/');
        auth.searchParams.set('client_key', tiktok.clientKey);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('scope', SCOPES.join(','));
        auth.searchParams.set('redirect_uri', redirectUri(port));
        auth.searchParams.set('state', state);
        auth.searchParams.set('code_challenge', challenge(codeVerifier));
        auth.searchParams.set('code_challenge_method', 'S256');
        return redirect(res, auth.toString());
      }

      if (req.method === 'GET' && url.pathname === '/callback/') {
        if (url.searchParams.get('error')) {
          throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
        }
        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        const flow = pending.get(state);
        if (!state || !code || !flow || flow.expiresAt <= Date.now()) {
          throw new Error('Callback inválido o expirado. Vuelve a iniciar Conectar TikTok.');
        }
        pending.delete(state);
        const data = await exchangeToken({
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri(port),
          code_verifier: flow.codeVerifier
        }, root);
        await persistTokens(data, root);
        return html(res, 200, await page(root, 'TikTok conectado correctamente. Ya puedes volver al Admin.'));
      }

      if (req.method === 'POST' && url.pathname === '/refresh') {
        await refreshTikTokToken(root, { force: true });
        return html(res, 200, await page(root, 'Token de TikTok actualizado.'));
      }

      if (req.method === 'POST' && url.pathname === '/disconnect') {
        const secrets = await readSecrets(root);
        if (secrets.integrations?.tiktok) {
          const { clientKey, clientSecret } = secrets.integrations.tiktok;
          secrets.integrations.tiktok = { clientKey: clientKey || '', clientSecret: clientSecret || '' };
          await writeSecrets(secrets, root);
        }
        return html(res, 200, await page(root, 'Cuenta TikTok desconectada. Las credenciales de la app se conservaron.'));
      }

      return html(res, 404, await page(root, 'Ruta no encontrada.'));
    } catch (error) {
      console.error(`[tiktok-oauth] ${error.message || 'Error'}`);
      return html(res, 400, await page(root, error.message || 'Error de TikTok OAuth'));
    }
  });
}

export async function startTikTokOAuthServer({ root = process.env.VIDEO_FACTORY_ROOT || DEFAULT_ROOT, port = DEFAULT_PORT } = {}) {
  const server = createTikTokOAuthServer({ root, port });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  const timer = setInterval(() => {
    refreshTikTokToken(root).catch(error => console.error(`[tiktok-oauth] refresh: ${error.message}`));
  }, 10 * 60 * 1000);
  timer.unref();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startTikTokOAuthServer()
    .then(server => console.log(`TikTok OAuth: http://${HOST}:${server.address().port}`))
    .catch(error => {
      console.error(`[tiktok-oauth] ${error.message}`);
      process.exitCode = 1;
    });
}
