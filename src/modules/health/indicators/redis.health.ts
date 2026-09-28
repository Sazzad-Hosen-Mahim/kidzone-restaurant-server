import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '@modules/redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    const startedAt = Date.now();
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await this.redis.connect();
      }
      const pong = await this.redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected PING reply "${pong}"`);
      return check.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error) {
      return check.down({ message: error instanceof Error ? error.message : 'unreachable' });
    }
  }
}
