import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { ExcelService } from './excel.service';

/** Global: receipts, closing and every report endpoint render files. */
@Global()
@Module({
  providers: [PdfService, ExcelService],
  exports: [PdfService, ExcelService],
})
export class ExportsModule {}
