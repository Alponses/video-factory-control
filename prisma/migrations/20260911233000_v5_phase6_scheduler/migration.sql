-- Video Factory V5 Phase 6: schedule lifecycle and durable publication dispatch queue.
-- Extends Phase 5. Older migrations remain immutable.

ALTER TABLE `schedules`
  MODIFY COLUMN `status` ENUM('SCHEDULED','DISPATCHED','CANCELLED','SUPERSEDED') NOT NULL DEFAULT 'SCHEDULED';

DROP INDEX `schedules_scheduledAt_status_idx` ON `schedules`;
CREATE INDEX `schedules_status_scheduledAt_idx` ON `schedules`(`status`, `scheduledAt`);
CREATE INDEX `schedules_publicationId_status_idx` ON `schedules`(`publicationId`, `status`);

CREATE TABLE `publication_dispatches` (
  `id` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `scheduleId` VARCHAR(36) NOT NULL,
  `assetId` VARCHAR(36) NOT NULL,
  `status` ENUM('PENDING','CLAIMED','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `notBefore` DATETIME(3) NOT NULL,
  `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `lastError` TEXT NULL,
  `claimedAt` DATETIME(3) NULL,
  `claimExpiresAt` DATETIME(3) NULL,
  `claimedBy` VARCHAR(191) NULL,
  `payloadSnapshot` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `publication_dispatches_scheduleId_key` (`scheduleId`),
  INDEX `publication_dispatches_status_notBefore_idx` (`status`, `notBefore`),
  INDEX `publication_dispatches_publicationId_createdAt_idx` (`publicationId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `publication_events` (
  `id` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `type` VARCHAR(191) NOT NULL,
  `fromStatus` VARCHAR(64) NULL,
  `toStatus` VARCHAR(64) NULL,
  `dispatchId` VARCHAR(36) NULL,
  `payload` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `publication_events_publicationId_createdAt_idx` (`publicationId`, `createdAt`),
  INDEX `publication_events_dispatchId_idx` (`dispatchId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `publication_dispatches`
  ADD CONSTRAINT `publication_dispatches_publicationId_fkey`
  FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `publication_dispatches_scheduleId_fkey`
  FOREIGN KEY (`scheduleId`) REFERENCES `schedules`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `publication_dispatches_assetId_fkey`
  FOREIGN KEY (`assetId`) REFERENCES `video_assets`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `publication_events`
  ADD CONSTRAINT `publication_events_publicationId_fkey`
  FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `publication_events_dispatchId_fkey`
  FOREIGN KEY (`dispatchId`) REFERENCES `publication_dispatches`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
