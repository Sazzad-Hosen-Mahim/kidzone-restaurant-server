import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaExecutor } from '@/prisma/prisma.service';
import { UnprocessableDomainException } from '@common/exceptions/domain.exception';
import { BusinessDate, toDateColumn } from '@common/utils/date.util';
import { formatPoisha, sumPoisha } from '@common/utils/money.util';
import { PaymentInputDto } from './dto/payment-input.dto';

/** Which bill a set of payments settles. Exactly one key is set. */
export type PaymentParent =
  | { kidZoneSaleId: string }
  | { orderId: string }
  | { visitId: string };

/**
 * Creating and validating payments.
 *
 * Split payments are the normal case in Bangladesh — part cash, part bKash — so
 * a bill may carry several payment rows. The one rule that must never bend is
 * that they add up to exactly the amount due: a bill that is over- or
 * under-tendered would quietly corrupt the day-end cash reconciliation, so it
 * is rejected rather than rounded.
 */
@Injectable()
export class PaymentsService {
  /**
   * Checks that the tendered amounts settle the bill exactly.
   * Returns the validated total so the caller can use it without re-summing.
   */
  assertSettlesExactly(payments: PaymentInputDto[], amountDue: number): number {
    if (payments.length === 0) {
      throw new UnprocessableDomainException('PAYMENT_REQUIRED', 'At least one payment is required');
    }

    for (const payment of payments) {
      if (!Number.isInteger(payment.amount) || payment.amount <= 0) {
        throw new UnprocessableDomainException(
          'INVALID_PAYMENT_AMOUNT',
          'Every payment must be a whole, positive number of poisha',
        );
      }
    }

    const tendered = sumPoisha(payments.map((p) => p.amount));

    if (tendered !== amountDue) {
      throw new UnprocessableDomainException(
        'PAYMENT_TOTAL_MISMATCH',
        `Payments total ${formatPoisha(tendered)} but the amount due is ${formatPoisha(amountDue)}`,
        { tendered, amountDue, difference: tendered - amountDue },
      );
    }

    // A digital payment without a transaction id cannot be reconciled against
    // the provider's statement at day end.
    for (const payment of payments) {
      if (requiresReference(payment.method) && !payment.reference?.trim()) {
        throw new UnprocessableDomainException(
          'PAYMENT_REFERENCE_REQUIRED',
          `A transaction reference is required for ${payment.method} payments`,
          { method: payment.method },
        );
      }
    }

    return tendered;
  }

  /**
   * Writes the payment rows. Always called inside the same transaction as the
   * sale or order it settles, so money and its tender commit together.
   */
  async createMany(
    tx: PrismaExecutor,
    payments: PaymentInputDto[],
    parent: PaymentParent,
    context: { receivedById: string; businessDate: BusinessDate },
  ): Promise<void> {
    const data: Prisma.PaymentCreateManyInput[] = payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
      reference: payment.reference?.trim() || null,
      receivedById: context.receivedById,
      businessDate: toDateColumn(context.businessDate),
      ...parent,
    }));

    await tx.payment.createMany({ data });
  }
}

function requiresReference(method: PaymentMethod): boolean {
  return method === PaymentMethod.BKASH || method === PaymentMethod.NAGAD || method === PaymentMethod.CARD;
}
