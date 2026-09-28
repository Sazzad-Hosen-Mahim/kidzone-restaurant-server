import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { poishaToTakaNumber } from '@common/utils/money.util';

/**
 * Excel export.
 *
 * Money columns are written as real numbers in **taka** with a BDT currency
 * format, not as poisha integers and not as pre-formatted strings: the whole
 * point of handing someone a spreadsheet is that they can sum and pivot the
 * figures, which requires numeric cells.
 */

export type ColumnType = 'text' | 'money' | 'number' | 'percent' | 'date';

export interface SheetColumn {
  header: string;
  key: string;
  type?: ColumnType;
  width?: number;
}

/**
 * Rows are typed as plain objects rather than `Record<string, unknown>` so a
 * report can hand over its own interfaces directly, without every result type
 * needing an index signature purely to satisfy the exporter.
 */
export type SheetRow = object;

export interface SheetSpec {
  name: string;
  columns: SheetColumn[];
  rows: readonly SheetRow[];
  /** Rendered as a bold row under the data, e.g. period totals. */
  totals?: SheetRow;
}

export function cellValue(row: SheetRow, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

export interface WorkbookHeader {
  businessName: string;
  reportName: string;
  range: string;
}

const MONEY_FORMAT = '#,##0.00';
const PERCENT_FORMAT = '0.0"%"';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };

@Injectable()
export class ExcelService {
  async build(header: WorkbookHeader, sheets: SheetSpec[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = header.businessName;
    workbook.created = new Date();

    for (const spec of sheets) {
      this.addSheet(workbook, header, spec);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private addSheet(workbook: ExcelJS.Workbook, header: WorkbookHeader, spec: SheetSpec): void {
    // Excel sheet names cannot exceed 31 characters or contain : \ / ? * [ ]
    const sheet = workbook.addWorksheet(spec.name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31));
    const lastColumn = Math.max(1, spec.columns.length);

    // Three-row title block above the table.
    sheet.mergeCells(1, 1, 1, lastColumn);
    sheet.getCell(1, 1).value = header.businessName;
    sheet.getCell(1, 1).font = { size: 14, bold: true };

    sheet.mergeCells(2, 1, 2, lastColumn);
    sheet.getCell(2, 1).value = header.reportName;
    sheet.getCell(2, 1).font = { size: 11, bold: true, color: { argb: 'FF444444' } };

    sheet.mergeCells(3, 1, 3, lastColumn);
    sheet.getCell(3, 1).value = header.range;
    sheet.getCell(3, 1).font = { size: 9, color: { argb: 'FF777777' } };

    const headerRowIndex = 5;
    const headerRow = sheet.getRow(headerRowIndex);
    spec.columns.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.header;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } };
      sheet.getColumn(index + 1).width = column.width ?? widthFor(column);
    });
    headerRow.commit();

    spec.rows.forEach((row, rowIndex) => {
      const excelRow = sheet.getRow(headerRowIndex + 1 + rowIndex);
      spec.columns.forEach((column, columnIndex) => {
        this.writeCell(excelRow.getCell(columnIndex + 1), cellValue(row, column.key), column.type);
      });
      excelRow.commit();
    });

    if (spec.totals) {
      const totalsRow = sheet.getRow(headerRowIndex + 1 + spec.rows.length);
      spec.columns.forEach((column, columnIndex) => {
        const cell = totalsRow.getCell(columnIndex + 1);
        this.writeCell(cell, cellValue(spec.totals!, column.key), column.type);
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin', color: { argb: 'FF888888' } } };
      });
      totalsRow.commit();
    }

    // Freeze the title block and the header row so scrolling keeps context.
    sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];

    if (spec.rows.length > 0) {
      sheet.autoFilter = {
        from: { row: headerRowIndex, column: 1 },
        to: { row: headerRowIndex + spec.rows.length, column: lastColumn },
      };
    }
  }

  private writeCell(cell: ExcelJS.Cell, value: unknown, type: ColumnType = 'text'): void {
    if (value === null || value === undefined) {
      cell.value = null;
      return;
    }

    switch (type) {
      case 'money':
        cell.value = poishaToTakaNumber(Number(value));
        cell.numFmt = MONEY_FORMAT;
        cell.alignment = { horizontal: 'right' };
        break;
      case 'number':
        cell.value = Number(value);
        cell.alignment = { horizontal: 'right' };
        break;
      case 'percent':
        cell.value = Number(value);
        cell.numFmt = PERCENT_FORMAT;
        cell.alignment = { horizontal: 'right' };
        break;
      case 'date':
        cell.value = String(value);
        cell.alignment = { horizontal: 'left' };
        break;
      default:
        cell.value = typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean);
    }
  }
}

function widthFor(column: SheetColumn): number {
  switch (column.type) {
    case 'money':
      return 16;
    case 'number':
    case 'percent':
      return 12;
    case 'date':
      return 13;
    default:
      return Math.max(14, Math.min(40, column.header.length + 4));
  }
}
