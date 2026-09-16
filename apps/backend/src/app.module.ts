import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.service';
import { JobModule } from './queue/job.service';
import { AuditModule } from './modules/audit/audit.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { env } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BatchesModule } from './modules/batches/batches.module';
import { ImportsModule } from './modules/imports/imports.module';
import { GradesModule } from './modules/grades/grades.controller';
import { RulesModule } from './modules/rules/rules.module';
import { FilesModule } from './modules/files/files.controller';
import { ApplicationsModule } from './modules/applications/applications.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { CalcModule } from './modules/calc/calc.module';
import { PublishModule } from './modules/publish/publish.module';
import { ExportsModule } from './modules/exports/exports.module';
import { StatsModule } from './modules/stats/stats.module';
import { NotifyModule } from './modules/notify/notify.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    JobModule,
    AuditModule,
    JwtModule.register({
      global: true,
      secret: env.jwtAccessSecret,
      signOptions: { expiresIn: env.jwtAccessTtlSec },
    }),
    AuthModule,
    UsersModule,
    BatchesModule,
    ImportsModule,
    GradesModule,
    RulesModule,
    FilesModule,
    ApplicationsModule,
    ReviewsModule,
    CalcModule,
    PublishModule,
    ExportsModule,
    StatsModule,
    NotifyModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
