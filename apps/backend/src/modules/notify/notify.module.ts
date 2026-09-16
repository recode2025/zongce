import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../../common/decorators';

class AnnouncementDto {
  @IsString() title: string;
  @IsString() content: string;
  @IsOptional() batchId?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
}

@Controller()
export class NotifyController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---------- 通知 ----------

  @Get('notifications/mine')
  async myNotifications(@CurrentUser('id') userId: string, @Query('unreadOnly') unreadOnly?: string) {
    return this.prisma.notification.findMany({
      where: { userId, readAt: unreadOnly === 'true' ? null : undefined },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Patch('notifications/:id/read')
  async markRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.prisma.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
    return { success: true };
  }

  // ---------- 公告 ----------

  @Get('announcements')
  async announcements(@Query('batchId') batchId?: string) {
    return this.prisma.announcement.findMany({
      where: batchId ? { OR: [{ batchId }, { batchId: null }] } : undefined,
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
  }

  @Post('announcements')
  @Roles(Role.GRADE_ADMIN)
  async createAnnouncement(@Body() dto: AnnouncementDto, @CurrentUser('id') userId: string) {
    if (dto.title.trim().length === 0 || dto.content.trim().length === 0) throw new BadRequestException('标题和内容不能为空');
    return this.prisma.announcement.create({
      data: { title: dto.title.slice(0, 255), content: dto.content.slice(0, 10000), batchId: dto.batchId, pinned: dto.pinned ?? false, createdBy: userId },
    });
  }

  @Post('announcements/:id')
  @Roles(Role.GRADE_ADMIN)
  async deleteAnnouncement(@Param('id') id: string) {
    await this.prisma.announcement.delete({ where: { id } }).catch(() => {
      throw new ForbiddenException('公告不存在');
    });
    return { success: true };
  }
}

/** 站内通知发送（服务端内部调用） */
export async function sendNotification(prisma: PrismaService, userId: string, title: string, content = '', link?: string) {
  await prisma.notification.create({ data: { userId, title: title.slice(0, 255), content: content.slice(0, 1000), link } });
}

/** 给班级负责人批量发通知 */
export async function notifyClassLeader(prisma: PrismaService, classId: string, title: string, content = '', link?: string) {
  const leader = await prisma.clazz.findUnique({ where: { id: classId }, select: { leaderId: true } });
  if (leader?.leaderId) await sendNotification(prisma, leader.leaderId, title, content, link);
}

@Module({
  controllers: [NotifyController],
  providers: [],
})
export class NotifyModule {}
