import { Injectable, StreamableFile } from '@nestjs/common';
import type { Content, TableCell } from 'pdfmake/interfaces';
import type { Response } from 'express';
import { ExcelService, SheetSpec, WorkbookHeader, cellValue } from '@modules/exports/excel.service';
import { PdfService } from '@modules/exports/pdf.service';
import { SettingsService } from '@modules/settings/settings.service';
import { poishaToTakaString } from '@common/utils/money.util';
import { ReportPeriod } from './reports.types';

export type ExportFormat = 'json' | 'xlsx' | 'pdf';

/**
 * Turns a report into a spreadsheet or a PDF.
 *
 * Both formats are driven by the same `SheetSpec` description, so a report is
 * described once and cannot drift between its Excel and PDF renderings.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly excel: ExcelService,
    private readonly pdf: PdfService,
    private readonly settings: SettingsService,
  ) {}

  isExport(format: string | undefined): format is 'xlsx' | 'pdf' {
    return format === 'xlsx' || format === 'pdf';
  }

  /**
   * `kidzone-summary_2026-09-01_2026-09-30.xlsx`
   *
   * Dated file names matter: these end up in a downloads folder, and a dozen
   * files called `report.xlsx` are worthless a week later.
   */
  fileName(reportName: string, period: ReportPeriod, format: 'xlsx' | 'pdf'): string {
    const slug = reportName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return `${slug}_${period.from}_${period.to}.${format}`;
  }

  async header(reportName: string, period: ReportPeriod): Promise<WorkbookHeader> {
    return {
      businessName: await this.settings.get('businessName'),
      reportName,
      range: `${period.from} to ${period.to} (${period.days} day${period.days === 1 ? '' : 's'}, ${period.timezone})`,
    };
  }

  /** Writes the file to the response and returns it as a streamable body. */
  async deliver(
    response: Response,
    format: 'xlsx' | 'pdf',
    reportName: string,
    period: ReportPeriod,
    sheets: SheetSpec[],
    options: { landscape?: boolean } = {},
  ): Promise<StreamableFile> {
    const header = await this.header(reportName, period);
    const fileName = this.fileName(reportName, period, format);

    const buffer =
      format === 'xlsx'
        ? await this.excel.build(header, sheets)
        : await this.pdf.render(this.pdf.a4(this.toPdfContent(sheets), header, options));

    response.setHeader(
      'Content-Type',
      format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf',
    );
    response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    response.setHeader('Content-Length', buffer.length);

    return new StreamableFile(buffer);
  }

  /** Renders each sheet as a titled table in the A4 document. */
  private toPdfContent(sheets: SheetSpec[]): Content[] {
    const content: Content[] = [];

    for (const [index, sheet] of sheets.entries()) {
      content.push({
        text: sheet.name,
        style: 'sectionTitle',
        ...(index > 0 ? { pageBreak: 'before' as const } : {}),
      });

      if (sheet.rows.length === 0) {
        content.push({ text: 'No data for this period.', italics: true, color: '#888888' });
        continue;
      }

      const body: TableCell[][] = [
        sheet.columns.map((column) => ({
          text: column.header,
          style: 'tableHeader',
          alignment: isNumeric(column.type) ? 'right' : 'left',
        })),
      ];

      for (const row of sheet.rows) {
        body.push(
          sheet.columns.map((column) => ({
            text: formatCell(cellValue(row, column.key), column.type),
            alignment: isNumeric(column.type) ? 'right' : 'left',
          })),
        );
      }

      if (sheet.totals) {
        body.push(
          sheet.columns.map((column) => ({
            text: formatCell(cellValue(sheet.totals!, column.key), column.type),
            bold: true,
            alignment: isNumeric(column.type) ? 'right' : 'left',
          })),
        );
      }

      content.push({
        table: { headerRows: 1, widths: sheet.columns.map(() => '*'), body },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 8],
      });
    }

    return content;
  }
}

function isNumeric(type: string | undefined): boolean {
  return type === 'money' || type === 'number' || type === 'percent';
}

function formatCell(value: unknown, type: string | undefined): string {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'money':
      return poishaToTakaString(Number(value));
    case 'number':
      return Number(value).toLocaleString('en-US');
    case 'percent':
      return `${Number(value).toFixed(1)}%`;
    default:
      return String(value);
  }
}
