import { Injectable } from '@nestjs/common';
import { Prisma, Section } from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { BusinessDate, toDateColumn } from '@common/utils/date.util';

export const COUNTER_SCOPES = {
  RECEIPT_KIDZONE: 'RECEIPT_KIDZONE',
  RECEIPT_RESTAURANT: 'RECEIPT_RESTAURANT',
  GATEPASS: 'GATEPASS',
} as const;

const PREFIXES: Record<string, string> = {
  [COUNTER_SCOPES.RECEIPT_KIDZONE]: 'KZ',
  [COUNTER_SCOPES.RECEIPT_RESTAURANT]: 'RS',
  [COUNTER_SCOPES.GATEPASS]: 'GP',
};

/**
 * Human-readable sequence numbers that restart every business day, such as
 * `KZ-20260922-0001`.
 *
 * The counter is bumped with one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement. That is a single atomic round trip which takes a row lock for the
 * duration of the caller's transaction, so two tills ringing up at the same
 * instant queue behind each other and can never be handed the same number —
 * unlike a read-then-write, which would race.
 *
 * Callers must pass the transaction they are already in, so the number is only
 * consumed if the sale itself commits.
 */
@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** The next number in a scope for a business date, e.g. `KZ-20260922-0001`. */
  async next(scope: string, businessDate: BusinessDate, tx?: PrismaExecutor): Promise<string> {
    const client = tx ?? this.prisma;
    const date = toDateColumn(businessDate);

    const rows = await client.$queryRaw<Array<{ lastNumber: number }>>(
      Prisma.sql`
        INSERT INTO "counters" ("scope", "businessDate", "lastNumber")
        VALUES (${scope}, ${date}::date, 1)
        ON CONFLICT ("scope", "businessDate")
        DO UPDATE SET "lastNumber" = "counters"."lastNumber" + 1
        RETURNING "lastNumber"
      `,
    );

    const sequence = rows[0]?.lastNumber;
    if (sequence === undefined) {
      throw new Error(`Failed to allocate a sequence number for ${scope} on ${businessDate}`);
    }

    return format(scope, businessDate, sequence);
  }

  nextReceiptNo(section: Section, businessDate: BusinessDate, tx?: PrismaExecutor): Promise<string> {
    const scope =
      section === Section.KIDZONE ? COUNTER_SCOPES.RECEIPT_KIDZONE : COUNTER_SCOPES.RECEIPT_RESTAURANT;
    return this.next(scope, businessDate, tx);
  }

  nextGatepassNo(businessDate: BusinessDate, tx?: PrismaExecutor): Promise<string> {
    return this.next(COUNTER_SCOPES.GATEPASS, businessDate, tx);
  }
}

function format(scope: string, businessDate: BusinessDate, sequence: number): string {
  const prefix = PREFIXES[scope] ?? scope.slice(0, 2).toUpperCase();
  const compactDate = businessDate.replace(/-/g, '');
  // Four digits covers 9,999 transactions in one section in one day; beyond
  // that the number simply grows rather than wrapping or colliding.
  return `${prefix}-${compactDate}-${String(sequence).padStart(4, '0')}`;
}
