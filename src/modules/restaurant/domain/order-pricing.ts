import { percentOf, sumPoisha } from '@common/utils/money.util';

/**
 * Restaurant bill arithmetic.
 *
 * Pure and dependency-free, because this is the function that decides what a
 * customer actually pays and it must be verifiable on its own.
 *
 * **Order of operations**, which is the part everyone gets wrong:
 *
 *   1. `subtotal`       = sum of line totals (unit price x quantity)
 *   2. `discount`       applied to the subtotal
 *   3. `serviceCharge`  = serviceChargePercent of (subtotal - discount)
 *   4. `vat`            = vatPercent of (subtotal - discount + serviceCharge)
 *   5. `total`          = subtotal - discount + serviceCharge + vat
 *
 * So the discount reduces the service charge and the VAT as well as the food,
 * and VAT is charged on the service charge — which is how a Bangladeshi
 * restaurant bill is laid out.
 *
 * **Rounding**: every money value is a whole number of poisha. Each derived
 * amount is rounded once, half away from zero, at the moment it is computed —
 * never accumulated as a float and rounded at the end. The percentages
 * themselves are snapshotted onto the order, so reprinting an old receipt after
 * a VAT change still reproduces the original figures exactly.
 */

export interface OrderLineInput {
  /** Poisha. Read from the database, never from the client. */
  unitPrice: number;
  quantity: number;
}

export interface OrderLineTotal extends OrderLineInput {
  lineTotal: number;
}

export interface OrderPricingInput {
  lines: OrderLineInput[];
  /** Poisha off the subtotal. Already validated against the role's limit. */
  discountAmount?: number;
  /** Human percentage, e.g. 10 for 10%. */
  serviceChargePercent: number;
  /** Human percentage, e.g. 5 for 5%. */
  vatPercent: number;
}

export interface OrderPricing {
  lines: OrderLineTotal[];
  subtotal: number;
  discountAmount: number;
  /** subtotal - discount. The base for the service charge. */
  taxableBase: number;
  serviceChargePercent: number;
  serviceChargeAmount: number;
  vatPercent: number;
  vatAmount: number;
  totalAmount: number;
}

export function priceOrder(input: OrderPricingInput): OrderPricing {
  const lines: OrderLineTotal[] = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new Error(`Quantity must be a whole number of at least 1, received ${line.quantity}`);
    }
    if (!Number.isInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new Error(`Unit price must be a whole, non-negative number of poisha, received ${line.unitPrice}`);
    }
    return { ...line, lineTotal: line.unitPrice * line.quantity };
  });

  const subtotal = sumPoisha(lines.map((l) => l.lineTotal));
  const discountAmount = input.discountAmount ?? 0;

  if (discountAmount > subtotal) {
    throw new Error('A discount cannot exceed the subtotal');
  }

  const taxableBase = subtotal - discountAmount;
  const serviceChargeAmount = percentOf(taxableBase, input.serviceChargePercent);
  const vatAmount = percentOf(taxableBase + serviceChargeAmount, input.vatPercent);
  const totalAmount = taxableBase + serviceChargeAmount + vatAmount;

  return {
    lines,
    subtotal,
    discountAmount,
    taxableBase,
    serviceChargePercent: input.serviceChargePercent,
    serviceChargeAmount,
    vatPercent: input.vatPercent,
    vatAmount,
    totalAmount,
  };
}
