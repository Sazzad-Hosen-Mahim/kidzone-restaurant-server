import { Injectable } from '@nestjs/common';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * PDF rendering.
 *
 * Uses pdfmake's server printer with the PDF standard-14 fonts (Helvetica and
 * friends), which pdfkit embeds by name rather than from a file. That keeps the
 * image free of font assets and licensing questions.
 *
 * The trade-off is that the standard fonts have no Bengali glyphs, so receipts
 * render Latin text and the currency as `BDT`/`Tk` rather than `৳`. Dropping a
 * Unicode TTF into `assets/fonts` and registering it below is all that is
 * needed to change that.
 */

const STANDARD_FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
  Courier: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italics: 'Courier-Oblique',
    bolditalics: 'Courier-BoldOblique',
  },
};

/** 80mm thermal paper: 226.77pt wide, with a small margin each side. */
export const THERMAL_WIDTH_PT = 226.77;

@Injectable()
export class PdfService {
  private readonly printer = new PdfPrinter(STANDARD_FONTS);

  /** Renders a document definition to a Buffer. */
  render(definition: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = this.printer.createPdfKitDocument({
          defaultStyle: { font: 'Helvetica', fontSize: 9 },
          ...definition,
        });

        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * A document sized for an 80mm thermal printer: continuous roll, so the page
   * height is left to grow with the content.
   */
  thermal(content: Content[], options: { title?: string } = {}): TDocumentDefinitions {
    return {
      pageSize: { width: THERMAL_WIDTH_PT, height: 'auto' as unknown as number },
      pageMargins: [8, 10, 8, 10],
      info: { title: options.title ?? 'Receipt' },
      defaultStyle: { font: 'Helvetica', fontSize: 8, lineHeight: 1.15 },
      content,
      styles: THERMAL_STYLES,
    };
  }

  /** A clean A4 report with a business header on every page. */
  a4(
    content: Content[],
    header: { businessName: string; reportName: string; range: string },
    options: { landscape?: boolean } = {},
  ): TDocumentDefinitions {
    return {
      pageSize: 'A4',
      pageOrientation: options.landscape ? 'landscape' : 'portrait',
      pageMargins: [36, 78, 36, 44],
      info: { title: `${header.reportName} ${header.range}` },
      defaultStyle: { font: 'Helvetica', fontSize: 9 },
      header: () => ({
        margin: [36, 24, 36, 0],
        stack: [
          { text: header.businessName, style: 'reportBusiness' },
          { text: header.reportName, style: 'reportTitle' },
          { text: header.range, style: 'reportRange' },
        ],
      }),
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 8, 36, 0],
        columns: [
          { text: `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, style: 'reportFooter' },
          { text: `Page ${currentPage} of ${pageCount}`, style: 'reportFooter', alignment: 'right' },
        ],
      }),
      content,
      styles: REPORT_STYLES,
    };
  }
}

const THERMAL_STYLES = {
  businessName: { fontSize: 12, bold: true, alignment: 'center' as const },
  businessLine: { fontSize: 7, alignment: 'center' as const, color: '#333333' },
  docTitle: { fontSize: 9, bold: true, alignment: 'center' as const, margin: [0, 4, 0, 2] as [number, number, number, number] },
  meta: { fontSize: 7 },
  itemHeader: { fontSize: 7, bold: true },
  item: { fontSize: 8 },
  itemNote: { fontSize: 6, italics: true, color: '#555555' },
  total: { fontSize: 10, bold: true },
  footer: { fontSize: 7, alignment: 'center' as const, color: '#333333' },
  voidStamp: {
    fontSize: 20,
    bold: true,
    color: '#b00020',
    alignment: 'center' as const,
    margin: [0, 4, 0, 4] as [number, number, number, number],
  },
};

const REPORT_STYLES = {
  reportBusiness: { fontSize: 14, bold: true },
  reportTitle: { fontSize: 11, bold: true, color: '#333333' },
  reportRange: { fontSize: 8, color: '#666666' },
  reportFooter: { fontSize: 7, color: '#888888' },
  sectionTitle: { fontSize: 11, bold: true, margin: [0, 12, 0, 6] as [number, number, number, number] },
  tableHeader: { bold: true, fontSize: 9, fillColor: '#f0f0f0' },
  metricLabel: { fontSize: 8, color: '#666666' },
  metricValue: { fontSize: 13, bold: true },
  positive: { color: '#1b7f3b' },
  negative: { color: '#b00020' },
};
