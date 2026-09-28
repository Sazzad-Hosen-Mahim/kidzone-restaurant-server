/**
 * Demo data: `npm run seed:demo`
 *
 * Generates 90 days of plausible trade so the frontend can be built against
 * reports that actually say something. The shape of the data matters more than
 * the volume:
 *
 *  - Fridays and Saturdays are the busy days (the Bangladeshi weekend), and
 *    late afternoon / early evening is the busy time, so the peak-hours heatmap
 *    has a real pattern in it rather than uniform noise.
 *  - Memberships are bought across the whole window, some renewed, some lapsed
 *    without renewing, so the expiry and utilisation reports have all their
 *    cases populated.
 *  - A minority of sessions run into overtime, a few sales carry discounts, a
 *    couple per week get voided.
 *  - Every day but today is closed off, with the occasional small cash
 *    difference.
 *
 * The generator is seeded, so two runs produce the same data set.
 *
 * It refuses to run against a database that already holds trade, and never runs
 * when NODE_ENV=production.
 */
import 'reflect-metadata';
import {
  MembershipStatus,
  OrderStatus,
  PaymentMethod,
  PlanType,
  Prisma,
  PrismaClient,
  SaleStatus,
  Section,
  VerificationMethod,
  VisitStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const DAYS = 90;
const TIMEZONE_OFFSET_MINUTES = 6 * 60; // Asia/Dhaka is UTC+6, with no DST

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and good enough for demo data. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(20260922);

const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number): number => Math.floor(random() * (max - min + 1)) + min;
const chance = (probability: number): boolean => random() < probability;

// ---------------------------------------------------------------------------
// Bangladeshi names, so the demo data reads like the real customer book
// ---------------------------------------------------------------------------

const GUARDIAN_FIRST = [
  'Shahana', 'Rafiq', 'Nusrat', 'Kamal', 'Farhana', 'Imran', 'Tahmina', 'Sabbir', 'Rumana', 'Arif',
  'Sultana', 'Jahangir', 'Nazia', 'Mahmud', 'Rehana', 'Shakib', 'Afsana', 'Tanvir', 'Mitu', 'Rasel',
  'Shirin', 'Habib', 'Farzana', 'Masud', 'Ruma', 'Delwar', 'Sharmin', 'Anwar', 'Lipi', 'Kaiser',
];
const GUARDIAN_LAST = [
  'Akter', 'Ahmed', 'Rahman', 'Hossain', 'Islam', 'Chowdhury', 'Khan', 'Begum', 'Uddin', 'Sarker',
  'Mia', 'Das', 'Karim', 'Haque', 'Bhuiyan',
];
const CHILD_NAMES = [
  'Ayaan', 'Ria', 'Zayan', 'Anika', 'Arham', 'Tisha', 'Rayan', 'Nabila', 'Samir', 'Mahi',
  'Zara', 'Ishan', 'Nusaiba', 'Adib', 'Rafa', 'Tahmid', 'Aisha', 'Faiz', 'Maya', 'Yusuf',
];
const AREAS = ['Dhanmondi', 'Gulshan', 'Banani', 'Uttara', 'Mirpur', 'Bashundhara', 'Mohammadpur'];

const DISCOUNT_REASONS = [
  'Sibling discount',
  'Regular customer',
  'Birthday party booking',
  'Corporate tie-up',
  'Promotional offer',
];
const VOID_REASONS = [
  'Rung up on the wrong plan',
  'Customer changed their mind',
  'Duplicate entry by the cashier',
  'Payment failed at the terminal',
  'Wrong table, entered twice',
];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for a UTC-midnight date. */
const toKey = (date: Date): string => date.toISOString().slice(0, 10);

const dateColumn = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

/** The UTC instant of a local wall-clock time on a business date. */
function instantAt(dateKey: string, hour: number, minute: number): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + (hour * 60 + minute - TIMEZONE_OFFSET_MINUTES) * 60_000);
}

function addDaysTo(key: string, days: number): string {
  return toKey(new Date(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000));
}

/** 0 = Sunday … 5 = Friday, 6 = Saturday. */
const dayOfWeek = (key: string): number => new Date(`${key}T00:00:00.000Z`).getUTCDay();

/**
 * How busy a day is. Friday and Saturday are the Bangladeshi weekend, so they
 * carry roughly double a midweek day; Sunday, the first working day, is the
 * quietest.
 */
