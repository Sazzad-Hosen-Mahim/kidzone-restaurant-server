import { Controller, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '@common/decorators/roles.decorator';
import { RawResponse } from '@common/decorators/raw-response.decorator';
import { ReceiptDocument, ReceiptsService } from './receipts.service';
import { ReceiptPdfBuilder } from './receipt-pdf.builder';

const ALL_STAFF = [Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER] as const;
const KIDZONE_STAFF = [Role.ADMIN, Role.KIDZONE_MANAGER] as const;
const RESTAURANT_STAFF = [Role.ADMIN, Role.RESTAURANT_CASHIER] as const;

const FORMAT_QUERY = {
  name: 'format',
  required: false,
  enum: ['json', 'pdf'],
  description: 'Omit or use `json` for the structured document; `pdf` renders an 80mm thermal-width receipt.',
} as const;

@ApiTags('Receipts')
@ApiBearerAuth('access-token')
@Controller('receipts')
export class ReceiptsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly pdf: ReceiptPdfBuilder,
  ) {}

  @Get('kidzone/:saleId')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Kid Zone sale receipt',
    description:
      'Business header, receipt number, date and time in the business timezone, the plan line, totals, payments, who served and the footer. Every figure comes from the sale’s own snapshots, so an old receipt reprints exactly. A voided sale is marked **VOID**.',
  })
  @ApiQuery(FORMAT_QUERY)
  @ApiProduces('application/json', 'application/pdf')
  @ApiOkResponse({ description: 'The receipt document, or a PDF when `format=pdf`' })
  async kidZone(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReceiptEnvelope | StreamableFile> {
    return this.deliver(await this.receipts.kidZoneSale(saleId), format, response);
  }

  @Get('restaurant/:orderId')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Restaurant order receipt',
    description:
      'Itemised lines from the order’s snapshots, with the service charge and VAT shown at the **percentages stored on the order**, not the current settings. A voided order is marked **VOID**.',
  })
  @ApiQuery(FORMAT_QUERY)
  @ApiProduces('application/json', 'application/pdf')
  async restaurant(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReceiptEnvelope | StreamableFile> {
    return this.deliver(await this.receipts.restaurantOrder(orderId), format, response);
  }

  @Get('gatepass/:visitId')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Visit gatepass',
    description: `The slip a guardian shows to collect their child: child name, plan, check-in time, expected check-out and a QR payload.

The QR payload is the **gatepass number**, never the membership QR token — a printed slip that can be dropped on the floor must not carry a credential that would let someone check a child in.`,
  })
  @ApiQuery(FORMAT_QUERY)
  @ApiProduces('application/json', 'application/pdf')
  async gatepass(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReceiptEnvelope | StreamableFile> {
    return this.deliver(await this.receipts.gatepass(visitId), format, response);
  }

  /**
   * JSON in the standard envelope, or a PDF body.
   *
   * These handlers are `@RawResponse()` because one of the two outcomes is a
   * binary body, so the envelope is applied here by hand for the JSON case
   * rather than by the global interceptor.
   */
  private async deliver(
    receipt: ReceiptDocument,
    format: string | undefined,
    response: Response,
  ): Promise<ReceiptEnvelope | StreamableFile> {
    if (format?.toLowerCase() !== 'pdf') {
      return { data: receipt, meta: { timestamp: new Date().toISOString() } };
    }

    const buffer = await this.pdf.render(receipt);
    const filename = `${receipt.receiptNo}.pdf`;

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    response.setHeader('Content-Length', buffer.length);

    return new StreamableFile(buffer);
  }
}

/** The { data, meta } envelope, applied by hand on these raw handlers. */
interface ReceiptEnvelope {
  data: ReceiptDocument;
  meta: { timestamp: string };
}

export { ALL_STAFF };
