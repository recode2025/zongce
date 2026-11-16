-- 独立历史奖学金来源表：本文件仅供数据库管理员审阅，不会自动执行。
-- 执行前完整备份数据库，确认当前数据库没有 HistoricalScholarshipImport 和
-- HistoricalScholarshipRecord 两张表；脚本不覆盖、不重置既有表。
-- 必须查询目标 Student.id 的类型、字符集、排序规则，并替换下文两个占位符：
-- SELECT COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Student' AND COLUMN_NAME = 'id';
-- 预期 COLUMN_TYPE 为 varchar(191)。如不是，不要执行，请先核对 Prisma schema。
-- 例如查询得到 utf8mb4 / utf8mb4_0900_ai_ci：
-- 将 {{STUDENT_ID_CHARSET}} 替换为 utf8mb4，
-- 将 {{STUDENT_ID_COLLATION}} 替换为 utf8mb4_0900_ai_ci。
-- 未替换的占位符会阻止 SQL 执行；字符集/排序规则须直接取自上述查询结果。
-- 本脚本不修改、删除现有表或正式 ScholarshipAward 数据。
-- MySQL DDL 会隐式提交；如后续 CREATE 失败，先检查已创建的表及原因，
-- 不要盲目重跑或删除数据。
CREATE TABLE `HistoricalScholarshipImport` (
  `id` VARCHAR(191) NOT NULL,
  `academicYear` VARCHAR(16) NOT NULL,
  `fileHash` VARCHAR(64) NOT NULL,
  `sourceFileName` VARCHAR(255) NOT NULL,
  `operatorId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `HistoricalScholarshipImport_academicYear_key`(`academicYear`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `HistoricalScholarshipRecord` (
  `id` VARCHAR(191) NOT NULL,
  `importId` VARCHAR(191) NOT NULL,
  `academicYear` VARCHAR(16) NOT NULL,
  `studentId` VARCHAR(191) CHARACTER SET {{STUDENT_ID_CHARSET}} COLLATE {{STUDENT_ID_COLLATION}} NOT NULL,
  `studentNo` VARCHAR(32) NOT NULL,
  `sourceName` VARCHAR(64) NOT NULL,
  `rawAward` VARCHAR(128) NULL,
  `projectName` VARCHAR(128) NULL,
  `note` TEXT NULL,
  `isPending` BOOLEAN NOT NULL DEFAULT false,
  `sourceSheet` VARCHAR(128) NOT NULL,
  `sourceRow` INTEGER NOT NULL,
  `sourceFileName` VARCHAR(255) NOT NULL,
  `fileHash` VARCHAR(64) NOT NULL,
  `sourceRecordHash` VARCHAR(64) NOT NULL,
  `operatorId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `HistoricalScholarshipRecord_sourceRecordHash_key`(`sourceRecordHash`),
  INDEX `HistoricalScholarshipRecord_academicYear_studentId_idx`(`academicYear`, `studentId`),
  INDEX `HistoricalScholarshipRecord_academicYear_isPending_idx`(`academicYear`, `isPending`),
  INDEX `HistoricalScholarshipRecord_importId_idx`(`importId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `HistoricalScholarshipRecord_studentId_fkey`
    FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `HistoricalScholarshipRecord_importId_fkey`
    FOREIGN KEY (`importId`) REFERENCES `HistoricalScholarshipImport`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
