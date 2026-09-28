import { Module } from '@nestjs/common';
import { CustomersModule } from '@modules/customers/customers.module';
import { ClosingModule } from '@modules/closing/closing.module';
import { SequenceService } from '@common/services/sequence.service';
import { PlansController } from './plans/plans.controller';
import { PlansService } from './plans/plans.service';
import { SalesService } from './sales/sales.service';
import { MembershipsService } from './memberships/memberships.service';
import { CheckInService } from './checkin/checkin.service';
import { OtpService } from './checkin/otp.service';
import { VisitsService } from './visits/visits.service';
import {
  CheckInController,
  KidZoneSalesController,
  MembershipsController,
  VisitsController,
} from './kidzone.controller';

@Module({
  imports: [CustomersModule, ClosingModule],
  controllers: [
    PlansController,
    KidZoneSalesController,
    MembershipsController,
    CheckInController,
    VisitsController,
  ],
  providers: [
    PlansService,
    SalesService,
    MembershipsService,
    CheckInService,
    OtpService,
    VisitsService,
    SequenceService,
  ],
  exports: [PlansService, SalesService, MembershipsService, VisitsService, OtpService],
})
export class KidZoneModule {}
