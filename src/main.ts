import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from '@config/app-config.service';
import { configureApp } from './bootstrap';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);

  configureApp(app, config);
  setupSwagger(app, config);

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://localhost:${port}/${config.get('API_PREFIX')}`);
  logger.log(`Swagger UI at    http://localhost:${port}/api/docs`);
  logger.log(`Business timezone ${config.get('BUSINESS_TIMEZONE')}, day starts at ${config.get('BUSINESS_DAY_START_HOUR')}:00`);
}

void bootstrap();
