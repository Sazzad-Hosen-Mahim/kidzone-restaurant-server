import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from './env.schema';

/**
 * Typed accessor over the validated environment. Everything else in the app
 * reads configuration through this service rather than touching `process.env`,
 * which keeps the env surface discoverable and the types honest.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  get<K extends keyof AppEnv>(key: K): AppEnv[K] {
    return this.config.get(key, { infer: true }) as AppEnv[K];
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }

  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS');
  }

  get redisConnection(): { host: string; port: number; password?: string; db: number } {
    const password = this.get('REDIS_PASSWORD');
    return {
      host: this.get('REDIS_HOST'),
      port: this.get('REDIS_PORT'),
      ...(password ? { password } : {}),
      db: this.get('REDIS_DB'),
    };
  }
}
