import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ColumnMappingEntry, EnrollStatus, ImportSummary, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JobContext } from '../../queue/job.service';
import { mappingToDict } from './column-matcher';
import { cellStr, parseWorkbook } from './sheet-parser';
import { aesEncrypt } from '../../common/utils/crypto';
import { initialPassword } from '../users/users.module';

/** 学生信息导入：25级学生信息(1).xlsx 等 65 列教务导出格式 */
@Injectable()
export class StudentsImportService {
  constructor(private prisma: PrismaService) {}

  async run(buffer: Buffer, mapping: ColumnMappingEntry[], ctx: JobContext): Promise<ImportSummary> {
    const dict = mappingToDict(mapping);
    const parsed = parseWorkbook(buffer);
    const summary: ImportSummary = { total: 0, inserted: 0, updated: 0, skipped: 0, skippedRows: [], issues: [] };

    // 预取班级缓存
    const classCache = new Map<string, string>(); // className -> clazzId
    let suspends = 0;

    for (const row of parsed.rows) {
      const rowNo = row.__rowNo as number;
      const studentNo = cellStr(dict.studentNo ? row[dict.studentNo] : '');
      const name = cellStr(dict.name ? row[dict.name] : '');
      const className = cellStr(dict.className ? row[dict.className] : '');
      if (!studentNo || !name) {
        summary.skipped++;
        summary.skippedRows.push({ row: rowNo, reason: '学号或姓名为空' });
        continue;
      }
      if (!/^\d{6,12}$/.test(studentNo)) {
        summary.skipped++;
        summary.skippedRows.push({ row: rowNo, reason: `学号格式异常：${studentNo}` });
        continue;
      }
      summary.total++;

      const gender = cellStr(dict.gender ? row[dict.gender] : '');
      const college = cellStr(dict.college ? row[dict.college] : '');
      const major = cellStr(dict.major ? row[dict.major] : '');
      const enrollRaw = cellStr(dict.enrollStatusRaw ? row[dict.enrollStatusRaw] : '');
      const idCard = cellStr(dict.idCard ? row[dict.idCard] : '');
      const gradeNum = Number(cellStr(dict.grade ? row[dict.grade] : ''));

      // 年级推断：入学年份列 → 班级名中的 2025级 → 学号前4位兜底
      const grade = Number.isFinite(gradeNum) && gradeNum > 2000 ? gradeNum : Number(className.match(/(\d{4})级/)?.[1] ?? Number(studentNo.slice(0, 4)));
      if (!Number.isFinite(grade) || grade < 2000) {
        summary.skipped++;
        summary.skippedRows.push({ row: rowNo, reason: '无法推断入学年份' });
        continue;
      }

      // 班级自动创建
      let classId = classCache.get(className);
      if (!classId) {
        const clazz = await this.prisma.clazz.upsert({
          where: { name: className },
          update: { grade, major: major || undefined },
          create: { name: className, grade, major: major || '' },
        });
        classId = clazz.id;
        classCache.set(className, classId);
      }

      // 学籍状态映射：默认 NORMAL；休学/无学籍 → SUSPENDED（进入异常面板可人工纳入）
      let enrollStatus = EnrollStatus.NORMAL;
      if (enrollRaw.includes('休学')) enrollStatus = EnrollStatus.SUSPENDED;
      else if (enrollRaw.includes('退学')) enrollStatus = EnrollStatus.WITHDRAWN;
      else if (enrollRaw === '无学籍') enrollStatus = EnrollStatus.SUSPENDED;
      if (enrollStatus !== EnrollStatus.NORMAL) suspends++;

      const existing = await this.prisma.student.findUnique({ where: { studentNo }, include: { user: true } });

      if (existing) {
        await this.prisma.student.update({
          where: { studentNo },
          data: {
            name, gender: gender || undefined, college, major, classId, className, grade,
            enrollStatus, enrollRaw: enrollRaw || undefined,
            idCardEnc: idCard ? aesEncrypt(idCard) : undefined,
          },
        });
        // 班级变动时同步用户的 classId 语境（JWT 里的 classId 实时从 student 取）
        summary.updated++;
      } else {
        // 创建登录账号：学号即账号，初始密码按规则生成，首登强制改密
        const user = await this.prisma.user.create({
          data: {
            username: studentNo,
            name,
            role: Role.STUDENT,
            passwordHash: await argon2.hash(initialPassword(studentNo)),
            mustChangePwd: true,
          },
        });
        await this.prisma.student.create({
          data: {
            studentNo, name, gender: gender || undefined, college, major, classId, className, grade,
            enrollStatus, enrollRaw: enrollRaw || undefined,
            idCardEnc: idCard ? aesEncrypt(idCard) : undefined,
            userId: user.id,
          },
        });
        summary.inserted++;
      }

      if (summary.total % 100 === 0) {
        await ctx.setProgress((summary.total / parsed.rows.length) * 100);
      }
    }

    // 休学/无学籍学生落异常队列（供人工裁决纳入/排除）
    if (suspends > 0) {
      await this.rebuildSuspensionIssues();
      summary.issues.push({ type: 'SUSPENDED' as any, count: suspends });
    }

    return summary;
  }

  /** 重建学籍异常 issue（幂等：先清未处理的） */
  async rebuildSuspensionIssues() {
    const batches = await this.prisma.batch.findMany({ select: { id: true } });
    const abnormal = await this.prisma.student.findMany({
      where: { enrollStatus: { in: [EnrollStatus.SUSPENDED, EnrollStatus.WITHDRAWN] } },
      select: { id: true },
    });
    for (const b of batches) {
      await this.prisma.gradeIssue.deleteMany({
        where: { batchId: b.id, issueType: 'SUSPENDED', resolution: 'PENDING', resolvedBy: null },
      });
      if (abnormal.length) {
        await this.prisma.gradeIssue.createMany({
          data: abnormal.map((s) => ({ batchId: b.id, studentId: s.id, issueType: 'SUSPENDED' })),
        });
      }
    }
  }

  /** 列映射预检（dry 校验，不落库） */
  assertMapping(mapping: ColumnMappingEntry[]) {
    const dict = mappingToDict(mapping);
    if (!dict.studentNo || !dict.name || !dict.className) {
      throw new BadRequestException('学号/姓名/班级 列必须映射');
    }
    return dict;
  }
}