function busynessFactor(key: string): number {
  switch (dayOfWeek(key)) {
    case 5: // Friday
      return 2.2;
    case 6: // Saturday
      return 2.0;
    case 4: // Thursday evening picks up
      return 1.3;
    case 0: // Sunday
      return 0.7;
    default:
      return 1.0;
  }
}

/**
 * Kid Zone arrival hour. Weekends fill up from late morning; on a school day
 * children arrive after 4pm. Either way the evening is the peak.
 */
function kidZoneArrivalHour(key: string): number {
  const weekend = dayOfWeek(key) === 5 || dayOfWeek(key) === 6;
  const weights: Array<[number, number]> = weekend
    ? [[10, 5], [11, 8], [12, 8], [13, 6], [14, 8], [15, 12], [16, 16], [17, 18], [18, 16], [19, 12], [20, 6]]
    : [[15, 6], [16, 12], [17, 18], [18, 20], [19, 16], [20, 8], [21, 3]];
  return weightedPick(weights);
}

/** Restaurant orders cluster around lunch and dinner. */
function restaurantOrderHour(): number {
  return weightedPick([
    [11, 3], [12, 10], [13, 14], [14, 9], [15, 5], [16, 6],
    [17, 7], [18, 9], [19, 15], [20, 16], [21, 10], [22, 4],
  ]);
}

function weightedPick(weights: Array<[number, number]>): number {
  const total = weights.reduce((n, [, weight]) => n + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of weights) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return weights[weights.length - 1][0];
}

// ---------------------------------------------------------------------------

interface Counters {
  [scope: string]: Map<string, number>;
}

const counters: Counters = { RECEIPT_KIDZONE: new Map(), RECEIPT_RESTAURANT: new Map(), GATEPASS: new Map() };

function nextNumber(scope: string, dateKey: string): number {
  const forScope = counters[scope];
  const next = (forScope.get(dateKey) ?? 0) + 1;
  forScope.set(dateKey, next);
  return next;
}

function sequenceNo(scope: string, prefix: string, dateKey: string): string {
  return `${prefix}-${dateKey.replace(/-/g, '')}-${String(nextNumber(scope, dateKey)).padStart(4, '0')}`;
}

/** A payment split that adds up to exactly `total`. */
function splitPayment(total: number): Array<{ method: PaymentMethod; amount: number; reference: string | null }> {
  const digital = () => pick([PaymentMethod.BKASH, PaymentMethod.NAGAD, PaymentMethod.CARD] as const);

  // Roughly one bill in six is settled with two tenders.
  if (total > 20_000 && chance(0.17)) {
    const cashPart = Math.floor(total / 2 / 100) * 100;
    const method = digital();
    return [
      { method: PaymentMethod.CASH, amount: cashPart, reference: null },
      { method, amount: total - cashPart, reference: reference(method) },
    ];
  }

  // Cash still dominates, with bKash a strong second.
  const method = weightedMethod();
  return [{ method, amount: total, reference: reference(method) }];
}

function weightedMethod(): PaymentMethod {
  const roll = random();
  if (roll < 0.55) return PaymentMethod.CASH;
  if (roll < 0.8) return PaymentMethod.BKASH;
  if (roll < 0.92) return PaymentMethod.NAGAD;
  return PaymentMethod.CARD;
}

function reference(method: PaymentMethod): string | null {
  if (method === PaymentMethod.CASH || method === PaymentMethod.OTHER) return null;
  const prefix = method === PaymentMethod.BKASH ? 'BKS' : method === PaymentMethod.NAGAD ? 'NGD' : 'CRD';
  return `${prefix}${randomBytes(4).toString('hex').toUpperCase()}`;
}

