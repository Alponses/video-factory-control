const WORKER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface WorkerConfig {
  videoFactoryUrl: string;
  workerId: string;
  workerSecret: string;
  cfAccessClientId: string | null;
  cfAccessClientSecret: string | null;
  cfAccessJwtAssertion: string | null;
  rendererUrl: string;
  heartbeatIntervalMs: number;
  claimIntervalMs: number;
  leaseRenewIntervalMs: number;
  apiTimeoutMs: number;
  rendererTimeoutMs: number;
  rendererPollIntervalMs: number;
  outputDir: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required worker configuration: ${key}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid worker configuration: ${key}`);
  return value;
}

function httpUrl(value: string, key: string, allowHttpLoopback = false): string {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(allowHttpLoopback && loopback && url.protocol === 'http:')) throw new Error(`Invalid worker configuration: ${key}`);
  return url.toString().replace(/\/$/, '');
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workerId = required(env, 'WORKER_ID');
  if (!WORKER_ID.test(workerId) || workerId.length > 64) throw new Error('Invalid worker configuration: WORKER_ID');
  const workerSecret = required(env, 'WORKER_SECRET');
  if (!/^vfws_[A-Za-z0-9_-]{40,}$/.test(workerSecret)) throw new Error('Invalid worker configuration: WORKER_SECRET');
  const clientId = env.CF_ACCESS_CLIENT_ID?.trim() || null;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET?.trim() || null;
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) throw new Error('Cloudflare Service Token ID and secret must be configured together');
  return {
    videoFactoryUrl: httpUrl(required(env, 'VIDEO_FACTORY_URL'), 'VIDEO_FACTORY_URL', true),
    workerId,
    workerSecret,
    cfAccessClientId: clientId,
    cfAccessClientSecret: clientSecret,
    cfAccessJwtAssertion: env.CF_ACCESS_JWT_ASSERTION?.trim() || null,
    rendererUrl: httpUrl(env.RENDERER_URL?.trim() || 'http://127.0.0.1:3123', 'RENDERER_URL', true),
    heartbeatIntervalMs: integer(env, 'HEARTBEAT_INTERVAL_MS', 20_000, 5_000, 300_000),
    claimIntervalMs: integer(env, 'CLAIM_INTERVAL_MS', 15_000, 5_000, 300_000),
    leaseRenewIntervalMs: integer(env, 'LEASE_RENEW_INTERVAL_MS', 30_000, 5_000, 90_000),
    apiTimeoutMs: integer(env, 'API_TIMEOUT_MS', 10_000, 1_000, 60_000),
    rendererTimeoutMs: integer(env, 'RENDERER_TIMEOUT_MS', 10_000, 1_000, 60_000),
    rendererPollIntervalMs: integer(env, 'RENDERER_POLL_INTERVAL_MS', 2_000, 500, 30_000),
    outputDir: env.OUTPUT_DIR?.trim() || './output',
  };
}
