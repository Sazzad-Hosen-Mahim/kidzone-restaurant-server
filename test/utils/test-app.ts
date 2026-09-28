import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { AppConfigService } from '@config/app-config.service';
import { PrismaService } from '@/prisma/prisma.service';
import { SettingsService } from '@modules/settings/settings.service';
import { configureApp } from '@/bootstrap';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  config: AppConfigService;
  close: () => Promise<void>;
}

/**
 * Boots the real application for e2e tests, with the same pipes, filters and
 * interceptors as production. Rate limiting is stubbed out so a suite that
 * hammers `/auth/login` is not throttled by the global limiter — the dedicated
 * throttling test re-enables it explicitly.
 */
export async function createTestApp(options: { throttle?: boolean } = {}): Promise<TestContext> {
  // Switches off both the global limiter and the per-route login limiter via
  // the throttler's own skipIf hook. Overriding the guard classes is not
  // enough: `@UseGuards(LoginThrottlerGuard)` resolves from the throttler
  // module's injector, not the testing module's.
  process.env.THROTTLE_ENABLED = options.throttle ? 'true' : 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  const config = app.get(AppConfigService);
  configureApp(app, config);
  await app.init();

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    config,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Truncates every table and puts the settings back to their defaults.
 *
 * The reset has to go through the app, not just the database: SettingsService
 * caches for a few seconds, so a test that changed VAT would otherwise leak
 * that rate into the next test through the cache even though the row is gone.
 */
export async function resetDatabase(ctx: TestContext | PrismaService): Promise<void> {
  const prisma = ctx instanceof PrismaService ? ctx : ctx.prisma;
  await prisma.truncateAll();

  if (!(ctx instanceof PrismaService)) {
    const settings = ctx.app.get(SettingsService);
    settings.invalidate();
    await settings.ensureDefaults();
  }
}
