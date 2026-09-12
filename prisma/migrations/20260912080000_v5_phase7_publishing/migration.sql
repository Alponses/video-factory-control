-- Video Factory V5 Phase 7: encrypted social integrations and durable publisher execution.
-- Extends Phase 6. Older migrations remain immutable.

ALTER TABLE `publications`
  MODIFY COLUMN `status` ENUM('DRAFT','READY','SCHEDULED','PUBLISHING','PUBLISHED','FAILED','NEEDS_ATTENTION','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN `tiktokPrivacyLevel` VARCHAR(64) NULL,
  ADD COLUMN `tiktokAllowComment` BOOLEAN NULL,
  ADD COLUMN `tiktokAllowDuet` BOOLEAN NULL,
  ADD COLUMN `tiktokAllowStitch` BOOLEAN NULL,
  ADD COLUMN `tiktokIsAigc` BOOLEAN NULL,
  ADD COLUMN `youtubePrivacyStatus` VARCHAR(32) NULL,
  ADD COLUMN `youtubeCategoryId` VARCHAR(32) NULL,
  ADD COLUMN `youtubeMadeForKids` BOOLEAN NULL,
  ADD COLUMN `youtubeContainsSyntheticMedia` BOOLEAN NULL;

ALTER TABLE `publication_dispatches`
  MODIFY COLUMN `status` ENUM('PENDING','CLAIMED','COMPLETED','FAILED','NEEDS_ATTENTION','CANCELLED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `nextAttemptAt` DATETIME(3) NULL,
  ADD COLUMN `needsAttention` BOOLEAN NOT NULL DEFAULT false;

DROP INDEX `publication_dispatches_status_notBefore_idx` ON `publication_dispatches`;
CREATE INDEX `publication_dispatches_status_nextAttemptAt_notBefore_idx`
  ON `publication_dispatches`(`status`, `nextAttemptAt`, `notBefore`);

ALTER TABLE `integration_accounts`
  ADD COLUMN `profileId` VARCHAR(191) NULL,
  ADD COLUMN `refreshExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `readiness` VARCHAR(64) NULL,
  ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `refreshClaimedAt` DATETIME(3) NULL,
  ADD COLUMN `refreshClaimExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `refreshClaimedBy` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `integration_accounts_profileId_key` ON `integration_accounts`(`profileId`);
CREATE INDEX `integration_accounts_provider_status_idx` ON `integration_accounts`(`provider`, `status`);

CREATE TABLE `oauth_transactions` (
  `id` VARCHAR(36) NOT NULL,
  `profileId` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(64) NOT NULL,
  `actor` VARCHAR(255) NOT NULL,
  `stateHash` VARCHAR(64) NOT NULL,
  `redirectUri` VARCHAR(2048) NOT NULL,
  `verifierEncrypted` LONGTEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `oauth_transactions_stateHash_key` (`stateHash`),
  INDEX `oauth_transactions_provider_expiresAt_idx` (`provider`, `expiresAt`),
  INDEX `oauth_transactions_profileId_createdAt_idx` (`profileId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `publication_attempts` (
  `id` VARCHAR(36) NOT NULL,
  `dispatchId` VARCHAR(36) NOT NULL,
  `publicationId` VARCHAR(36) NOT NULL,
  `provider` ENUM('TIKTOK','YOUTUBE','FACEBOOK') NOT NULL,
  `attempt` INTEGER NOT NULL,
  `status` ENUM('RUNNING','PROCESSING','SUCCEEDED','FAILED','UNKNOWN') NOT NULL,
  `stage` ENUM('CLAIMED','TOKEN_READY','INITIALIZED','UPLOADING','PROCESSING','FINALIZING','RECONCILING','COMPLETED') NOT NULL,
  `externalOperationId` VARCHAR(512) NULL,
  `platformMediaId` VARCHAR(255) NULL,
  `recoveryStateEncrypted` LONGTEXT NULL,
  `retryable` BOOLEAN NOT NULL DEFAULT false,
  `errorCode` VARCHAR(96) NULL,
  `safeErrorMessage` TEXT NULL,
  `startedAt` DATETIME(3) NOT NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `publication_attempts_dispatchId_attempt_key` (`dispatchId`, `attempt`),
  INDEX `publication_attempts_publicationId_createdAt_idx` (`publicationId`, `createdAt`),
  INDEX `publication_attempts_status_stage_idx` (`status`, `stage`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `integration_accounts`
  ADD CONSTRAINT `integration_accounts_profileId_fkey`
  FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `oauth_transactions`
  ADD CONSTRAINT `oauth_transactions_profileId_fkey`
  FOREIGN KEY (`profileId`) REFERENCES `profiles`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `publication_attempts`
  ADD CONSTRAINT `publication_attempts_dispatchId_fkey`
  FOREIGN KEY (`dispatchId`) REFERENCES `publication_dispatches`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `publication_attempts_publicationId_fkey`
  FOREIGN KEY (`publicationId`) REFERENCES `publications`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
