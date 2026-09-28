import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

/** Shared query parameters for every list endpoint. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1, description: '1-based page number' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25, description: 'Rows per page, capped at 100' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Column to sort by. Allowed values differ per endpoint.' })
  @IsString()
  @MaxLength(50)
  @IsOptional()
  sort?: string;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.DESC })
  @IsEnum(SortOrder)
  @IsOptional()
  order: SortOrder = SortOrder.DESC;

  @ApiPropertyOptional({ description: 'Free-text search. The searched columns differ per endpoint.' })
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  search?: string;
}

/**
 * The shape the helpers below need. Declared structurally rather than as
 * `PaginationQueryDto` so it also covers DTOs composed with `IntersectionType`,
 * which produce an object with these fields but not this class's prototype.
 */
export interface PaginationLike {
  page?: number;
  limit?: number;
  sort?: string;
  order?: SortOrder;
}

/**
 * Pagination helpers, deliberately standalone functions rather than methods on
 * the DTO.
 *
 * `IntersectionType`, `PartialType` and friends build a **new** class that
 * copies property initializers and validation metadata but does not inherit the
 * prototype. Anything defined as a method or a getter is silently dropped, so a
 * DTO composed that way would either throw (`orderBy is not a function`) or,
 * worse, quietly return `undefined` for `skip` — which Prisma ignores, making
 * every page return the first page with no error at all.
 *
 * A plain function taking the query cannot be lost that way.
 */
export function paginationPage(query: PaginationLike): number {
  return Math.max(1, query.page ?? 1);
}

export function paginationSkip(query: PaginationLike): number {
  return (paginationPage(query) - 1) * paginationTake(query);
}

export function paginationTake(query: PaginationLike): number {
  return Math.max(1, Math.min(100, query.limit ?? 25));
}

/**
 * Builds a Prisma `orderBy` from `sort`/`order`, refusing any column not on the
 * endpoint's allow-list so the query string can never reach an arbitrary field.
 */
export function paginationOrderBy<T extends string>(
  query: PaginationLike,
  allowed: readonly T[],
  fallback: T,
): Record<string, SortOrder> {
  const column = query.sort && (allowed as readonly string[]).includes(query.sort) ? query.sort : fallback;
  return { [column]: query.order ?? SortOrder.DESC };
}
