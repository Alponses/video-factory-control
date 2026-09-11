-- Video Factory V5 Phase 1 initial schema.
-- Intentionally limited to broadly compatible MySQL/MariaDB features.

CREATE TABLE `channels` (
  `id` VARCHAR(191) NOT NULL,
  `displayName` VARCHAR(255) NULL,
  `language` VARCHAR(32) NOT NULL DEFAULT 'es-MX',
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `profiles` (
  `id` VARCHAR(191) NOT NULL,
  `channelId` VARCHAR(191) NOT NULL,
  `platform` ENUM('TIKTOK','YOUTUBE','FACEBOOK') NOT NULL,
  `displayName` VARCHAR(255) NULL,
  `username` VARCHAR(255) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `profiles_platform_idx` (`platform`),
  UNIQUE INDEX `profiles_channelId_platform_key` (`channelId`, `platform`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `videos` (
  `id` VARCHAR(191) NOT NULL,
  `channelId` VARCHAR(191) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `category` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','READY','QUEUED','RENDERING','QA','APPROVED','SCHEDULED','PUBLISHING','PUBLISHED','FAILED','CANCELLED') NOT NULL,
  `legacyStatus` VARCHAR(64) NULL,
  `schemaVersion` INTEGER NULL,
  `legacyIncomplete` BOOLEAN NOT NULL DEFAULT false,
  `version` INTEGER NOT NULL DEFAULT 1,
  `primaryKeyword` VARCHAR(500) NULL,
  `secondaryKeywords` JSON NULL,
  `searchIntent` TEXT NULL,
  `hookText` TEXT NULL,
  `hookType` VARCHAR(64) NULL,
  `closing` TEXT NULL,
  `cta` TEXT NULL,
  `question` TEXT NULL,
  `pinnedComment` TEXT NULL,
  `wordCount` INTEGER NULL,
  `cover` JSON NULL,
  `renderConfig` JSON NULL,
  `engagement` JSON NULL,
  `metadata` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `videos_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `videos_category_idx` (`category`),
  UNIQUE INDEX `videos_channelId_slug_key` (`channelId`, `slug`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `video_scenes` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `position` INTEGER NOT NULL,
  `text` TEXT NOT NULL,
  `searchTerms` JSON NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `video_scenes_videoId_idx` (`videoId`),
  UNIQUE INDEX `video_scenes_videoId_position_key` (`videoId`, `position`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `video_assets` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NULL,
  `kind` ENUM('VIDEO','COVER','THUMBNAIL','AUDIO','AVATAR','BANNER','OTHER') NOT NULL,
  `status` ENUM('PENDING','READY','REPLACED','FAILED','DELETED') NOT NULL DEFAULT 'PENDING',
  `platform` ENUM('TIKTOK','YOUTUBE','FACEBOOK') NULL,
  `storageProvider` VARCHAR(32) NOT NULL DEFAULT 'R2',
  `bucket` VARCHAR(255) NULL,
  `objectKey` VARCHAR(512) NULL,
  `localPath` VARCHAR(2048) NULL,
  `mimeType` VARCHAR(191) NULL,
  `size` BIGINT NULL,
  `sha256` VARCHAR(64) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `video_assets_objectKey_key` (`objectKey`),
  INDEX `video_assets_videoId_kind_idx` (`videoId`, `kind`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `publications` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `platform` ENUM('TIKTOK','YOUTUBE','FACEBOOK') NOT NULL,
  `status` ENUM('DRAFT','READY','SCHEDULED','PUBLISHING','PUBLISHED','FAILED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `legacyStatus` VARCHAR(64) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `title` VARCHAR(500) NULL,
  `caption` TEXT NULL,
  `description` TEXT NULL,
  `hashtags` JSON NULL,
  `tags` JSON NULL,
  `searchKeyword` VARCHAR(500) NULL,
  `coverText` TEXT NULL,
  `thumbnailText` TEXT NULL,
  `cta` TEXT NULL,
  `pinnedComment` TEXT NULL,
  `platformId` VARCHAR(255) NULL,
  `url` VARCHAR(2048) NULL,
  `scheduledAt` DATETIME(3) NULL,
  `publishedAt` DATETIME(3) NULL,
  `lastMetricsSyncAt` DATETIME(3) NULL,
  `error` TEXT NULL,
  `raw` JSON NOT NULL,
  `performanceRaw` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `publications_platform_status_idx` (`platform`, `status`),
  UNIQUE INDEX `publications_videoId_platform_key` (`videoId`, `platform`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `publication_metrics` (
  `id` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `availability` ENUM('AVAILABLE','NOT_AUTHORIZED','NOT_SUPPORTED','NOT_COLLECTED') NOT NULL,
  `numericValue` DECIMAL(30,6) NULL,
  `capturedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `publication_metrics_publicationId_key_key` (`publicationId`, `key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `metric_snapshots` (
  `id` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `capturedAt` DATETIME(3) NOT NULL,
  `views` BIGINT NULL,
  `likes` BIGINT NULL,
  `comments` BIGINT NULL,
  `shares` BIGINT NULL,
  `saves` BIGINT NULL,
  `watchTime` DECIMAL(30,6) NULL,
  `averageViewDuration` DECIMAL(30,6) NULL,
  `averagePercentageViewed` DECIMAL(10,4) NULL,
  `completionRate` DECIMAL(10,4) NULL,
  `followersGained` BIGINT NULL,
  `revenue` DECIMAL(30,8) NULL,
  `raw` JSON NULL,
  INDEX `metric_snapshots_publicationId_capturedAt_idx` (`publicationId`, `capturedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `schedules` (
  `id` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `scheduledAt` DATETIME(3) NOT NULL,
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'America/Mexico_City',
  `status` VARCHAR(64) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `schedules_scheduledAt_status_idx` (`scheduledAt`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `workers` (
  `id` VARCHAR(191) NOT NULL,
  `status` ENUM('ONLINE','OFFLINE','BUSY','DEGRADED','DISABLED') NOT NULL DEFAULT 'OFFLINE',
  `agentVersion` VARCHAR(64) NULL,
  `rendererVersion` VARCHAR(64) NULL,
  `secretHash` VARCHAR(255) NULL,
  `secretVersion` INTEGER NOT NULL DEFAULT 1,
  `lastHeartbeatAt` DATETIME(3) NULL,
  `currentVideoId` VARCHAR(191) NULL,
  `progress` INTEGER NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `worker_leases` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `workerId` VARCHAR(191) NOT NULL,
  `leaseTokenHash` VARCHAR(255) NOT NULL,
  `claimedAt` DATETIME(3) NOT NULL,
  `leaseExpiresAt` DATETIME(3) NOT NULL,
  `releasedAt` DATETIME(3) NULL,
  UNIQUE INDEX `worker_leases_leaseTokenHash_key` (`leaseTokenHash`),
  INDEX `worker_leases_videoId_leaseExpiresAt_idx` (`videoId`, `leaseExpiresAt`),
  INDEX `worker_leases_workerId_leaseExpiresAt_idx` (`workerId`, `leaseExpiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `render_attempts` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `workerId` VARCHAR(191) NULL,
  `workerLabel` VARCHAR(191) NULL,
  `attempt` INTEGER NOT NULL,
  `status` ENUM('QUEUED','RUNNING','QA','SUCCEEDED','FAILED','CANCELLED') NOT NULL,
  `rendererVideoId` VARCHAR(255) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `durationSeconds` DECIMAL(12,3) NULL,
  `width` INTEGER NULL,
  `height` INTEGER NULL,
  `hasAudio` BOOLEAN NULL,
  `localFile` VARCHAR(2048) NULL,
  `error` TEXT NULL,
  `raw` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `render_attempts_workerId_idx` (`workerId`),
  UNIQUE INDEX `render_attempts_videoId_attempt_key` (`videoId`, `attempt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `qa_results` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `attempt` INTEGER NOT NULL DEFAULT 1,
  `passed` BOOLEAN NULL,
  `durationPassed` BOOLEAN NULL,
  `resolutionPassed` BOOLEAN NULL,
  `audioPassed` BOOLEAN NULL,
  `captionsPassed` BOOLEAN NULL,
  `raw` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `qa_results_videoId_attempt_key` (`videoId`, `attempt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `integration_accounts` (
  `id` VARCHAR(36) NOT NULL,
  `provider` VARCHAR(64) NOT NULL,
  `accountId` VARCHAR(255) NOT NULL,
  `displayName` VARCHAR(255) NULL,
  `encryptedAccessToken` LONGTEXT NULL,
  `encryptedRefreshToken` LONGTEXT NULL,
  `expiresAt` DATETIME(3) NULL,
  `scopes` JSON NULL,
  `status` VARCHAR(64) NOT NULL,
  `lastRefreshAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `integration_accounts_provider_accountId_key` (`provider`, `accountId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `audit_logs` (
  `id` VARCHAR(36) NOT NULL,
  `actorType` ENUM('ADMIN','WORKER','SYSTEM') NOT NULL,
  `actor` VARCHAR(255) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(191) NOT NULL,
  `entityId` VARCHAR(191) NULL,
  `requestId` VARCHAR(64) NULL,
  `beforeData` JSON NULL,
  `afterData` JSON NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `audit_logs_entityType_entityId_createdAt_idx` (`entityType`, `entityId`, `createdAt`),
  INDEX `audit_logs_actor_createdAt_idx` (`actor`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `job_events` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `type` VARCHAR(191) NOT NULL,
  `fromStatus` VARCHAR(64) NULL,
  `toStatus` VARCHAR(64) NULL,
  `workerId` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NULL,
  `payload` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `job_events_idempotencyKey_key` (`idempotencyKey`),
  INDEX `job_events_videoId_createdAt_idx` (`videoId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `legacy_imports` (
  `id` VARCHAR(36) NOT NULL,
  `videoId` VARCHAR(191) NOT NULL,
  `basePath` VARCHAR(768) NOT NULL,
  `baseHash` VARCHAR(64) NOT NULL,
  `v3Path` VARCHAR(768) NULL,
  `v3Hash` VARCHAR(64) NULL,
  `v4Path` VARCHAR(768) NULL,
  `v4Hash` VARCHAR(64) NULL,
  `dashboardPath` VARCHAR(768) NULL,
  `dashboardHash` VARCHAR(64) NULL,
  `effectiveHash` VARCHAR(64) NOT NULL,
  `baseJson` JSON NOT NULL,
  `v3Json` JSON NULL,
  `v4Json` JSON NULL,
  `dashboardJson` JSON NULL,
  `effectiveJson` JSON NOT NULL,
  `importedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `legacy_imports_videoId_key` (`videoId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `idempotency_keys` (
  `id` VARCHAR(36) NOT NULL,
  `scope` VARCHAR(191) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `result` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NULL,
  UNIQUE INDEX `idempotency_keys_scope_key_key` (`scope`, `key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `scheduler_leases` (
  `name` VARCHAR(191) NOT NULL,
  `owner` VARCHAR(191) NOT NULL,
  `leaseExpiresAt` DATETIME(3) NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `profiles` ADD CONSTRAINT `profiles_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `channels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `videos` ADD CONSTRAINT `videos_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `channels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `video_scenes` ADD CONSTRAINT `video_scenes_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `video_assets` ADD CONSTRAINT `video_assets_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `publications` ADD CONSTRAINT `publications_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `publication_metrics` ADD CONSTRAINT `publication_metrics_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `metric_snapshots` ADD CONSTRAINT `metric_snapshots_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `worker_leases` ADD CONSTRAINT `worker_leases_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `worker_leases` ADD CONSTRAINT `worker_leases_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `render_attempts` ADD CONSTRAINT `render_attempts_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `render_attempts` ADD CONSTRAINT `render_attempts_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `qa_results` ADD CONSTRAINT `qa_results_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `job_events` ADD CONSTRAINT `job_events_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `legacy_imports` ADD CONSTRAINT `legacy_imports_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
