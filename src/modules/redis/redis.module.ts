import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { AppConfigService } from '@config/app-config.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * One shared ioredis connection for the health check and anything else that
 * needs Redis directly. BullMQ opens its own connections through @nestjs/bullmq.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis => {
        const client = new Redis({
          ...config.redisConnection,
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          retryStrategy: (times) => Math.min(times * 200, 3000),
        });
        // Without a listener ioredis escalates connection errors to unhandled
        // rejections and takes the process down when Redis restarts.
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    if (client && client.status !== 'end') {
      client.disconnect();
    }
  }
}
