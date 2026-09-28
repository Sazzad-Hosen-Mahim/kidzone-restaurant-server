import { Injectable } from '@nestjs/common';
import type { Content } from 'pdfmake/interfaces';
import { PdfService, THERMAL_WIDTH_PT } from '@modules/exports/pdf.service';
import { poishaToTakaString } from '@common/utils/money.util';
import { ReceiptDocument } from './receipts.service';

const CONTENT_WIDTH = THERMAL_WIDTH_PT - 16;

/**
 * Lays a receipt document out for an 80mm thermal printer.
 *
 * Narrow-paper conventions: a centred business header, a dashed rule instead of
 * a box border, item names on their own line above the quantity/price row so a
 * long dish name is readable, and totals right-aligned.
 */
@Injectable()
export class ReceiptPdfBuilder {
  constructor(private readonly pdf: PdfService) {}

  render(receipt: ReceiptDocument): Promise<Buffer> {
    const content: Content[] = [
      ...this.header(receipt),
      ...(receipt.voided.isVoided ? this.voidStamp(receipt) : []),
      ...this.meta(receipt),
      divider(),
      ...(receipt.kind === 'GATEPASS' ? this.gatepassBody(receipt) : this.itemsBody(receipt)),
      divider(),
      ...this.totals(receipt),
      ...(receipt.payments.length > 0 ? this.payments(receipt) : []),
      divider(),
      ...this.footer(receipt),
    ];

    return this.pdf.render(this.pdf.thermal(content, { title: `${receipt.receiptNo}` }));
  }

  private header(receipt: ReceiptDocument): Content[] {
    return [
      { text: receipt.business.name, style: 'businessName' },
      ...(receipt.business.address ? [{ text: receipt.business.address, style: 'businessLine' } as Content] : []),
      ...(receipt.business.phone ? [{ text: receipt.business.phone, style: 'businessLine' } as Content] : []),
      { text: titleFor(receipt.kind), style: 'docTitle' },
    ];
  }

  /**
   * Reprinting a voided sale must be unmistakable at a glance, so the stamp
   * goes above the items rather than in a corner.
   */
  private voidStamp(receipt: ReceiptDocument): Content[] {
    return [
      { text: '*** VOID ***', style: 'voidStamp' },
      ...(receipt.voided.reason
        ? [{ text: `Reason: ${receipt.voided.reason}`, style: 'meta', alignment: 'center' } as Content]
        : []),
      ...(receipt.voided.voidedAt
        ? [{ text: `Voided ${receipt.voided.voidedAt}`, style: 'meta', alignment: 'center' } as Content]
        : []),
      { text: 'This receipt is not valid.', style: 'meta', alignment: 'center', margin: [0, 0, 0, 4] },
    ];
  }

  private meta(receipt: ReceiptDocument): Content[] {
    const rows: Array<[string, string]> = [
      [receipt.kind === 'GATEPASS' ? 'Gatepass' : 'Receipt', receipt.receiptNo],
      ['Date', receipt.issuedAt],
    ];
    if (receipt.tableNo) rows.push(['Table', receipt.tableNo]);
    if (receipt.customer) {
      rows.push(['Customer', receipt.customer.name]);
      rows.push(['Phone', receipt.customer.phone]);
    }
    rows.push(['Served by', receipt.servedBy]);

    return [
      {
        margin: [0, 2, 0, 2],
        table: {
          widths: ['auto', '*'],
          body: rows.map(([label, value]) => [
            { text: `${label}:`, style: 'meta' },
            { text: value, style: 'meta', alignment: 'right' },
          ]),
        },
        layout: 'noBorders',
      },
    ];
  }

  private itemsBody(receipt: ReceiptDocument): Content[] {
    const body: Content[] = [];

    for (const line of receipt.lines) {
      body.push({ text: line.name, style: 'item' });
      body.push({
        table: {
          widths: ['auto', '*', 'auto'],
          body: [
            [
              { text: `${line.quantity} x`, style: 'itemHeader' },
              { text: poishaToTakaString(line.unitPrice), style: 'item' },
              { text: poishaToTakaString(line.lineTotal), style: 'item', alignment: 'right' },
            ],
          ],
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 1],
      });
      if (line.note) body.push({ text: line.note, style: 'itemNote', margin: [0, 0, 0, 2] });
    }

    return body;
  }

