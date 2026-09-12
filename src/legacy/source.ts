import fs from 'node:fs/promises';
import path from 'node:path';
import { deepMerge, isPlainObject, type JsonObject } from './deep-merge.js';
import { semanticHash, sha256 } from './stable-json.js';

export interface LegacyLayer {
  path: string;
  hash: string;
  json: JsonObject;
}

export interface LegacySourceJob {
  fileId: string;
  base: LegacyLayer;
  v3?: LegacyLayer;
  v4?: LegacyLayer;
  dashboard?: LegacyLayer;
  effective: JsonObject;
  effectiveHash: string;
}

export interface LegacyPaths {
  root: string;
  jobs: string;
  v3: string;
  v4: string;
  dashboard: string;
  factory: string;
}

export function legacyPaths(root = process.cwd()): LegacyPaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    jobs: path.join(resolved, 'db', 'jobs'),
    v3: path.join(resolved, 'db', 'migrations', 'v3'),
    v4: path.join(resolved, 'db', 'migrations', 'v4'),
    dashboard: path.join(resolved, 'db', 'dashboard'),
    factory: path.join(resolved, 'config', 'factory.json'),
  };
}

export async function discoverLegacyJobIds(root = process.cwd()): Promise<string[]> {
  const { jobs } = legacyPaths(root);
  const entries = await fs.readdir(jobs, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^religion-\d{6}\.json$/.test(entry.name))
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .sort();
}

async function readLayer(filePath: string, root: string, required: boolean): Promise<LegacyLayer | undefined> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(filePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (!isPlainObject(parsed)) throw new Error(`Legacy layer must be a JSON object: ${filePath}`);

  return {
    path: path.relative(root, filePath),
    hash: sha256(raw),
    json: parsed,
  };
}

export async function loadLegacyJob(fileId: string, root = process.cwd()): Promise<LegacySourceJob> {
  if (!/^religion-\d{6}$/.test(fileId)) throw new Error(`Invalid legacy job id: ${fileId}`);
  const paths = legacyPaths(root);
  const fileName = `${fileId}.json`;

  const [base, v3, v4, dashboard] = await Promise.all([
    readLayer(path.join(paths.jobs, fileName), paths.root, true),
    readLayer(path.join(paths.v3, fileName), paths.root, false),
    readLayer(path.join(paths.v4, fileName), paths.root, false),
    readLayer(path.join(paths.dashboard, fileName), paths.root, false),
  ]);

  if (!base) throw new Error(`Missing required base job: ${fileId}`);
  const effective = deepMerge(base.json, v3?.json ?? {}, v4?.json ?? {}, dashboard?.json ?? {});

  return {
    fileId,
    base,
    ...(v3 ? { v3 } : {}),
    ...(v4 ? { v4 } : {}),
    ...(dashboard ? { dashboard } : {}),
    effective,
    effectiveHash: semanticHash(effective),
  };
}

export async function loadAllLegacyJobs(root = process.cwd()): Promise<LegacySourceJob[]> {
  const ids = await discoverLegacyJobIds(root);
  return Promise.all(ids.map((id) => loadLegacyJob(id, root)));
}

export async function loadFactoryFallbackChannel(root = process.cwd()): Promise<string> {
  const { factory } = legacyPaths(root);
  const parsed: unknown = JSON.parse(await fs.readFile(factory, 'utf8'));
  if (!isPlainObject(parsed) || typeof parsed.channel !== 'string' || !parsed.channel.trim()) {
    throw new Error('config/factory.json does not contain a valid channel fallback');
  }
  return parsed.channel.trim();
}

export async function snapshotLegacySources(root = process.cwd()): Promise<Record<string, string>> {
  const paths = legacyPaths(root);
  const directories = [paths.jobs, paths.v3, paths.v4, paths.dashboard];
  const snapshot: Record<string, string> = {};

  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const absolute = path.join(directory, entry.name);
      snapshot[path.relative(paths.root, absolute)] = sha256(await fs.readFile(absolute));
    }
  }

  return Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
}
