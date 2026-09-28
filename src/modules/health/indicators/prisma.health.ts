import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return check.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error) {
      return check.down({ message: error instanceof Error ? error.message : 'unreachable' });
    }
  }
}