function roundPoisha(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to generate demo data with NODE_ENV=production');
  }

  const existingSales = await prisma.kidZoneSale.count();
  const existingOrders = await prisma.order.count();
  if (existingSales > 0 || existingOrders > 0) {
    throw new Error(
      `This database already holds trade (${existingSales} Kid Zone sales, ${existingOrders} orders).\n` +
        '  Demo data is only generated into an empty ledger. Reset with: npx prisma migrate reset',
    );
  }

  const [users, plans, menuItems, settings] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true } }),
    prisma.kidZonePlan.findMany({ where: { isActive: true } }),
    prisma.menuItem.findMany({ where: { isActive: true }, include: { category: true } }),
    prisma.setting.findMany(),
  ]);

  if (users.length === 0 || plans.length === 0 || menuItems.length === 0) {
    throw new Error('Run `npm run seed` first: demo data needs the staff accounts, plans and menu.');
  }

  const admin = users.find((u) => u.role === 'ADMIN')!;
  const manager = users.find((u) => u.role === 'KIDZONE_MANAGER') ?? admin;
  const cashier = users.find((u) => u.role === 'RESTAURANT_CASHIER') ?? admin;

  const vatPercent = numberSetting(settings, 'vatPercent', 5);
  const serviceChargePercent = numberSetting(settings, 'serviceChargePercent', 10);

  const membershipPlans = plans.filter((p) => p.type === PlanType.MEMBERSHIP);
  const sessionPlans = plans.filter((p) => p.type === PlanType.SESSION);

  const today = toKey(new Date());
  const firstDay = addDaysTo(today, -(DAYS - 1));
  const days = Array.from({ length: DAYS }, (_, i) => addDaysTo(firstDay, i));

  console.log(`\nGenerating ${DAYS} days of demo data (${firstDay} to ${today})\n`);

  // -------------------------------------------------------------------------
  // Customers and children
  // -------------------------------------------------------------------------

  const customerCount = 64;
  const customers: Array<{ id: string; phone: string; children: Array<{ id: string }> }> = [];

  for (let i = 0; i < customerCount; i++) {
    const name = `${pick(GUARDIAN_FIRST)} ${pick(GUARDIAN_LAST)}`;
    const phone = `+88017${String(10_000_000 + i * 7 + between(0, 6)).padStart(8, '0')}`;
    // Registered on a random day in the window, so the customer book grows.
    const createdAt = instantAt(days[between(0, DAYS - 1)], between(10, 20), between(0, 59));

    const customer = await prisma.customer.create({
      data: {
        name,
        phone,
        email: chance(0.35) ? `${name.split(' ')[0].toLowerCase()}${i}@example.com` : null,
        address: `House ${between(1, 80)}, Road ${between(1, 20)}, ${pick(AREAS)}, Dhaka`,
        createdAt,
      },
    });

    const children: Array<{ id: string }> = [];
    for (let c = 0; c < (chance(0.3) ? 2 : 1); c++) {
      const child = await prisma.child.create({
        data: {
          customerId: customer.id,
          name: `${pick(CHILD_NAMES)} ${name.split(' ')[1]}`,
          dateOfBirth: dateColumn(`${2026 - between(3, 11)}-${pad(between(1, 12))}-${pad(between(1, 28))}`),
          gender: chance(0.5) ? 'MALE' : 'FEMALE',
          medicalNotes: chance(0.15) ? pick(['Peanut allergy', 'Asthma — carries an inhaler', 'Lactose intolerant']) : null,
          emergencyContactName: name,
          emergencyContactPhone: phone,
          createdAt,
        },
      });
      children.push({ id: child.id });
    }

    customers.push({ id: customer.id, phone, children });
  }

  console.log(`  customers    ${customers.length} with ${customers.reduce((n, c) => n + c.children.length, 0)} children`);

  // -------------------------------------------------------------------------
  // Kid Zone: memberships, sessions, visits
  // -------------------------------------------------------------------------

  interface ActiveMembership {
    id: string;
    customerId: string;
    childId: string;
    endDate: string;
    startDate: string;
  }

  const activeMemberships: ActiveMembership[] = [];
  let kidZoneSales = 0;
  let membershipCount = 0;
  let renewalCount = 0;
  let visitCount = 0;
  let overtimeCount = 0;
  let voidCount = 0;

  // A cohort sold *before* the reporting window opens.
  //
  // Without this the data has no renewals and no lapsed members at all: a
  // 90-day membership bought inside a 90-day window cannot expire inside it, so
  // the renewal counts, the churn list and the "expired without renewing"
  // follow-up list would all come out empty — exactly the reports that most
  // need something in them.
  for (let i = 0; i < 26 && membershipPlans.length > 0; i++) {
    const customer = pick(customers);
    const child = pick(customer.children);
    if (activeMemberships.some((m) => m.childId === child.id)) continue;

    const plan = pick(membershipPlans);
    const startDate = addDaysTo(firstDay, -between(10, 150));
    const endDate = addDaysTo(startDate, (plan.durationDays ?? 90) - 1);

    const { sale } = await createKidZoneSale({
      day: startDate,
      plan,
      customerId: customer.id,
      childId: child.id,
      sellerId: manager.id,
    });
    kidZoneSales++;

    const membership = await prisma.membership.create({
      data: {
        customerId: customer.id,
        childId: child.id,
        planId: plan.id,
        saleId: sale.id,
        startDate: dateColumn(startDate),
        endDate: dateColumn(endDate),
        status: endDate < today ? MembershipStatus.EXPIRED : MembershipStatus.ACTIVE,
        qrToken: randomBytes(32).toString('base64url'),
        createdAt: sale.createdAt,
      },
    });
    membershipCount++;
    activeMemberships.push({ id: membership.id, customerId: customer.id, childId: child.id, startDate, endDate });
  }

  for (const day of days) {
    const factor = busynessFactor(day);

    // --- membership sales: a couple a week, more at the weekend ---
    if (chance(0.22 * factor) && membershipPlans.length > 0) {
      const salesToday = between(1, factor > 1.5 ? 3 : 1);

      for (let i = 0; i < salesToday; i++) {
        const customer = pick(customers);
        const child = pick(customer.children);
        const plan = pick(membershipPlans);

        const existing = activeMemberships.find((m) => m.childId === child.id && m.endDate >= day);
        if (existing) continue;

        const { sale } = await createKidZoneSale({
          day,
          plan,
          customerId: customer.id,
          childId: child.id,
          sellerId: manager.id,
        });
        kidZoneSales++;

        const startDate = day;
        const endDate = addDaysTo(startDate, (plan.durationDays ?? 90) - 1);

        const membership = await prisma.membership.create({
          data: {
            customerId: customer.id,
            childId: child.id,
            planId: plan.id,
            saleId: sale.id,
            startDate: dateColumn(startDate),
            endDate: dateColumn(endDate),
            status: endDate < today ? MembershipStatus.EXPIRED : MembershipStatus.ACTIVE,
            qrToken: randomBytes(32).toString('base64url'),
            createdAt: sale.createdAt,
          },
        });
        membershipCount++;
        activeMemberships.push({ id: membership.id, customerId: customer.id, childId: child.id, startDate, endDate });
      }
    }

    // --- renewals: some expiring members come back, some do not ---
    const expiringToday = activeMemberships.filter((m) => m.endDate === addDaysTo(day, -1));
    for (const previous of expiringToday) {
      if (!chance(0.55)) continue; // ~45% churn, which is what makes the lapsed list interesting
      const plan = pick(membershipPlans);

      const { sale } = await createKidZoneSale({
        day,
        plan,
        customerId: previous.customerId,
        childId: previous.childId,
        sellerId: manager.id,
      });
      kidZoneSales++;

      const startDate = day;
      const endDate = addDaysTo(startDate, (plan.durationDays ?? 90) - 1);

      const membership = await prisma.membership.create({
        data: {
          customerId: previous.customerId,
          childId: previous.childId,
          planId: plan.id,
          saleId: sale.id,
          startDate: dateColumn(startDate),
          endDate: dateColumn(endDate),
          status: endDate < today ? MembershipStatus.EXPIRED : MembershipStatus.ACTIVE,
          qrToken: randomBytes(32).toString('base64url'),
          renewedFromId: previous.id,
          createdAt: sale.createdAt,
        },
      });
      renewalCount++;
      activeMemberships.push({
        id: membership.id,
        customerId: previous.customerId,
        childId: previous.childId,
        startDate,
        endDate,
      });
    }

    // --- member check-ins ---
    const currentMembers = activeMemberships.filter((m) => m.startDate <= day && m.endDate >= day);
    const busyChildren = new Set<string>();

    for (const membership of currentMembers) {
      // A member comes in on roughly a third of weekend days and a tenth of
      // weekdays, which lands the utilisation report in a believable range.
      if (!chance(0.11 * factor)) continue;
      if (busyChildren.has(membership.childId)) continue;
      busyChildren.add(membership.childId);

      const hour = kidZoneArrivalHour(day);
      const checkInAt = instantAt(day, hour, between(0, 59));
      const stayMinutes = between(45, 180);

      await prisma.visit.create({
        data: {
          businessDate: dateColumn(day),
          customerId: membership.customerId,
          childId: membership.childId,
          membershipId: membership.id,
          gatepassNo: sequenceNo('GATEPASS', 'GP', day),
          checkInAt,
          expectedCheckOutAt: null,
          checkOutAt: new Date(checkInAt.getTime() + stayMinutes * 60_000),
          verificationMethod: chance(0.6) ? VerificationMethod.OTP : VerificationMethod.QR,
          status: VisitStatus.COMPLETED,
          checkedInById: manager.id,
          checkedOutById: manager.id,
          createdAt: checkInAt,
        },
      });
      visitCount++;
    }

    // --- one-time sessions ---
    const sessionsToday = Math.max(0, Math.round(between(2, 6) * factor));

    for (let i = 0; i < sessionsToday && sessionPlans.length > 0; i++) {
      const customer = pick(customers);
      const child = pick(customer.children);
      if (busyChildren.has(child.id)) continue;
      busyChildren.add(child.id);

      const plan = pick(sessionPlans);
      const hour = kidZoneArrivalHour(day);
      const checkInAt = instantAt(day, hour, between(0, 59));

      const { sale, voided } = await createKidZoneSale({
        day,
        plan,
        customerId: customer.id,
        childId: child.id,
        sellerId: manager.id,
        at: checkInAt,
      });
      kidZoneSales++;
      if (voided) voidCount++;

      const sessionMinutes = plan.sessionMinutes ?? 120;
      const grace = plan.gracePeriodMinutes;

      // About one session in six runs past the grace period.
      const stayMinutes = chance(0.17)
        ? sessionMinutes + grace + between(1, 75)
        : between(Math.round(sessionMinutes * 0.5), sessionMinutes + grace);

      const checkOutAt = new Date(checkInAt.getTime() + stayMinutes * 60_000);
      const overtimeMinutes = Math.max(0, stayMinutes - sessionMinutes - grace);
      const blocks = overtimeMinutes > 0 ? Math.ceil(overtimeMinutes / (plan.overtimeBlockMinutes ?? 30)) : 0;
      const overtimeCharge = blocks * (plan.overtimeRatePerBlock ?? 0);

      const visit = await prisma.visit.create({
        data: {
          businessDate: dateColumn(day),
          customerId: customer.id,
          childId: child.id,
          saleId: sale.id,
          gatepassNo: sequenceNo('GATEPASS', 'GP', day),
          checkInAt,
          expectedCheckOutAt: new Date(checkInAt.getTime() + sessionMinutes * 60_000),
          checkOutAt,
          verificationMethod: VerificationMethod.GATEPASS,
          overtimeMinutes,
          overtimeCharge,
          status: VisitStatus.COMPLETED,
          checkedInById: manager.id,
          checkedOutById: manager.id,
          createdAt: checkInAt,
        },
      });
      visitCount++;

      if (overtimeCharge > 0 && !voided) {
        overtimeCount++;
        const method = weightedMethod();
        await prisma.payment.create({
          data: {
            method,
            amount: overtimeCharge,
            reference: reference(method),
            visitId: visit.id,
            receivedById: manager.id,
            businessDate: dateColumn(day),
            createdAt: checkOutAt,
          },
        });
      }
    }

    // -----------------------------------------------------------------------
    // Restaurant
    // -----------------------------------------------------------------------

    const ordersToday = Math.max(1, Math.round(between(12, 26) * factor));

    for (let i = 0; i < ordersToday; i++) {
      const hour = restaurantOrderHour();
      const at = instantAt(day, hour, between(0, 59));

      // Roughly a third of bills get a phone attached, which is what makes the
      // cross-section report meaningful.
      const customer = chance(0.34) ? pick(customers) : null;

      const lineCount = between(1, 4);
      const chosen = new Map<string, number>();
      for (let l = 0; l < lineCount; l++) {
        const item = pick(menuItems);
        chosen.set(item.id, (chosen.get(item.id) ?? 0) + between(1, 3));
      }

      const lines = [...chosen.entries()].map(([itemId, quantity]) => {
        const item = menuItems.find((m) => m.id === itemId)!;
        return {
          menuItemId: item.id,
          itemNameSnapshot: item.name,
          unitPriceSnapshot: item.price,
          categoryNameSnapshot: item.category.name,
          quantity,
          lineTotal: item.price * quantity,
          note: chance(0.08) ? pick(['Less spicy', 'No onion', 'Extra sauce', 'Takeaway']) : null,
        };
      });

      const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);

      const hasDiscount = chance(0.07);
      const discountAmount = hasDiscount ? Math.min(subtotal, roundPoisha(subtotal * (between(5, 10) / 100))) : 0;
      const discountReason = hasDiscount ? pick(DISCOUNT_REASONS) : null;

      const taxableBase = subtotal - discountAmount;
      const serviceChargeAmount = roundPoisha((taxableBase * serviceChargePercent) / 100);
      const vatAmount = roundPoisha(((taxableBase + serviceChargeAmount) * vatPercent) / 100);
      const totalAmount = taxableBase + serviceChargeAmount + vatAmount;

      const voided = chance(0.018);

      const order = await prisma.order.create({
        data: {
          receiptNo: sequenceNo('RECEIPT_RESTAURANT', 'RS', day),
          businessDate: dateColumn(day),
          customerId: customer?.id ?? null,
          tableNo: chance(0.75) ? `T-${between(1, 18)}` : null,
          subtotal,
          discountAmount,
          discountReason,
          vatPercent: new Prisma.Decimal(vatPercent),
          vatAmount,
          serviceChargePercent: new Prisma.Decimal(serviceChargePercent),
          serviceChargeAmount,
          totalAmount,
          status: voided ? OrderStatus.VOIDED : OrderStatus.PAID,
          cashierId: cashier.id,
          voidedById: voided ? admin.id : null,
          voidReason: voided ? pick(VOID_REASONS) : null,
          voidedAt: voided ? new Date(at.getTime() + between(2, 25) * 60_000) : null,
          createdAt: at,
          items: { create: lines },
        },
      });

      if (voided) voidCount++;

      await prisma.payment.createMany({
        data: splitPayment(totalAmount).map((payment) => ({
          ...payment,
          orderId: order.id,
          receivedById: cashier.id,
          businessDate: dateColumn(day),
          createdAt: at,
        })),
      });
    }
  }

  console.log(`  kid zone     ${kidZoneSales} sales, ${membershipCount} memberships (${renewalCount} renewals)`);
  console.log(`  visits       ${visitCount}, of which ${overtimeCount} ran into overtime`);

  const orderTotal = await prisma.order.count();
  console.log(`  restaurant   ${orderTotal} orders`);
  console.log(`  voids        ${voidCount}`);

  // -------------------------------------------------------------------------
  // Receipt counters, so the running system carries on from here
  // -------------------------------------------------------------------------

  const counterRows: Prisma.CounterCreateManyInput[] = [];
  for (const [scope, perDay] of Object.entries(counters)) {
    for (const [day, lastNumber] of perDay) {
      counterRows.push({ scope, businessDate: dateColumn(day), lastNumber });
    }
  }
  await prisma.counter.createMany({ data: counterRows, skipDuplicates: true });
  console.log(`  counters     ${counterRows.length} day/scope sequences recorded`);

  // -------------------------------------------------------------------------
  // Day closings for every day but today
  // -------------------------------------------------------------------------

  let closings = 0;

  for (const day of days.slice(0, -1)) {
    for (const section of [Section.KIDZONE, Section.RESTAURANT]) {
      const summary = await closingFigures(section, day);
      if (summary.transactionCount === 0) continue;

      // Most tills balance; occasionally a small note goes astray.
      const difference = chance(0.12) ? between(-5, 5) * 1_000 : 0;

      await prisma.dayClosing.create({
        data: {
          section,
          businessDate: dateColumn(day),
          expectedCash: summary.expectedCash,
          countedCash: summary.expectedCash + difference,
          difference,
          expectedByMethod: summary.byMethod as Prisma.InputJsonValue,
          totalSales: summary.totalSales,
          totalVoids: summary.totalVoids,
          totalDiscounts: summary.totalDiscounts,
          transactionCount: summary.transactionCount,
          notes: difference !== 0 ? 'Cash count did not match; float to be checked' : null,
          closedById: section === Section.KIDZONE ? manager.id : cashier.id,
          closedAt: instantAt(day, 22, 30),
        },
      });
      closings++;
    }
  }

  console.log(`  closings     ${closings} (today is left open)`);
  console.log('\nDone. Sign in and open /api/docs, or point the frontend at /api/v1.\n');
}

