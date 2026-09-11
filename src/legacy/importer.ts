import {
  AssetKind,
  AssetStatus,
  Prisma,
  PrismaClient,
  WorkerStatus,
} from '@prisma/client';
import { loadAllLegacyJobs, loadFactoryFallbackChannel, type LegacySourceJob } from './source.js';
import { normalizeLegacyJob, type NormalizedLegacyJob, type NormalizedPublication } from './normalize.js';

export interface LegacyImportReport {
  jobsDiscovered: number;
  jobsImported: number;
  jobsSkipped: number;
  jobsUpdated: number;
  sceneTotal: number;
  publicationTotal: number;
  renderRecords: number;
  qaRecords: number;
  assetRecords: number;
  warnings: string[];
  legacyIncompleteJobs: Array<{ id: string; scenes: number; reasons: string[] }>;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function nullableJson(value: unknown | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : json(value);
}

function sourceUnchanged(existing: {
  baseHash: string;
  v3Hash: string | null;
  v4Hash: string | null;
  dashboardHash: string | null;
  effectiveHash: string;
}, source: LegacySourceJob): boolean {
  return existing.baseHash === source.base.hash
    && existing.v3Hash === (source.v3?.hash ?? null)
    && existing.v4Hash === (source.v4?.hash ?? null)
    && existing.dashboardHash === (source.dashboard?.hash ?? null)
    && existing.effectiveHash === source.effectiveHash;
}

function publicationData(item: NormalizedPublication) {
  return {
    status: item.status,
    legacyStatus: item.legacyStatus,
    title: item.title,
    caption: item.caption,
    description: item.description,
    hashtags: nullableJson(item.hashtags),
    tags: nullableJson(item.tags),
    searchKeyword: item.searchKeyword,
    coverText: item.coverText,
    thumbnailText: item.thumbnailText,
    cta: item.cta,
    pinnedComment: item.pinnedComment,
    platformId: item.platformId,
    url: item.url,
    scheduledAt: item.scheduledAt,
    publishedAt: item.publishedAt,
    raw: json(item.raw),
    performanceRaw: nullableJson(item.performanceRaw),
  };
}

function videoData(job: NormalizedLegacyJob) {
  return {
    channelId: job.channelId,
    slug: job.slug,
    title: job.title,
    category: job.category,
    status: job.status,
    legacyStatus: job.legacyStatus,
    schemaVersion: job.schemaVersion,
    legacyIncomplete: job.legacyIncomplete,
    primaryKeyword: job.primaryKeyword,
    secondaryKeywords: nullableJson(job.secondaryKeywords),
    searchIntent: job.searchIntent,
    hookText: job.hookText,
    hookType: job.hookType,
    closing: job.closing,
    cta: job.cta,
    question: job.question,
    pinnedComment: job.pinnedComment,
    wordCount: job.wordCount,
    cover: nullableJson(job.cover),
    renderConfig: nullableJson(job.renderConfig),
    engagement: nullableJson(job.engagement),
    metadata: json(job.metadata),
    createdAt: job.createdAt,
  };
}

async function importOne(prisma: PrismaClient, source: LegacySourceJob, fallbackChannel: string): Promise<'imported' | 'updated' | 'skipped'> {
  const normalized = normalizeLegacyJob(source, fallbackChannel);
  const existing = await prisma.legacyImport.findUnique({ where: { videoId: normalized.id } });
  if (existing && sourceUnchanged(existing, source)) return 'skipped';

  await prisma.$transaction(async (tx) => {
    await tx.channel.upsert({
      where: { id: normalized.channelId },
      create: { id: normalized.channelId, language: 'es-MX', metadata: { importedFromLegacy: true } },
      update: {},
    });

    const workerLabel = normalized.render?.workerLabel ?? null;
    if (workerLabel) {
      await tx.worker.upsert({
        where: { id: workerLabel },
        create: { id: workerLabel, status: WorkerStatus.OFFLINE },
        update: {},
      });
    }

    const commonVideo = videoData(normalized);
    await tx.video.upsert({
      where: { id: normalized.id },
      create: { id: normalized.id, ...commonVideo },
      update: commonVideo,
    });

    const positions = normalized.scenes.map((scene) => scene.position);
    if (positions.length === 0) {
      await tx.videoScene.deleteMany({ where: { videoId: normalized.id } });
    } else {
      await tx.videoScene.deleteMany({
        where: { videoId: normalized.id, position: { notIn: positions } },
      });
      for (const scene of normalized.scenes) {
        await tx.videoScene.upsert({
          where: { videoId_position: { videoId: normalized.id, position: scene.position } },
          create: {
            videoId: normalized.id,
            position: scene.position,
            text: scene.text,
            searchTerms: json(scene.searchTerms),
          },
          update: {
            text: scene.text,
            searchTerms: json(scene.searchTerms),
          },
        });
      }
    }

    const desiredPlatforms = normalized.publications.map((publication) => publication.platform);
    if (desiredPlatforms.length === 0) {
      await tx.publication.deleteMany({ where: { videoId: normalized.id } });
    } else {
      await tx.publication.deleteMany({
        where: { videoId: normalized.id, platform: { notIn: desiredPlatforms } },
      });
      for (const publication of normalized.publications) {
        const data = publicationData(publication);
        await tx.publication.upsert({
          where: { videoId_platform: { videoId: normalized.id, platform: publication.platform } },
          create: { videoId: normalized.id, platform: publication.platform, ...data },
          update: data,
        });
      }
    }

    if (normalized.render) {
      await tx.renderAttempt.upsert({
        where: { videoId_attempt: { videoId: normalized.id, attempt: 1 } },
        create: {
          videoId: normalized.id,
          workerId: workerLabel,
          workerLabel,
          attempt: 1,
          status: normalized.render.status,
          rendererVideoId: normalized.render.rendererVideoId,
          startedAt: normalized.render.startedAt,
          finishedAt: normalized.render.finishedAt,
          durationSeconds: normalized.render.durationSeconds,
          width: normalized.render.width,
          height: normalized.render.height,
          hasAudio: normalized.render.hasAudio,
          localFile: normalized.render.localFile,
          error: normalized.render.error,
          raw: json(normalized.render.raw),
        },
        update: {
          workerId: workerLabel,
          workerLabel,
          status: normalized.render.status,
          rendererVideoId: normalized.render.rendererVideoId,
          startedAt: normalized.render.startedAt,
          finishedAt: normalized.render.finishedAt,
          durationSeconds: normalized.render.durationSeconds,
          width: normalized.render.width,
          height: normalized.render.height,
          hasAudio: normalized.render.hasAudio,
          localFile: normalized.render.localFile,
          error: normalized.render.error,
          raw: json(normalized.render.raw),
        },
      });
    } else {
      await tx.renderAttempt.deleteMany({ where: { videoId: normalized.id, attempt: 1 } });
    }

    if (normalized.qa) {
      await tx.qaResult.upsert({
        where: { videoId_attempt: { videoId: normalized.id, attempt: 1 } },
        create: {
          videoId: normalized.id,
          attempt: 1,
          passed: normalized.qa.passed,
          durationPassed: normalized.qa.durationPassed,
          resolutionPassed: normalized.qa.resolutionPassed,
          audioPassed: normalized.qa.audioPassed,
          captionsPassed: normalized.qa.captionsPassed,
          raw: json(normalized.qa.raw),
        },
        update: {
          passed: normalized.qa.passed,
          durationPassed: normalized.qa.durationPassed,
          resolutionPassed: normalized.qa.resolutionPassed,
          audioPassed: normalized.qa.audioPassed,
          captionsPassed: normalized.qa.captionsPassed,
          raw: json(normalized.qa.raw),
        },
      });
    } else {
      await tx.qaResult.deleteMany({ where: { videoId: normalized.id, attempt: 1 } });
    }

    await tx.videoAsset.deleteMany({
      where: { videoId: normalized.id, storageProvider: 'LEGACY_LOCAL' },
    });
    for (const asset of normalized.legacyAssets) {
      await tx.videoAsset.create({
        data: {
          videoId: normalized.id,
          kind: AssetKind[asset.kind],
          status: AssetStatus.READY,
          storageProvider: 'LEGACY_LOCAL',
          localPath: asset.localPath,
          metadata: json(asset.metadata),
        },
      });
    }

    const legacyData = {
      basePath: source.base.path,
      baseHash: source.base.hash,
      v3Path: source.v3?.path ?? null,
      v3Hash: source.v3?.hash ?? null,
      v4Path: source.v4?.path ?? null,
      v4Hash: source.v4?.hash ?? null,
      dashboardPath: source.dashboard?.path ?? null,
      dashboardHash: source.dashboard?.hash ?? null,
      effectiveHash: source.effectiveHash,
      baseJson: json(source.base.json),
      v3Json: nullableJson(source.v3?.json),
      v4Json: nullableJson(source.v4?.json),
      dashboardJson: nullableJson(source.dashboard?.json),
      effectiveJson: json(source.effective),
    };

    await tx.legacyImport.upsert({
      where: { videoId: normalized.id },
      create: { videoId: normalized.id, ...legacyData },
      update: legacyData,
    });
  });

  return existing ? 'updated' : 'imported';
}

export async function importLegacy(prisma: PrismaClient, root = process.cwd()): Promise<LegacyImportReport> {
  const [sources, fallbackChannel] = await Promise.all([
    loadAllLegacyJobs(root),
    loadFactoryFallbackChannel(root),
  ]);

  let jobsImported = 0;
  let jobsSkipped = 0;
  let jobsUpdated = 0;
  const warnings: string[] = [];
  const legacyIncompleteJobs: LegacyImportReport['legacyIncompleteJobs'] = [];

  for (const source of sources) {
    const normalized = normalizeLegacyJob(source, fallbackChannel);
    if (normalized.legacyIncomplete) {
      legacyIncompleteJobs.push({ id: normalized.id, scenes: normalized.scenes.length, reasons: normalized.warnings });
      warnings.push(`${normalized.id}: legacy incomplete (${normalized.warnings.join(', ')})`);
    }
    const outcome = await importOne(prisma, source, fallbackChannel);
    if (outcome === 'imported') jobsImported += 1;
    else if (outcome === 'updated') jobsUpdated += 1;
    else jobsSkipped += 1;
  }

  const [sceneTotal, publicationTotal, renderRecords, qaRecords, assetRecords] = await Promise.all([
    prisma.videoScene.count({ where: { videoId: { in: sources.map((source) => source.fileId) } } }),
    prisma.publication.count({ where: { videoId: { in: sources.map((source) => source.fileId) } } }),
    prisma.renderAttempt.count({ where: { videoId: { in: sources.map((source) => source.fileId) } } }),
    prisma.qaResult.count({ where: { videoId: { in: sources.map((source) => source.fileId) } } }),
    prisma.videoAsset.count({ where: { videoId: { in: sources.map((source) => source.fileId) }, storageProvider: 'LEGACY_LOCAL' } }),
  ]);

  return {
    jobsDiscovered: sources.length,
    jobsImported,
    jobsSkipped,
    jobsUpdated,
    sceneTotal,
    publicationTotal,
    renderRecords,
    qaRecords,
    assetRecords,
    warnings,
    legacyIncompleteJobs,
  };
}