  private gatepassBody(receipt: ReceiptDocument): Content[] {
    const gatepass = receipt.gatepass!;

    const rows: Array<[string, string]> = [
      ['Child', gatepass.childName],
      ['Plan', gatepass.planName],
      ['Checked in', gatepass.checkInAt],
    ];
    if (gatepass.expectedCheckOutAt) rows.push(['Due out', gatepass.expectedCheckOutAt]);
    if (gatepass.checkOutAt) rows.push(['Checked out', gatepass.checkOutAt]);
    rows.push(['Status', gatepass.status]);

    return [
      {
        table: {
          widths: ['auto', '*'],
          body: rows.map(([label, value]) => [
            { text: `${label}:`, style: 'meta' },
            { text: value, style: 'item', alignment: 'right' },
          ]),
        },
        layout: 'noBorders',
      },
      { text: gatepass.qrPayload, style: 'docTitle', margin: [0, 6, 0, 0] },
      {
        text: 'Present this pass to collect your child.',
        style: 'footer',
        margin: [0, 0, 0, 4],
      },
    ];
  }

  private totals(receipt: ReceiptDocument): Content[] {
    const rows: Array<[string, string, boolean]> = [];
    const t = receipt.totals;

    if (receipt.kind !== 'GATEPASS') {
      rows.push(['Subtotal', poishaToTakaString(t.subtotal), false]);
      if (t.discountAmount > 0) rows.push(['Discount', `-${poishaToTakaString(t.discountAmount)}`, false]);
      if (t.serviceChargeAmount !== undefined && t.serviceChargeAmount > 0) {
        rows.push([`Service charge (${t.serviceChargePercent}%)`, poishaToTakaString(t.serviceChargeAmount), false]);
      }
      if (t.vatAmount !== undefined && t.vatAmount > 0) {
        rows.push([`VAT (${t.vatPercent}%)`, poishaToTakaString(t.vatAmount), false]);
      }
    } else if (t.totalAmount > 0) {
      rows.push(['Overtime charge', poishaToTakaString(t.totalAmount), false]);
    }

    rows.push(['TOTAL (BDT)', poishaToTakaString(t.totalAmount), true]);

    return [
      {
        margin: [0, 2, 0, 2],
        table: {
          widths: ['*', 'auto'],
          body: rows.map(([label, value, strong]) => [
            { text: label, style: strong ? 'total' : 'meta' },
            { text: value, style: strong ? 'total' : 'meta', alignment: 'right' },
          ]),
        },
        layout: 'noBorders',
      },
      ...(t.discountReason
        ? [{ text: `Discount: ${t.discountReason}`, style: 'itemNote' } as Content]
        : []),
    ];
  }

  private payments(receipt: ReceiptDocument): Content[] {
    return [
      { text: 'Paid by', style: 'itemHeader', margin: [0, 2, 0, 1] },
      {
        table: {
          widths: ['*', 'auto'],
          body: receipt.payments.map((payment) => [
            {
              text: payment.reference ? `${payment.method} (${payment.reference})` : payment.method,
              style: 'meta',
            },
            { text: poishaToTakaString(payment.amount), style: 'meta', alignment: 'right' },
          ]),
        },
        layout: 'noBorders',
      },
    ];
  }

  private footer(receipt: ReceiptDocument): Content[] {
    return [
      ...(receipt.voided.isVoided ? [{ text: '*** VOID ***', style: 'voidStamp' } as Content] : []),
      { text: receipt.business.footer, style: 'footer' },
      { text: receipt.receiptNo, style: 'footer', margin: [0, 2, 0, 0] },
    ];
  }
}

/** A dashed rule drawn as a zero-height line, which thermal printers handle well. */
function divider(): Content {
  return {
    margin: [0, 3, 0, 3],
    canvas: [
      {
        type: 'line',
        x1: 0,
        y1: 0,
        x2: CONTENT_WIDTH,
        y2: 0,
        lineWidth: 0.5,
        dash: { length: 2, space: 2 },
        lineColor: '#666666',
      },
    ],
  };
}

function titleFor(kind: ReceiptDocument['kind']): string {
  switch (kind) {
    case 'KIDZONE_SALE':
      return 'KID ZONE RECEIPT';
    case 'RESTAURANT_ORDER':
      return 'RESTAURANT RECEIPT';
    case 'GATEPASS':
      return 'GATEPASS';
  }
}
