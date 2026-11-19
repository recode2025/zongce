-- 在部署新版后端前，对现有 MySQL 业务库执行一次。
CREATE TABLE `CasLoginState` (
  `state` VARCHAR(64) NOT NULL,
  `browserSecretHash` CHAR(64) NOT NULL,
  `ru` TEXT NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`state`),
  INDEX `CasLoginState_expiresAt_idx` (`expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
