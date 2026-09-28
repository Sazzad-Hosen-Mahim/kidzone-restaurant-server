import { ApiProperty } from '@nestjs/swagger';

/**
 * Every successful response is `{ data, meta }`. `meta` always carries the
 * request timestamp and, for list endpoints, the pagination block.
 */
export class PaginationMeta {
  @ApiProperty({ example: 1, description: '1-based page number' })
  page!: number;

  @ApiProperty({ example: 25, description: 'Rows per page (max 100)' })
  limit!: number;

  @ApiProperty({ example: 137, description: 'Total rows matching the filter' })
  total!: number;

  @ApiProperty({ example: 6, description: 'Total number of pages' })
  totalPages!: number;

  @ApiProperty({ example: true })
  hasNextPage!: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage!: boolean;
}

export class ResponseMeta extends PaginationMeta {
  @ApiProperty({ example: '2026-09-22T09:15:00.000Z' })
  timestamp!: string;
}

/**
 * Marker returned by list services. The response interceptor unwraps it into
 * `{ data: items, meta: { …pagination } }`.
 */
export class PageResult<T> {
  constructor(
    readonly items: T[],
    readonly meta: PaginationMeta,
    /** Figures over every matching row, not just this page — e.g. a money total. */
    readonly summary?: unknown,
  ) {}
}

/**
 * Money totals over a filtered list of sales or orders.
 *
 * Voided rows are counted separately rather than netted in: a void is a
 * reversal, so `totalAmount` is what was actually taken.
 */
export interface SalesSummary {
  count: number;
  totalAmount: number;
  voidedCount: number;
  voidedAmount: number;
}

/** Folds a `groupBy(status)` result into a {@link SalesSummary}. */
export function toSalesSummary(
  groups: Array<{ status: string; _count: { _all: number }; _sum: { totalAmount: number | null } }>,
  voidedStatus: string,
): SalesSummary {
  const summary: SalesSummary = { count: 0, totalAmount: 0, voidedCount: 0, voidedAmount: 0 };
  for (const group of groups) {
    const amount = group._sum.totalAmount ?? 0;
    if (group.status === voidedStatus) {
      summary.voidedCount += group._count._all;
      summary.voidedAmount += amount;
    } else {
      summary.count += group._count._all;
      summary.totalAmount += amount;
    }
  }
  return summary;
}

export function buildPagination(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && total > 0,
  };
}

export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
  summary?: unknown,
): PageResult<T> {
  return new PageResult(items, buildPagination(total, page, limit), summary);
}

/** Swagger helper: documents the `{ data, meta }` envelope around a DTO. */
export class ApiErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request', description: 'HTTP reason phrase or a stable error code' })
  error!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiProperty({
    required: false,
    description: 'Field-level validation problems or extra machine-readable context',
    example: { phone: ['must be a valid Bangladeshi mobile number'] },
  })
  details?: unknown;
}
