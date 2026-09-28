import { KidZonePlan, MembershipStatus, SaleStatus, VisitStatus } from '@prisma/client';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { PLAN_NAMES, seedCatalogue } from './utils/catalogue';

describe('Kid Zone (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;
  let plans: Record<string, KidZonePlan>;

  const guardian = { phone: '01712345678', name: 'Shahana Akter' };
  const child = {
    name: 'Ayaan Rahman',
    dateOfBirth: '2020-05-10',
    emergencyContactName: 'Shahana Akter',
    emergencyContactPhone: '01712345678',
    medicalNotes: 'Peanut allergy',
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
    ({ plans } = await seedCatalogue(ctx.prisma));
  });

  afterAll(async () => {
    await ctx.close();
  });

  const sellMembership = (overrides: Record<string, unknown> = {}, actor = staff.manager) =>
    as(server, actor)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: guardian,
        child: { create: child },
        planId: plans[PLAN_NAMES.threeMonth].id,
        payments: [{ method: 'CASH', amount: 600_000 }],
        ...overrides,
      });

  const sellSession = (overrides: Record<string, unknown> = {}, actor = staff.manager) =>
    as(server, actor)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: guardian,
        child: { create: child },
        planId: plans[PLAN_NAMES.twoHour].id,
        payments: [{ method: 'CASH', amount: 40_000 }],
        ...overrides,
      });

  // -------------------------------------------------------------------------

  describe('RBAC', () => {
    it('denies every Kid Zone endpoint to a restaurant cashier', async () => {
      // Sequentially: supertest binds an ephemeral port per request, so firing
      // these in parallel races on the listener rather than testing anything.
      for (const url of [
        '/api/v1/kidzone/plans',
        '/api/v1/kidzone/sales',
        '/api/v1/kidzone/memberships',
        '/api/v1/kidzone/visits/active',
      ]) {
        expect((await as(server, staff.cashier).get(url)).status).toBe(403);
      }

      expect(
        (await as(server, staff.cashier).post('/api/v1/kidzone/checkin/lookup').send({ phone: guardian.phone })).status,
      ).toBe(403);
      expect((await as(server, staff.cashier).post('/api/v1/kidzone/sales').send({})).status).toBe(403);
    });

    it('never leaks child data to a cashier through a customer lookup', async () => {
      await sellMembership().expect(201);

      const list = await as(server, staff.cashier).get('/api/v1/customers?search=01712345678').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ phone: '+8801712345678', childCount: 1 });
      expect(list.body.data[0]).not.toHaveProperty('children');

      const customerId = list.body.data[0].id as string;
      const detail = await as(server, staff.cashier).get(`/api/v1/customers/${customerId}`).expect(200);

      expect(detail.body.data).not.toHaveProperty('kidZone');
      expect(detail.body.data).not.toHaveProperty('children');
      expect(JSON.stringify(detail.body)).not.toContain('Ayaan');
      expect(JSON.stringify(detail.body)).not.toContain('Peanut');

      await as(server, staff.cashier).get(`/api/v1/customers/${customerId}/children`).expect(403);
    });

    it('gives a Kid Zone manager the full child record', async () => {
      await sellMembership().expect(201);
      const customerId = (await ctx.prisma.customer.findFirstOrThrow()).id;

      const detail = await as(server, staff.manager).get(`/api/v1/customers/${customerId}`).expect(200);

      expect(detail.body.data.children[0]).toMatchObject({
        name: 'Ayaan Rahman',
        medicalNotes: 'Peanut allergy',
        emergencyContactPhone: '+8801712345678',
        ageYears: expect.any(Number),
      });
      expect(detail.body.data.kidZone.memberships).toHaveLength(1);
      // The gate credential is never handed out through a customer read.
      expect(detail.body.data.kidZone.memberships[0].qrToken).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------

  describe('Plans', () => {
    it('only lets an admin create or change a plan', async () => {
      await as(server, staff.manager)
        .post('/api/v1/kidzone/plans')
        .send({ name: 'Nope', type: 'SESSION', price: 1000, sessionMinutes: 60 })
        .expect(403);

      const created = await as(server, staff.admin)
        .post('/api/v1/kidzone/plans')
        .send({ name: '1 Hour Indoor', type: 'SESSION', price: 25_000, sessionMinutes: 60 })
        .expect(201);

      expect(created.body.data).toMatchObject({ name: '1 Hour Indoor', price: 25_000, gracePeriodMinutes: 10 });
    });

    it('requires durationDays for a membership and sessionMinutes for a session', async () => {
      await as(server, staff.admin)
        .post('/api/v1/kidzone/plans')
        .send({ name: 'Bad membership', type: 'MEMBERSHIP', price: 1000 })
        .expect(400);

      await as(server, staff.admin)
        .post('/api/v1/kidzone/plans')
        .send({ name: 'Bad session', type: 'SESSION', price: 1000 })
        .expect(400);
    });

    it('records a price change in the price history and the audit log', async () => {
      const planId = plans[PLAN_NAMES.twoHour].id;

      await as(server, staff.admin).patch(`/api/v1/kidzone/plans/${planId}`).send({ price: 45_000 }).expect(200);

      const history = await ctx.prisma.planPriceHistory.findMany({ where: { planId } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ oldPrice: 40_000, newPrice: 45_000, changedById: staff.admin.id });

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'PRICE_CHANGED' } });
      expect(audit?.before).toMatchObject({ price: 40_000 });
      expect(audit?.after).toMatchObject({ price: 45_000 });
    });
  });

  // -------------------------------------------------------------------------

  describe('Selling a membership', () => {
    it('creates the customer, the child, the sale, the payment and the membership', async () => {
      const response = await sellMembership().expect(201);
      const { sale, membership, visit } = response.body.data;

      expect(sale).toMatchObject({
        receiptNo: expect.stringMatching(/^KZ-\d{8}-0001$/),
        planNameSnapshot: '3 Month Membership',
        unitPriceSnapshot: 600_000,
        discountAmount: 0,
        totalAmount: 600_000,
        status: SaleStatus.COMPLETED,
        soldById: staff.manager.id,
      });

      expect(membership).toMatchObject({ status: MembershipStatus.ACTIVE });
      expect(visit).toBeNull();

      // 90 days inclusive of the start day.
      const term = await ctx.prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
      const days = Math.round((term.endDate.getTime() - term.startDate.getTime()) / 86_400_000);
      expect(days).toBe(89);

      expect(await ctx.prisma.payment.count({ where: { kidZoneSaleId: sale.id } })).toBe(1);
      expect(await ctx.prisma.customer.count()).toBe(1);
    });

    it('queues the membership SMS with the plan, end date and QR code', async () => {
      await sellMembership().expect(201);

      const sms = await ctx.prisma.smsLog.findFirstOrThrow();
      const membership = await ctx.prisma.membership.findFirstOrThrow();

      expect(sms.phone).toBe('+8801712345678');
      expect(sms.message).toContain('3 Month Membership');
      expect(sms.message).toContain(membership.qrToken);
    });

    it('reuses an existing guardian rather than duplicating them', async () => {
      await sellMembership().expect(201);
      await sellMembership({ planId: plans[PLAN_NAMES.sixMonth].id, payments: [{ method: 'CASH', amount: 1_100_000 }] }).expect(201);

      expect(await ctx.prisma.customer.count()).toBe(1);
      // A second `child.create` for the same guardian does make a second child;
      // the customer is what must not be duplicated.
      expect(await ctx.prisma.membership.count()).toBe(2);
    });

    it('numbers receipts sequentially per section per business day', async () => {
      await sellMembership().expect(201);
      const second = await sellSession({ customer: { phone: '01798765432', name: 'Second Guardian' } }).expect(201);

      expect(second.body.data.sale.receiptNo).toMatch(/^KZ-\d{8}-0002$/);
    });

    it('accepts a split payment that adds up exactly', async () => {
      await sellMembership({
        payments: [
          { method: 'CASH', amount: 400_000 },
          { method: 'BKASH', amount: 200_000, reference: 'BKS123456' },
        ],
      }).expect(201);

      expect(await ctx.prisma.payment.count()).toBe(2);
    });

    it('rejects payments that do not settle the bill exactly', async () => {
      const short = await sellMembership({ payments: [{ method: 'CASH', amount: 500_000 }] }).expect(422);
      expect(short.body.error).toBe('PAYMENT_TOTAL_MISMATCH');
      expect(short.body.details).toMatchObject({ tendered: 500_000, amountDue: 600_000, difference: -100_000 });

      await sellMembership({ payments: [{ method: 'CASH', amount: 700_000 }] }).expect(422);

      // Nothing was written.
      expect(await ctx.prisma.kidZoneSale.count()).toBe(0);
      expect(await ctx.prisma.customer.count()).toBe(0);
    });

    it('requires a transaction reference for a digital payment', async () => {
      const response = await sellMembership({ payments: [{ method: 'BKASH', amount: 600_000 }] }).expect(422);
      expect(response.body.error).toBe('PAYMENT_REFERENCE_REQUIRED');
    });

    it('caps a manager’s discount but not an admin’s', async () => {
      const overLimit = await sellMembership({
        discountAmount: 120_000, // 20%
        discountReason: 'Friend of the owner',
        payments: [{ method: 'CASH', amount: 480_000 }],
      }).expect(403);
      expect(overLimit.body.error).toBe('DISCOUNT_LIMIT_EXCEEDED');

      await sellMembership(
        {
          discountAmount: 120_000,
          discountReason: 'Owner approved',
          payments: [{ method: 'CASH', amount: 480_000 }],
        },
        staff.admin,
      ).expect(201);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'DISCOUNT_APPLIED' } });
      expect(audit?.reason).toBe('Owner approved');
      expect(audit?.after).toMatchObject({ discountAmount: 120_000, discountPercent: 20 });
    });

    it('requires a reason for any discount', async () => {
      const response = await sellMembership({
        discountAmount: 10_000,
        payments: [{ method: 'CASH', amount: 590_000 }],
      }).expect(422);
      expect(response.body.error).toBe('DISCOUNT_REASON_REQUIRED');
    });

    it('refuses to sell a retired plan', async () => {
      const planId = plans[PLAN_NAMES.threeMonth].id;
      await as(server, staff.admin).delete(`/api/v1/kidzone/plans/${planId}`).expect(200);

      const response = await sellMembership().expect(422);
      expect(response.body.error).toBe('PLAN_INACTIVE');
    });
  });

  // -------------------------------------------------------------------------

  describe('Selling a session', () => {
    it('checks the child in immediately with a gatepass and an expected check-out', async () => {
      const response = await sellSession().expect(201);
      const { sale, visit, membership } = response.body.data;

      expect(membership).toBeNull();
      expect(visit).toMatchObject({
        gatepassNo: expect.stringMatching(/^GP-\d{8}-0001$/),
        verificationMethod: 'GATEPASS',
        status: VisitStatus.ACTIVE,
        saleId: sale.id,
      });

      const gap = new Date(visit.expectedCheckOutAt).getTime() - new Date(visit.checkInAt).getTime();
      expect(gap).toBe(120 * 60_000);

      const sms = await ctx.prisma.smsLog.findFirstOrThrow();
      expect(sms.message).toContain(visit.gatepassNo);
    });

    it('refuses a second session while the child is still inside', async () => {
      const first = await sellSession().expect(201);
      const childId = first.body.data.visit.childId as string;

      const response = await sellSession({ child: { id: childId } }).expect(409);
      expect(response.body.error).toBe('CHILD_ALREADY_CHECKED_IN');
      expect(response.body.details.gatepassNo).toBe(first.body.data.visit.gatepassNo);
    });
  });

  // -------------------------------------------------------------------------

  describe('Check-in', () => {
    const lookup = () =>
      as(server, staff.manager).post('/api/v1/kidzone/checkin/lookup').send({ phone: guardian.phone });

    it('reports children, memberships and days remaining', async () => {
      await sellMembership().expect(201);

      const response = await lookup().expect(200);

      expect(response.body.data.customer).toMatchObject({ phone: '+8801712345678', name: 'Shahana Akter' });
      expect(response.body.data.children[0]).toMatchObject({ name: 'Ayaan Rahman', hasActiveVisit: false });
      expect(response.body.data.children[0].memberships[0]).toMatchObject({
        planName: '3 Month Membership',
        daysRemaining: 90,
        usable: true,
        blockedReason: null,
      });
    });

    it('checks in with OTP and rejects a wrong code first', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;
      const childId = sale.body.data.membership.childId as string;

      const sent = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: guardian.phone })
        .expect(200);

      const code = sent.body.data.devCode as string;
      expect(code).toMatch(/^\d{6}$/);

      const wrong = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/verify')
        .send({ phone: guardian.phone, code: '000000', childId, membershipId })
        .expect(400);
      expect(wrong.body.error).toBe('OTP_INCORRECT');
      expect(wrong.body.details.attemptsRemaining).toBe(4);

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/verify')
        .send({ phone: guardian.phone, code, childId, membershipId })
        .expect(200);

      expect(response.body.data).toMatchObject({
        daysRemaining: 90,
        expiringSoon: false,
        visit: { verificationMethod: 'OTP', status: VisitStatus.ACTIVE },
      });

      // The code is single use.
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/verify')
        .send({ phone: guardian.phone, code, childId, membershipId })
        .expect(400);
    });

    it('invalidates the OTP after five wrong attempts', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;
      const childId = sale.body.data.membership.childId as string;

      const sent = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: guardian.phone })
        .expect(200);

      for (let attempt = 0; attempt < 4; attempt++) {
        await as(server, staff.manager)
          .post('/api/v1/kidzone/checkin/otp/verify')
          .send({ phone: guardian.phone, code: '000000', childId, membershipId })
          .expect(400);
      }

      const fifth = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/verify')
        .send({ phone: guardian.phone, code: '000000', childId, membershipId })
        .expect(429);
      expect(fifth.body.error).toBe('OTP_TOO_MANY_ATTEMPTS');

      // Even the correct code no longer works.
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/verify')
        .send({ phone: guardian.phone, code: sent.body.data.devCode, childId, membershipId })
        .expect(400);
    });

    it('enforces the OTP resend cooldown', async () => {
      await sellMembership().expect(201);

      await as(server, staff.manager).post('/api/v1/kidzone/checkin/otp/send').send({ phone: guardian.phone }).expect(200);

      const second = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: guardian.phone })
        .expect(429);
      expect(second.body.error).toBe('OTP_RESEND_TOO_SOON');
    });

    it('checks in with the QR token and sends no SMS', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      const smsBefore = await ctx.prisma.smsLog.count();

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(200);

      expect(response.body.data.visit).toMatchObject({ verificationMethod: 'QR', status: VisitStatus.ACTIVE });
      expect(await ctx.prisma.smsLog.count()).toBe(smsBefore);
    });

    it('rejects an unknown QR token without confirming whether it exists', async () => {
      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: 'totally-made-up-token-value' })
        .expect(404);
      expect(response.body.error).toBe('QR_INVALID');
    });

    it('rejects an expired membership and says when it ended', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      // Backdate the term so it ended yesterday.
      const endDate = new Date(Date.now() - 86_400_000);
      endDate.setUTCHours(0, 0, 0, 0);
      const startDate = new Date(endDate.getTime() - 89 * 86_400_000);
      await ctx.prisma.membership.update({ where: { id: membership.id }, data: { startDate, endDate } });

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(409);

      expect(response.body.error).toBe('MEMBERSHIP_EXPIRED');
      expect(response.body.message).toContain(endDate.toISOString().slice(0, 10));
      expect(response.body.details.endDate).toBe(endDate.toISOString().slice(0, 10));
    });

    it('rejects a membership that has not started yet', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      const startDate = new Date(Date.now() + 5 * 86_400_000);
      startDate.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.membership.update({
        where: { id: membership.id },
        data: { startDate, endDate: new Date(startDate.getTime() + 89 * 86_400_000) },
      });

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(409);
      expect(response.body.error).toBe('MEMBERSHIP_NOT_STARTED');
    });

    it('rejects a second check-in while the child is already inside', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      await as(server, staff.manager).post('/api/v1/kidzone/checkin/qr').send({ qrToken: membership.qrToken }).expect(200);

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(409);
      expect(response.body.error).toBe('CHILD_ALREADY_CHECKED_IN');
    });

    it('allows a manual override for an admin only, and audits it', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/manual')
        .send({ membershipId, reason: 'Phone is dead' })
        .expect(403);

      const response = await as(server, staff.admin)
        .post('/api/v1/kidzone/checkin/manual')
        .send({ membershipId, reason: 'Guardian’s phone is switched off' })
        .expect(200);

      expect(response.body.data.visit.verificationMethod).toBe('MANUAL_OVERRIDE');

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'MANUAL_CHECKIN' } });
      expect(audit?.reason).toBe('Guardian’s phone is switched off');
    });

    it('a manual override still refuses an expired membership', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      const endDate = new Date(Date.now() - 86_400_000);
      endDate.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.membership.update({
        where: { id: membershipId },
        data: { startDate: new Date(endDate.getTime() - 89 * 86_400_000), endDate },
      });

      const response = await as(server, staff.admin)
        .post('/api/v1/kidzone/checkin/manual')
        .send({ membershipId, reason: 'Trying to let them in anyway' })
        .expect(409);
      expect(response.body.error).toBe('MEMBERSHIP_EXPIRED');
    });

    it('honours the checkInMethod setting', async () => {
      await as(server, staff.admin).patch('/api/v1/settings').send({ checkInMethod: 'QR' }).expect(200);
      await sellMembership().expect(201);

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: guardian.phone })
        .expect(409);
      expect(response.body.error).toBe('CHECKIN_METHOD_DISABLED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Session timer and check-out', () => {
    it('shows elapsed and remaining minutes on the active board', async () => {
      await sellSession().expect(201);

      const response = await as(server, staff.manager).get('/api/v1/kidzone/visits/active').expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        elapsedMinutes: 0,
        remainingMinutes: 120,
        isOvertime: false,
        projectedOvertimeCharge: 0,
      });
    });

    it('checks out on time with no charge', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({})
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: VisitStatus.COMPLETED,
        overtimeMinutes: 0,
        overtimeCharge: 0,
      });
    });

    it('charges overtime in whole blocks and demands payment for it', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      // 165 minutes inside: 120 session + 10 grace = 35 minutes over = 2 blocks.
      await ctx.prisma.visit.update({
        where: { id: visitId },
        data: { checkInAt: new Date(Date.now() - 165 * 60_000) },
      });

      const board = await as(server, staff.manager).get('/api/v1/kidzone/visits/active').expect(200);
      expect(board.body.data[0]).toMatchObject({ isOvertime: true, projectedOvertimeCharge: 20_000 });

      const refused = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({})
        .expect(402);
      expect(refused.body.error).toBe('OVERTIME_PAYMENT_REQUIRED');
      expect(refused.body.details).toMatchObject({ blocks: 2, overtimeCharge: 20_000 });

      const wrongAmount = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({ payments: [{ method: 'CASH', amount: 10_000 }] })
        .expect(422);
      expect(wrongAmount.body.error).toBe('PAYMENT_TOTAL_MISMATCH');

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({ payments: [{ method: 'CASH', amount: 20_000 }] })
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: VisitStatus.COMPLETED,
        overtimeMinutes: 35,
        overtimeCharge: 20_000,
        overtimeBlocks: 2,
      });

      const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { visitId } });
      expect(payment.amount).toBe(20_000);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'OVERTIME_CHARGED' } });
      expect(audit?.after).toMatchObject({ blocks: 2, overtimeCharge: 20_000 });
    });

    it('charges nothing inside the grace period', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      await ctx.prisma.visit.update({
        where: { id: visitId },
        data: { checkInAt: new Date(Date.now() - 128 * 60_000) },
      });

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({})
        .expect(200);
      expect(response.body.data.overtimeCharge).toBe(0);
    });

    it('never charges overtime on an open-ended membership visit', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });
      const checkIn = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(200);

      const visitId = checkIn.body.data.visit.id as string;
      await ctx.prisma.visit.update({
        where: { id: visitId },
        data: { checkInAt: new Date(Date.now() - 600 * 60_000) },
      });

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({})
        .expect(200);
      expect(response.body.data.overtimeCharge).toBe(0);
    });

    it('refuses to check out twice', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      await as(server, staff.manager).post(`/api/v1/kidzone/visits/${visitId}/checkout`).send({}).expect(200);
      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({})
        .expect(409);
      expect(response.body.error).toBe('VISIT_ALREADY_COMPLETED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Renewal', () => {
    it('starts the day after the old end date when renewed early, and links the chain', async () => {
      const first = await sellMembership().expect(201);
      const membershipId = first.body.data.membership.id as string;
      const original = await ctx.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } });

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/renew`)
        .send({ payments: [{ method: 'CASH', amount: 600_000 }] })
        .expect(201);

      const renewed = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: response.body.data.membership.id },
      });

      expect(renewed.renewedFromId).toBe(membershipId);
      expect(renewed.startDate.getTime()).toBe(original.endDate.getTime() + 86_400_000);
      expect(renewed.endDate.getTime()).toBe(renewed.startDate.getTime() + 89 * 86_400_000);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'MEMBERSHIP_RENEWED' } });
      expect(audit).not.toBeNull();
    });

    it('allows an upgrade to a different plan', async () => {
      const first = await sellMembership().expect(201);
      const membershipId = first.body.data.membership.id as string;

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/renew`)
        .send({ planId: plans[PLAN_NAMES.sixMonth].id, payments: [{ method: 'CASH', amount: 1_100_000 }] })
        .expect(201);

      expect(response.body.data.sale.planNameSnapshot).toBe('6 Month Membership');
    });

    it('refuses to renew the same membership twice', async () => {
      const first = await sellMembership().expect(201);
      const membershipId = first.body.data.membership.id as string;

      await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/renew`)
        .send({ payments: [{ method: 'CASH', amount: 600_000 }] })
        .expect(201);

      const response = await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/renew`)
        .send({ payments: [{ method: 'CASH', amount: 600_000 }] })
        .expect(409);
      expect(response.body.error).toBe('MEMBERSHIP_ALREADY_RENEWED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Voiding', () => {
    it('is admin only and requires a reason', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;

      await as(server, staff.manager)
        .post(`/api/v1/kidzone/sales/${saleId}/void`)
        .send({ reason: 'Customer changed their mind' })
        .expect(403);

      await as(server, staff.admin).post(`/api/v1/kidzone/sales/${saleId}/void`).send({ reason: 'no' }).expect(400);
    });

    it('marks the sale VOIDED, cancels the membership and writes an audit entry', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;
      const membershipId = sale.body.data.membership.id as string;

      const response = await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${saleId}/void`)
        .send({ reason: 'Paid by mistake, refunded in cash' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: SaleStatus.VOIDED,
        voidedById: staff.admin.id,
        voidReason: 'Paid by mistake, refunded in cash',
      });

      // The financial record itself is kept, never deleted.
      expect(await ctx.prisma.kidZoneSale.count()).toBe(1);
      expect(await ctx.prisma.payment.count({ where: { kidZoneSaleId: saleId } })).toBe(1);

      const membership = await ctx.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } });
      expect(membership.status).toBe(MembershipStatus.CANCELLED);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'SALE_VOIDED' } });
      expect(audit?.reason).toBe('Paid by mistake, refunded in cash');
    });

    it('refuses a cancelled membership at the gate after its sale is voided', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${sale.body.data.sale.id}/void`)
        .send({ reason: 'Refunded at the counter' })
        .expect(200);

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(409);
      expect(response.body.error).toBe('MEMBERSHIP_CANCELLED');
    });

    it('refuses to void the same sale twice', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;

      await as(server, staff.admin).post(`/api/v1/kidzone/sales/${saleId}/void`).send({ reason: 'First void' }).expect(200);
      const response = await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${saleId}/void`)
        .send({ reason: 'Second void' })
        .expect(409);
      expect(response.body.error).toBe('SALE_ALREADY_VOIDED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Membership listing', () => {
    it('reports days remaining and the expiring-soon follow-up list', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      const all = await as(server, staff.manager).get('/api/v1/kidzone/memberships').expect(200);
      expect(all.body.data[0]).toMatchObject({ daysRemaining: 90, expiringSoon: false, visitCount: 0 });

      // Move the end date inside the reminder window.
      const endDate = new Date(Date.now() + 3 * 86_400_000);
      endDate.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.membership.update({ where: { id: membershipId }, data: { endDate } });

      const expiring = await as(server, staff.manager)
        .get('/api/v1/kidzone/memberships?expiringWithinDays=7')
        .expect(200);
      expect(expiring.body.data).toHaveLength(1);
      expect(expiring.body.data[0]).toMatchObject({ daysRemaining: 4, expiringSoon: true });

      const notExpiring = await as(server, staff.manager)
        .get('/api/v1/kidzone/memberships?expiringWithinDays=1')
        .expect(200);
      expect(notExpiring.body.data).toHaveLength(0);
    });
  });

  describe('The membership card', () => {
    const cardOf = (id: string, actor = staff.manager) =>
      as(server, actor).get(`/api/v1/kidzone/memberships/${id}/qr`);

    it('is the only read that returns the token, and the token it returns opens the gate', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      // Every other read must keep stripping it, or a printed card's
      // credential leaks into any list a cashier happens to load.
      const list = await as(server, staff.manager).get('/api/v1/kidzone/memberships').expect(200);
      expect(list.body.data[0].qrToken).toBeUndefined();
      const detail = await as(server, staff.manager)
        .get(`/api/v1/kidzone/memberships/${membershipId}`)
        .expect(200);
      expect(detail.body.data.qrToken).toBeUndefined();

      const card = await cardOf(membershipId).expect(200);
      expect(card.body.data).toMatchObject({
        membershipId,
        usable: true,
        blockedReason: null,
        daysRemaining: 90,
        child: { name: child.name },
        customer: { name: guardian.name },
      });

      // The whole point of the card: what is printed is what the gate accepts,
      // with no encoding or wrapper in between.
      const token = card.body.data.qrToken as string;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);

      const checkIn = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: token })
        .expect(200);
      expect(checkIn.body.data.visit.verificationMethod).toBe('QR');
    });

    it('records who asked for a card', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      await cardOf(membershipId).expect(200);

      const entry = await ctx.prisma.auditLog.findFirst({
        where: { action: 'MEMBERSHIP_QR_ISSUED', entityId: membershipId },
      });
      expect(entry).not.toBeNull();
      expect(entry!.actorId).toBe(staff.manager.id);
      // The credential itself must never land in a log every admin can read.
      expect(JSON.stringify(entry!.after)).not.toContain(sale.body.data.membership.qrToken);
    });

    it('flags a card the gate would refuse rather than pretending it works', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      // Both ends move: a check constraint keeps the end on or after the start,
      // so backdating only the end date would fail before the assertion ran.
      const day = (offset: number) => {
        const date = new Date(Date.now() + offset * 86_400_000);
        date.setUTCHours(0, 0, 0, 0);
        return date;
      };
      await ctx.prisma.membership.update({
        where: { id: membershipId },
        data: { startDate: day(-30), endDate: day(-2) },
      });

      const card = await cardOf(membershipId).expect(200);
      expect(card.body.data.usable).toBe(false);
      expect(card.body.data.blockedReason).toMatch(/ended on/);
    });

    it('reissuing mints a new token and kills the printed one', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      const before = await cardOf(membershipId).expect(200);
      const oldToken = before.body.data.qrToken as string;

      const reissued = await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/qr/reissue`)
        .send({ reason: 'Guardian reported the card lost at the gate' })
        .expect(200);

      const newToken = reissued.body.data.qrToken as string;
      expect(newToken).not.toBe(oldToken);
      expect(reissued.body.data.membershipId).toBe(membershipId);

      // The card in the guardian's hand must stop working, not merely stop
      // being the newest one.
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: oldToken })
        .expect(404);

      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: newToken })
        .expect(200);

      const entry = await ctx.prisma.auditLog.findFirst({
        where: { action: 'MEMBERSHIP_QR_REISSUED', entityId: membershipId },
      });
      expect(entry?.reason).toBe('Guardian reported the card lost at the gate');
    });

    it('refuses to reissue without a reason', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${membershipId}/qr/reissue`)
        .send({})
        .expect(400);
    });

    it('refuses a restaurant cashier both the card and the reissue', async () => {
      const sale = await sellMembership().expect(201);
      const membershipId = sale.body.data.membership.id as string;

      await cardOf(membershipId, staff.cashier).expect(403);
      await as(server, staff.cashier)
        .post(`/api/v1/kidzone/memberships/${membershipId}/qr/reissue`)
        .send({ reason: 'Trying it on' })
        .expect(403);
    });
  });
});