// ---------------------------------------------------------------------------

async function createKidZoneSale(input: {
  day: string;
  plan: { id: string; name: string; price: number };
  customerId: string;
  childId: string;
  sellerId: string;
  at?: Date;
}): Promise<{ sale: { id: string; createdAt: Date }; voided: boolean }> {
  const at = input.at ?? instantAt(input.day, between(11, 20), between(0, 59));

  const hasDiscount = chance(0.08);
  const discountAmount = hasDiscount
    ? Math.min(input.plan.price, roundPoisha(input.plan.price * (between(5, 10) / 100)))
    : 0;
  const totalAmount = input.plan.price - discountAmount;

  // Memberships are rarely voided; a mis-rung session happens now and then.
  const voided = chance(0.015);

  const sale = await prisma.kidZoneSale.create({
    data: {
      receiptNo: sequenceNo('RECEIPT_KIDZONE', 'KZ', input.day),
      businessDate: dateColumn(input.day),
      customerId: input.customerId,
      childId: input.childId,
      planId: input.plan.id,
      planNameSnapshot: input.plan.name,
      unitPriceSnapshot: input.plan.price,
      discountAmount,
      discountReason: hasDiscount ? pick(DISCOUNT_REASONS) : null,
      totalAmount,
      status: voided ? SaleStatus.VOIDED : SaleStatus.COMPLETED,
      soldById: input.sellerId,
      voidedById: voided ? input.sellerId : null,
      voidReason: voided ? pick(VOID_REASONS) : null,
      voidedAt: voided ? new Date(at.getTime() + between(2, 30) * 60_000) : null,
      createdAt: at,
    },
  });

  await prisma.payment.createMany({
    data: splitPayment(totalAmount).map((payment) => ({
      ...payment,
      kidZoneSaleId: sale.id,
      receivedById: input.sellerId,
      businessDate: dateColumn(input.day),
      createdAt: at,
    })),
  });

  return { sale, voided };
}

