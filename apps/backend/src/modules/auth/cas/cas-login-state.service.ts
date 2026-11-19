import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.module';

function hashBrowserSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

@Injectable()
export class CasLoginStateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(state: string, browserSecret: string, ru: string, expiresAt: Date) {
    const states = this.prisma.casLoginState;
    await states.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await states.create({ data: { state, browserSecretHash: hashBrowserSecret(browserSecret), ru, expiresAt } });
  }

  async consume(state: string, browserSecret: string): Promise<{ ru: string } | null> {
    const states = this.prisma.casLoginState;
    const browserSecretHash = hashBrowserSecret(browserSecret);
    const pending = await states.findUnique({ where: { state, browserSecretHash }, select: { ru: true } });
    if (!pending) return null;

    // 在删除时判断有效期及是否仍未被消费，只有删到记录的请求可以继续换票。
    const deleted = await states.deleteMany({ where: { state, browserSecretHash, expiresAt: { gt: new Date() } } });
    return deleted.count === 1 ? pending : null;
  }
}
