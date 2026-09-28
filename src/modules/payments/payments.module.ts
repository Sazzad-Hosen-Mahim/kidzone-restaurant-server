import { Global, Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/** Global: both sections and the check-out flow create payments. */
@Global()
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
