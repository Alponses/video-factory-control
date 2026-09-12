import { Platform, PrismaClient } from '@prisma/client';
import { isPlainObject } from './deep-merge.js';
import { mapVideoStatus, normalizeLegacyJob } from './normalize.js';
import { loadAllLegacyJobs, loadFactoryFallbackChannel } from './source.js';
import { stableStringify } from './stable-json.js';

export interface LegacyVerificationReport {
  jobsDiscovered: number;
  jobsImported: number;
  jobsSkipped: number;
  jobsUpdated: number;
  sceneTotals: { expected: number; actual: number };
  publicationTotals: { expected: number; actual: number };
  renderRecords: { expected: number; actual: number };
  qaRecords: { expected: number; actual: number };
  assetRecords: { expected: number; actual: number };
  warnings: string[];
  legacyIncompleteJobs: Array<{ id: string; scenes: number; reasons: string[] }>;
  duplicateIds: string[];
  sources: Array<{
    id: string;
    baseHash: string;
    v3Hash: string | null;
    v4Hash: string | null;
    dashboardHash: string | null;
    effectiveHash: string;
  }>;
  errors: string[];
  result: 'PASS' | 'FAIL';
}

function equalJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function object(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function platformKey(platform: Platform): 'tiktok' | 'youtube' | 'facebook' {
  if (platform === Platform.TIKTOK) return 'tiktok';
  if (platform === Platform.YOUTUBE) return 'youtube';
  return 'facebook';
}

export async function verifyLegacy(prisma: PrismaClient, root = process.cwd()): Promise<LegacyVerificationReport> {
  const [sources, fallbackChannel] = await Promise.all([
    loadAllLegacyJobs(root),
    loadFactoryFallbackChannel(root),
  ]);

  const internalIds = sources.map((source) => typeof source.effective.id === 'string' ? source.effective.id : source.fileId);
  const duplicateIds = [...new Set(internalIds.filter((id, index) => internalIds.indexOf(id) !== index))].sort();
  const errors: string[] = duplicateIds.map((id) => `duplicate legacy id: ${id}`);
  const warnings: string[] = [];
  const legacyIncompleteJobs: LegacyVerificationReport['legacyIncompleteJobs'] = [];

  let expectedScenes = 0;
  let expectedPublications = 0;
  let expectedRender = 0;
  let expectedQa = 0;
  let expectedAssets = 0;
  let matchingSources = 0;
  let changedSources = 0;

  for (const source of sources) {
    const expected = normalizeLegacyJob(source, fallbackChannel);
    expectedScenes += expected.scenes.length;
    expectedPublications += expected.publications.length;
    expectedRender += expected.render ? 1 : 0;
    expectedQa += expected.qa ? 1 : 0;
    expectedAssets += expected.legacyAssets.length;

    if (expected.legacyIncomplete) {
      legacyIncompleteJobs.push({ id: expected.id, scenes: expected.scenes.length, reasons: expected.warnings });
      warnings.push(`${expected.id}: legacy incomplete; scenes: ${expected.scenes.length}; ${expected.warnings.join(', ')}`);
    }

    const row = await prisma.video.findUnique({
      where: { id: expected.id },
      include: {
        scenes: { orderBy: { position: 'asc' } },
        publications: true,
        renderAttempts: { where: { attempt: 1 } },
        qaResults: { where: { attempt: 1 } },
        assets: { where: { storageProvider: 'LEGACY_LOCAL' } },
        legacyImport: true,
      },
    });

    if (!row) {
      errors.push(`${expected.id}: missing video row`);
      continue;
    }
    if (!row.legacyImport) {
      errors.push(`${expected.id}: missing legacy_import row`);
      continue;
    }

    const legacy = row.legacyImport;
    const hashesMatch = legacy.baseHash === source.base.hash
      && legacy.v3Hash === (source.v3?.hash ?? null)
      && legacy.v4Hash === (source.v4?.hash ?? null)
      && legacy.dashboardHash === (source.dashboard?.hash ?? null)
      && legacy.effectiveHash === source.effectiveHash;
    if (hashesMatch) matchingSources += 1;
    else changedSources += 1;

    if (!hashesMatch) errors.push(`${expected.id}: source/hash information does not match current read-only files`);
    if (!equalJson(legacy.baseJson, source.base.json)) errors.push(`${expected.id}: base JSON not preserved`);
    if (!equalJson(legacy.v3Json, source.v3?.json ?? null)) errors.push(`${expected.id}: V3 JSON not preserved`);
    if (!equalJson(legacy.v4Json, source.v4?.json ?? null)) errors.push(`${expected.id}: V4 JSON not preserved`);
    if (!equalJson(legacy.dashboardJson, source.dashboard?.json ?? null)) errors.push(`${expected.id}: dashboard override JSON not preserved`);
    if (!equalJson(legacy.effectiveJson, source.effective)) errors.push(`${expected.id}: effective merged JSON not preserved`);

    if (row.slug !== expected.slug) errors.push(`${expected.id}: slug mismatch`);
    if (row.title !== expected.title) errors.push(`${expected.id}: title mismatch`);
    if (row.category !== expected.category) errors.push(`${expected.id}: category mismatch`);
    if (row.status !== mapVideoStatus(source.effective)) errors.push(`${expected.id}: effective status mismatch`);
    if (row.legacyIncomplete !== expected.legacyIncomplete) errors.push(`${expected.id}: legacyIncomplete mismatch`);
    if (row.createdAt.getTime() !== expected.createdAt.getTime()) errors.push(`${expected.id}: createdAt mismatch`);

    const metadata = object(row.metadata);
    if (!metadata || !equalJson(metadata.effective, source.effective)) errors.push(`${expected.id}: full effective JSON missing from video.metadata`);
    if (!equalJson(row.cover, expected.cover)) errors.push(`${expected.id}: cover mismatch`);
    if (!equalJson(row.renderConfig, expected.renderConfig)) errors.push(`${expected.id}: renderConfig mismatch`);
    if (!equalJson(row.engagement, expected.engagement)) errors.push(`${expected.id}: engagement mismatch`);

    const discovery = object(source.effective.discovery);
    const content = object(source.effective.content);
    const hook = object(content?.hook);
    if ((row.primaryKeyword ?? null) !== (typeof discovery?.primaryKeyword === 'string' ? discovery.primaryKeyword : null)) errors.push(`${expected.id}: discovery.primaryKeyword mismatch`);
    if ((row.hookText ?? null) !== (typeof hook?.text === 'string' ? hook.text : null)) errors.push(`${expected.id}: content.hook mismatch`);
    if ((row.closing ?? null) !== (typeof content?.closing === 'string' ? content.closing : null)) errors.push(`${expected.id}: content.closing mismatch`);

    if (row.scenes.length !== expected.scenes.length) errors.push(`${expected.id}: scene count expected ${expected.scenes.length}, got ${row.scenes.length}`);
    expected.scenes.forEach((scene, index) => {
      const actual = row.scenes[index];
      if (!actual || actual.position !== scene.position || actual.text !== scene.text || !equalJson(actual.searchTerms, scene.searchTerms)) {
        errors.push(`${expected.id}: scene ${scene.position} mismatch`);
      }
    });

    for (const publication of expected.publications) {
      const actual = row.publications.find((item) => item.platform === publication.platform);
      const key = platformKey(publication.platform);
      if (!actual) {
        errors.push(`${expected.id}: missing ${key} publication`);
        continue;
      }
      if (!equalJson(actual.raw, publication.raw)) errors.push(`${expected.id}: ${key} publishing metadata mismatch`);
      if (!equalJson(actual.performanceRaw, publication.performanceRaw ?? null)) errors.push(`${expected.id}: ${key} performance metadata mismatch`);
    }

    if (expected.render) {
      const actual = row.renderAttempts[0];
      if (!actual) errors.push(`${expected.id}: render record missing`);
      else {
        if (!equalJson(actual.raw, expected.render.raw)) errors.push(`${expected.id}: render JSON mismatch`);
        if ((actual.rendererVideoId ?? null) !== expected.render.rendererVideoId) errors.push(`${expected.id}: rendererVideoId mismatch`);
      }
    } else if (row.renderAttempts.length !== 0) {
      errors.push(`${expected.id}: unexpected render record`);
    }

    if (expected.qa) {
      const actual = row.qaResults[0];
      if (!actual) errors.push(`${expected.id}: QA record missing`);
      else if (!equalJson(actual.raw, expected.qa.raw)) errors.push(`${expected.id}: QA JSON mismatch`);
    } else if (row.qaResults.length !== 0) {
      errors.push(`${expected.id}: unexpected QA record`);
    }

    if (row.assets.length !== expected.legacyAssets.length) errors.push(`${expected.id}: legacy asset count mismatch`);
  }

  const ids = sources.map((source) => source.fileId);
  const [jobsImported, actualScenes, actualPublications, actualRender, actualQa, actualAssets, legacyRows] = await Promise.all([
    prisma.video.count({ where: { id: { in: ids } } }),
    prisma.videoScene.count({ where: { videoId: { in: ids } } }),
    prisma.publication.count({ where: { videoId: { in: ids } } }),
    prisma.renderAttempt.count({ where: { videoId: { in: ids } } }),
    prisma.qaResult.count({ where: { videoId: { in: ids } } }),
    prisma.videoAsset.count({ where: { videoId: { in: ids }, storageProvider: 'LEGACY_LOCAL' } }),
    prisma.legacyImport.count({ where: { videoId: { in: ids } } }),
  ]);

  if (jobsImported !== sources.length) errors.push(`legacy video count expected ${sources.length}, got ${jobsImported}`);
  if (legacyRows !== sources.length) errors.push(`legacy import count expected ${sources.length}, got ${legacyRows}`);
  if (actualScenes !== expectedScenes) errors.push(`scene total expected ${expectedScenes}, got ${actualScenes}`);
  if (actualPublications !== expectedPublications) errors.push(`publication total expected ${expectedPublications}, got ${actualPublications}`);
  if (actualRender !== expectedRender) errors.push(`render record total expected ${expectedRender}, got ${actualRender}`);
  if (actualQa !== expectedQa) errors.push(`QA record total expected ${expectedQa}, got ${actualQa}`);
  if (actualAssets !== expectedAssets) errors.push(`asset record total expected ${expectedAssets}, got ${actualAssets}`);

  const religionOne = legacyIncompleteJobs.find((job) => job.id === 'religion-000001');
  if (!religionOne || religionOne.scenes !== 0) errors.push('religion-000001 must remain legacy incomplete with scenes: 0');

  return {
    jobsDiscovered: sources.length,
    jobsImported,
    jobsSkipped: matchingSources,
    jobsUpdated: changedSources,
    sceneTotals: { expected: expectedScenes, actual: actualScenes },
    publicationTotals: { expected: expectedPublications, actual: actualPublications },
    renderRecords: { expected: expectedRender, actual: actualRender },
    qaRecords: { expected: expectedQa, actual: actualQa },
    assetRecords: { expected: expectedAssets, actual: actualAssets },
    warnings,
    legacyIncompleteJobs,
    duplicateIds,
    sources: sources.map((source) => ({
      id: source.fileId,
      baseHash: source.base.hash,
      v3Hash: source.v3?.hash ?? null,
      v4Hash: source.v4?.hash ?? null,
      dashboardHash: source.dashboard?.hash ?? null,
      effectiveHash: source.effectiveHash,
    })),
    errors,
    result: errors.length === 0 ? 'PASS' : 'FAIL',
  };
}
