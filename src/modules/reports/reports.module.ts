import { Module } from '@nestjs/common';
import { KidZoneReportsController } from './kidzone-reports.controller';
import { RestaurantReportsController } from './restaurant-reports.controller';
import { SharedReportsController } from './shared-reports.controller';
import { KidZoneReportsService } from './kidzone-reports.service';
import { RestaurantReportsService } from './restaurant-reports.service';
import { SharedReportsService } from './shared-reports.service';
import { ReportsAccessService } from './reports-access.service';
import { ReportExportService } from './report-export.service';

@Module({
  controllers: [KidZoneReportsController, RestaurantReportsController, SharedReportsController],
  providers: [
    KidZoneReportsService,
    RestaurantReportsService,
    SharedReportsService,
    ReportsAccessService,
    ReportExportService,
  ],
  exports: [KidZoneReportsService, RestaurantReportsService, SharedReportsService],
})
export class ReportsModule {}
