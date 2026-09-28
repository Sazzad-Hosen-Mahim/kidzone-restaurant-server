import { Module } from '@nestjs/common';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';
import { ReceiptPdfBuilder } from './receipt-pdf.builder';

@Module({
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptPdfBuilder],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
