import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfigService } from '@config/app-config.service';
import { AllExceptionsFilter } from '@common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '@common/interceptors/response.interceptor';

/**
 * Everything that has to be applied to the Nest application before it listens.
 * Shared by `main.ts` and the e2e harness so tests exercise the same pipeline
 * (validation, envelope, exception filter, cookies) as production.
 */
export function configureApp(app: INestApplication, config: AppConfigService): void {
  app.use(cookieParser());

  app.use(
    helmet({
      // The Swagger UI loads its own inline bootstrap script.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  const allowList = config.corsOrigins;
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Same-origin and server-to-server calls arrive without an Origin header.
      // A disallowed origin simply gets no CORS headers, which the browser then
      // blocks — cleaner than throwing, which would surface as a 500.
      callback(null, !origin || allowList.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400,
  });

  app.setGlobalPrefix(config.get('API_PREFIX'), {
    exclude: ['health', 'api/docs', 'api/docs-json'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  app.enableShutdownHooks();

  // Trust the reverse proxy so req.ip and throttling see the real client.
  const instance = app.getHttpAdapter().getInstance() as { set?: (key: string, value: unknown) => void };
  instance.set?.('trust proxy', 1);

  if (!config.isTest) {
    Logger.log(`CORS allow-list: ${allowList.join(', ') || '(none)'}`, 'Bootstrap');
  }
}
