import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';

export type AuditAction =
  | 'LOGIN' | 'LOGIN_FAIL' | 'LOGOUT' | 'CHANGE_PWD'
  | 'IMPORT' | 'GRADE_RESOLVE'
  | 'FIRST_REVIEW' | 'REVIEW' | 'SUBMIT_APP' | 'PACKAGE_SUBMIT'
  | 'RULE_UPDATE' | 'WHITELIST_UPDATE' | 'BATCH_TRANSITION' | 'BATCH_CREATE'
  | 'CALC_RUN' | 'PUBLISH' | 'OBJECTION_SUBMIT' | 'OBJECTION_HANDLE'
  | 'EXPORT' | 'USER_UPDATE' | 'STUDENT_UPDATE' | 'FILE_UPLOAD';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** 审计日志：只追加；detail 入库前应已完成脱敏 */
  async log(opts: {
    operatorId?: string;
    operatorName?: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    detail?: Record<string, unknown>;
    ip?: string;
    ua?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          operatorId: opts.operatorId,
          operatorName: (opts.operatorName ?? '').slice(0, 64),
          action: opts.action,
          resourceType: opts.resourceType,
          resourceId: opts.resourceId,
          detail: (opts.detail ?? {}) as object,
          ip: (opts.ip ?? '').slice(0, 64),
          ua: (opts.ua ?? '').slice(0, 255),
        },
      });
    } catch {
      // 审计失败不阻断业务，但生产应配监控告警
    }
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
