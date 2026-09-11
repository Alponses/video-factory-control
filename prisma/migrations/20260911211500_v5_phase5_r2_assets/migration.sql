-- Video Factory V5 Phase 5: durable R2 assets and upload sessions.
-- This migration extends, and does not rewrite, the Phase 1 schema.

ALTER TABLE `video_assets`
  ADD COLUMN `profileId` VARCHAR(191) NULL;

CREATE INDEX `video_assets_profileId_kind_idx` ON `video_assets`(`profileId`, `kind`);
CREATE INDEX `video_assets_status_kind_idx` ON `video_assets`(`status`, `kind`);

ALTER TABLE `video_assets`
  ADD CONSTRAINT `video_assets_profileId_fkey`
  FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `asset_upload_sessions` (
  `id` VARCHAR(36) NOT NULL,
  `assetId` VARCHAR(36) NOT NULL,
  `actorType` ENUM('ADMIN', 'WORKER', 'SYSTEM') NOT NULL,
  `actor` VARCHAR(255) NOT NULL,
  `workerId` VARCHAR(191) NULL,
  `renderAttemptId` VARCHAR(36) NULL,
  `mode` ENUM('SINGLE', 'MULTIPART') NOT NULL,
  `status` ENUM('CREATED', 'UPLOADING', 'FINALIZING', 'COMPLETED', 'ABORTED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'CREATED',
  `expectedMimeType` VARCHAR(191) NOT NULL,
  `expectedSize` BIGINT NOT NULL,
  `expectedSha256` VARCHAR(64) NULL,
  `r2UploadId` TEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `completedAt` DATETIME(3) NULL,
  `failedAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `asset_upload_sessions_assetId_status_idx`(`assetId`, `status`),
  INDEX `asset_upload_sessions_workerId_status_idx`(`workerId`, `status`),
  INDEX `asset_upload_sessions_renderAttemptId_idx`(`renderAttemptId`),
  INDEX `asset_upload_sessions_expiresAt_status_idx`(`expiresAt`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `asset_upload_sessions`
  ADD CONSTRAINT `asset_upload_sessions_assetId_fkey`
  FOREIGN KEY (`assetId`) REFERENCES `video_assets`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `asset_upload_sessions_workerId_fkey`
  FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `asset_upload_sessions_renderAttemptId_fkey`
  FOREIGN KEY (`renderAttemptId`) REFERENCES `render_attempts`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