/** The same figures the closing preview computes, for a day being back-filled. */
async function closingFigures(
  section: Section,
  day: string,
): Promise<{
  expectedCash: number;
  byMethod: Record<string, number>;
  totalSales: number;
  totalVoids: number;
  totalDiscounts: number;
  transactionCount: number;
}> {
  const businessDate = dateColumn(day);

  const paymentWhere =
    section === Section.KIDZONE
      ? { OR: [{ kidZoneSale: { status: SaleStatus.COMPLETED } }, { visitId: { not: null } }] }
      : { order: { status: OrderStatus.PAID } };

  const payments = await prisma.payment.groupBy({
    by: ['method'],
    where: { businessDate, ...paymentWhere },
    _sum: { amount: true },
  });

  const byMethod: Record<string, number> = {};
  for (const method of Object.values(PaymentMethod)) byMethod[method] = 0;
  for (const row of payments) byMethod[row.method] = row._sum.amount ?? 0;

  if (section === Section.KIDZONE) {
    const [completed, voided] = await Promise.all([
      prisma.kidZoneSale.aggregate({
        where: { businessDate, status: SaleStatus.COMPLETED },
        _sum: { totalAmount: true, discountAmount: true },
        _count: { _all: true },
      }),
      prisma.kidZoneSale.aggregate({
        where: { businessDate, status: SaleStatus.VOIDED },
        _sum: { totalAmount: true },
      }),
    ]);

    return {
      expectedCash: byMethod[PaymentMethod.CASH],
      byMethod,
      totalSales: completed._sum.totalAmount ?? 0,
      totalVoids: voided._sum.totalAmount ?? 0,
      totalDiscounts: completed._sum.discountAmount ?? 0,
      transactionCount: completed._count._all,
    };
  }

  const [paid, voided] = await Promise.all([
    prisma.order.aggregate({
      where: { businessDate, status: OrderStatus.PAID },
      _sum: { totalAmount: true, discountAmount: true },
      _count: { _all: true },
    }),
    prisma.order.aggregate({
      where: { businessDate, status: OrderStatus.VOIDED },
      _sum: { totalAmount: true },
    }),
  ]);

  return {
    expectedCash: byMethod[PaymentMethod.CASH],
    byMethod,
    totalSales: paid._sum.totalAmount ?? 0,
    totalVoids: voided._sum.totalAmount ?? 0,
    totalDiscounts: paid._sum.discountAmount ?? 0,
    transactionCount: paid._count._all,
  };
}

function numberSetting(settings: Array<{ key: string; value: unknown }>, key: string, fallback: number): number {
  const found = settings.find((s) => s.key === key);
  return typeof found?.value === 'number' ? found.value : fallback;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

main()
  .catch((error: unknown) => {
    console.error(`\nDemo seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
