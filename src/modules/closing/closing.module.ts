import { Global, Module } from '@nestjs/common';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';
import { DayLockService } from './day-lock.service';

/**
 * Global because `DayLockService` is consulted by every write that carries a
 * business date: once a section's day is closed, nothing may change it.
 */
@Global()
@Module({
  controllers: [ClosingController],
  providers: [ClosingService, DayLockService],
  exports: [ClosingService, DayLockService],
})
export class ClosingModule {}
