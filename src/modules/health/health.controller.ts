import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@common/decorators/public.decorator';
import { RawResponse } from '@common/decorators/raw-response.decorator';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @Public()
  @RawResponse()
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness and readiness probe',
    description:
      'Checks PostgreSQL and Redis. Returns 200 when both respond, 503 otherwise. Unauthenticated, and returned outside the `{ data, meta }` envelope in the standard Terminus shape.',
  })
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.prisma.isHealthy('database'), () => this.redis.isHealthy('redis')]);
  }
}
