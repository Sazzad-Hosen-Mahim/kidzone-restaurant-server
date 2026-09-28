import { KidZonePlan, MenuItem, Section } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { PLAN_NAMES, seedCatalogue } from './utils/catalogue';

describe('Receipts and day-end closing (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;
  let plans: Record<string, KidZonePlan>;
  let items: MenuItem[];

  const itemNamed = (name: string) => items.find((i) => i.name === name)!;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
    ({ plans, items } = await seedCatalogue(ctx.prisma));
  });

  afterAll(async () => {
    await ctx.close();
  });

  const sellMembership = () =>
    as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01712345678', name: 'Shahana Akter' },
        child: {
          create: {
            name: 'Ayaan Rahman',
            dateOfBirth: '2020-05-10',
            emergencyContactName: 'Shahana Akter',
            emergencyContactPhone: '01712345678',
          },
        },
        planId: plans[PLAN_NAMES.threeMonth].id,
        payments: [{ method: 'CASH', amount: 600_000 }],
      });

  const sellSession = () =>
    as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01798765432', name: 'Second Guardian' },
        child: {
          create: {
            name: 'Ria Chowdhury',
            dateOfBirth: '2019-02-02',
            emergencyContactName: 'Second Guardian',
            emergencyContactPhone: '01798765432',
          },
        },
        planId: plans[PLAN_NAMES.twoHour].id,
        payments: [{ method: 'CASH', amount: 40_000 }],
      });

  const takeOrder = (overrides: Record<string, unknown> = {}) =>
    as(server, staff.cashier)
      .post('/api/v1/restaurant/orders')
      .send({
        items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 }],
        tableNo: 'T-12',
        payments: [{ method: 'CASH', amount: 73_920 }],
        ...overrides,
      });

  // -------------------------------------------------------------------------

  describe('Kid Zone receipt', () => {
    it('returns the business header, the plan line, totals and payments', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;

      const response = await as(server, staff.manager).get(`/api/v1/receipts/kidzone/${saleId}`).expect(200);
      const receipt = response.body.data;

      expect(receipt).toMatchObject({
        kind: 'KIDZONE_SALE',
        receiptNo: sale.body.data.sale.receiptNo,
        timezone: 'Asia/Dhaka',
        business: { name: 'Kid Zone & Restaurant', footer: expect.any(String) },
        customer: { name: 'Shahana Akter', phone: '01712-345678' },
        servedBy: 'Kid Zone Manager',
        voided: { isVoided: false },
      });

      expect(receipt.lines[0]).toMatchObject({
        name: '3 Month Membership',
        quantity: 1,
        unitPrice: 600_000,
        note: 'For Ayaan Rahman',
      });
      expect(receipt.totals).toMatchObject({ subtotal: 600_000, discountAmount: 0, totalAmount: 600_000 });
      expect(receipt.payments).toEqual([{ method: 'CASH', amount: 600_000, reference: null }]);
      // Rendered in Asia/Dhaka, not UTC.
      expect(receipt.issuedAt).toMatch(/^\d{2} \w{3} \d{4}, \d{2}:\d{2} (AM|PM)$/);
    });

    it('marks a voided sale clearly', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;

      await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${saleId}/void`)
        .send({ reason: 'Refunded at the counter' })
        .expect(200);

      const response = await as(server, staff.manager).get(`/api/v1/receipts/kidzone/${saleId}`).expect(200);

      expect(response.body.data.voided).toMatchObject({
        isVoided: true,
        reason: 'Refunded at the counter',
        voidedBy: 'Admin User',
      });
    });

    it('renders an 80mm thermal PDF', async () => {
      const sale = await sellMembership().expect(201);
      const saleId = sale.body.data.sale.id as string;

      const response = await as(server, staff.manager)
        .get(`/api/v1/receipts/kidzone/${saleId}?format=pdf`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['content-disposition']).toContain(`${sale.body.data.sale.receiptNo}.pdf`);

      const pdf = response.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(500);
    });

    it('is not reachable by a restaurant cashier', async () => {
      const sale = await sellMembership().expect(201);
      await as(server, staff.cashier)
        .get(`/api/v1/receipts/kidzone/${sale.body.data.sale.id}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('Restaurant receipt', () => {
    it('itemises the bill with the snapshotted percentages', async () => {
      const order = await takeOrder().expect(201);

      const response = await as(server, staff.cashier)
        .get(`/api/v1/receipts/restaurant/${order.body.data.id}`)
        .expect(200);

      expect(response.body.data).toMatchObject({
        kind: 'RESTAURANT_ORDER',
        tableNo: 'T-12',
        servedBy: 'Restaurant Cashier',
        totals: {
          subtotal: 64_000,
          serviceChargePercent: 10,
          serviceChargeAmount: 6_400,
          vatPercent: 5,
          vatAmount: 3_520,
          totalAmount: 73_920,
        },
      });
      expect(response.body.data.lines[0]).toMatchObject({
        name: 'Chicken Biryani',
        category: 'Rice & Curry',
        quantity: 2,
        unitPrice: 32_000,
      });
    });

    it('reprints the original figures after the VAT rate changes', async () => {
      const order = await takeOrder().expect(201);
      await as(server, staff.admin).patch('/api/v1/settings').send({ vatPercent: 15 }).expect(200);

      const response = await as(server, staff.cashier)
        .get(`/api/v1/receipts/restaurant/${order.body.data.id}`)
        .expect(200);

      expect(response.body.data.totals).toMatchObject({ vatPercent: 5, vatAmount: 3_520, totalAmount: 73_920 });
    });

    it('is not reachable by a Kid Zone manager', async () => {
      const order = await takeOrder().expect(201);
      await as(server, staff.manager).get(`/api/v1/receipts/restaurant/${order.body.data.id}`).expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('Gatepass', () => {
    it('carries the child, plan, times and a QR payload that is not the membership token', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      const response = await as(server, staff.manager).get(`/api/v1/receipts/gatepass/${visitId}`).expect(200);

      expect(response.body.data).toMatchObject({
        kind: 'GATEPASS',
        receiptNo: sale.body.data.visit.gatepassNo,
        gatepass: {
          childName: 'Ria Chowdhury',
          planName: '2 Hour Indoor',
          status: 'ACTIVE',
          qrPayload: sale.body.data.visit.gatepassNo,
          overtimeCharge: 0,
        },
      });
      expect(response.body.data.gatepass.expectedCheckOutAt).toEqual(expect.any(String));
    });

    it('never leaks a membership QR token onto the printed pass', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });

      const checkIn = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(200);

      const response = await as(server, staff.manager)
        .get(`/api/v1/receipts/gatepass/${checkIn.body.data.visit.id}`)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(membership.qrToken);
      expect(response.body.data.gatepass.qrPayload).toBe(checkIn.body.data.visit.gatepassNo);
    });

    it('renders a thermal PDF', async () => {
      const sale = await sellSession().expect(201);

      const response = await as(server, staff.manager)
        .get(`/api/v1/receipts/gatepass/${sale.body.data.visit.id}?format=pdf`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  // -------------------------------------------------------------------------

  describe('Closing preview', () => {
    it('totals the till per payment method from the payment rows', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager)
        .post('/api/v1/kidzone/sales')
        .send({
          customer: { phone: '01766554433', name: 'Third Guardian' },
          child: {
            create: {
              name: 'Zayan Islam',
              dateOfBirth: '2021-01-01',
              emergencyContactName: 'Third Guardian',
              emergencyContactPhone: '01766554433',
            },
          },
          planId: plans[PLAN_NAMES.twoHour].id,
          payments: [
            { method: 'CASH', amount: 15_000 },
            { method: 'BKASH', amount: 25_000, reference: 'BKS001' },
          ],
        })
        .expect(201);

      const response = await as(server, staff.manager).get('/api/v1/closing/kidzone/preview').expect(200);

      expect(response.body.data).toMatchObject({
        section: Section.KIDZONE,
        totalSales: 640_000,
        transactionCount: 2,
        expectedCash: 615_000,
        expectedByMethod: { CASH: 615_000, BKASH: 25_000, NAGAD: 0, CARD: 0, OTHER: 0 },
        voidCount: 0,
        totalVoids: 0,
        isClosed: false,
      });
    });

    it('excludes voided sales from revenue and from the expected cash', async () => {
      const sale = await sellMembership().expect(201);
      await sellSession().expect(201);

      await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${sale.body.data.sale.id}/void`)
        .send({ reason: 'Refunded at the counter' })
        .expect(200);

      const response = await as(server, staff.manager).get('/api/v1/closing/kidzone/preview').expect(200);

      expect(response.body.data).toMatchObject({
        totalSales: 40_000,
        transactionCount: 1,
        expectedCash: 40_000,
        voidCount: 1,
        totalVoids: 600_000,
      });
    });

    it('counts overtime settled at check-out', async () => {
      const sale = await sellSession().expect(201);
      const visitId = sale.body.data.visit.id as string;

      await ctx.prisma.visit.update({
        where: { id: visitId },
        data: { checkInAt: new Date(Date.now() - 165 * 60_000) },
      });
      await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({ payments: [{ method: 'CASH', amount: 20_000 }] })
        .expect(200);

      const response = await as(server, staff.manager).get('/api/v1/closing/kidzone/preview').expect(200);

      expect(response.body.data).toMatchObject({ expectedCash: 60_000, overtimeRevenue: 20_000 });
    });

    it('keeps the two sections separate', async () => {
      await sellMembership().expect(201);
      await takeOrder().expect(201);

      const kidzone = await as(server, staff.manager).get('/api/v1/closing/kidzone/preview').expect(200);
      const restaurant = await as(server, staff.cashier).get('/api/v1/closing/restaurant/preview').expect(200);

      expect(kidzone.body.data.totalSales).toBe(600_000);
      expect(restaurant.body.data.totalSales).toBe(73_920);
    });

    it('refuses to let a cashier preview the Kid Zone till', async () => {
      const response = await as(server, staff.cashier).get('/api/v1/closing/kidzone/preview').expect(403);
      expect(response.body.message).toContain('RESTAURANT_CASHIER');

      await as(server, staff.manager).get('/api/v1/closing/restaurant/preview').expect(403);
    });

    it('rejects an unknown section', async () => {
      const response = await as(server, staff.admin).get('/api/v1/closing/kitchen/preview').expect(400);
      expect(response.body.error).toBe('UNKNOWN_SECTION');
    });
  });

  // -------------------------------------------------------------------------

  describe('Closing a day', () => {
    it('records the difference between counted and expected cash', async () => {
      await sellMembership().expect(201);

      const response = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 599_000, notes: 'One ৳10 note short' })
        .expect(201);

      expect(response.body.data).toMatchObject({
        section: Section.KIDZONE,
        expectedCash: 600_000,
        countedCash: 599_000,
        difference: -1_000,
        totalSales: 600_000,
        transactionCount: 1,
        closedById: staff.manager.id,
      });

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'DAY_CLOSED' } });
      expect(audit?.after).toMatchObject({ difference: -1_000 });
    });

    it('locks the section for that date afterwards', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 600_000 }).expect(201);

      const blocked = await as(server, staff.manager)
        .post('/api/v1/kidzone/sales')
        .send({
          customer: { phone: '01755443322', name: 'Late Guardian' },
          child: {
            create: {
              name: 'Late Child',
              dateOfBirth: '2020-01-01',
              emergencyContactName: 'Late Guardian',
              emergencyContactPhone: '01755443322',
            },
          },
          planId: plans[PLAN_NAMES.twoHour].id,
          payments: [{ method: 'CASH', amount: 40_000 }],
        })
        .expect(409);

      expect(blocked.body.error).toBe('DAY_ALREADY_CLOSED');
      expect(blocked.body.details).toMatchObject({ section: Section.KIDZONE });
    });

    it('blocks a void of a sale dated to a closed day', async () => {
      const sale = await sellMembership().expect(201);
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 600_000 }).expect(201);

      const response = await as(server, staff.admin)
        .post(`/api/v1/kidzone/sales/${sale.body.data.sale.id}/void`)
        .send({ reason: 'Trying to void after closing' })
        .expect(409);
      expect(response.body.error).toBe('DAY_ALREADY_CLOSED');
    });

    it('blocks a check-in once the Kid Zone day is closed', async () => {
      const sale = await sellMembership().expect(201);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.membership.id },
      });
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 600_000 }).expect(201);

      const response = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/qr')
        .send({ qrToken: membership.qrToken })
        .expect(409);
      expect(response.body.error).toBe('DAY_ALREADY_CLOSED');
    });

    it('does not lock the other section', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 600_000 }).expect(201);

      await takeOrder().expect(201);
    });

    it('refuses to close the same day twice', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 600_000 }).expect(201);

      const response = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 600_000 })
        .expect(409);
      expect(response.body.error).toBe('DAY_ALREADY_CLOSED');
    });

    it('refuses to close a future date', async () => {
      const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const response = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ date: future, countedCash: 0 })
        .expect(400);
      expect(response.body.error).toBe('CANNOT_CLOSE_FUTURE_DATE');
    });

    it('refuses to let a cashier close the Kid Zone', async () => {
      await as(server, staff.cashier).post('/api/v1/closing/kidzone').send({ countedCash: 0 }).expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('Reopening a day', () => {
    it('is admin only, needs a reason, and unlocks writes again', async () => {
      await sellMembership().expect(201);
      const closed = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 600_000 })
        .expect(201);
      const closingId = closed.body.data.id as string;

      await as(server, staff.manager)
        .post(`/api/v1/closing/${closingId}/reopen`)
        .send({ reason: 'Missed a cash sale' })
        .expect(403);

      await as(server, staff.admin).post(`/api/v1/closing/${closingId}/reopen`).send({ reason: 'no' }).expect(400);

      await as(server, staff.admin)
        .post(`/api/v1/closing/${closingId}/reopen`)
        .send({ reason: 'A cash sale was missed and has to be entered' })
        .expect(201);

      // Writes are accepted again.
      await sellSession().expect(201);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'DAY_REOPENED' } });
      expect(audit?.reason).toBe('A cash sale was missed and has to be entered');
    });

    it('re-closing after a reopen updates the same record and locks again', async () => {
      await sellMembership().expect(201);
      const closed = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 600_000 })
        .expect(201);

      await as(server, staff.admin)
        .post(`/api/v1/closing/${closed.body.data.id}/reopen`)
        .send({ reason: 'A cash sale was missed' })
        .expect(201);

      await sellSession().expect(201);

      const reclosed = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 640_000 })
        .expect(201);

      expect(reclosed.body.data.id).toBe(closed.body.data.id);
      expect(reclosed.body.data).toMatchObject({ expectedCash: 640_000, difference: 0, transactionCount: 2 });
      expect(await ctx.prisma.dayClosing.count()).toBe(1);

      await sellSession().expect(409);
    });

    it('refuses to reopen twice', async () => {
      await sellMembership().expect(201);
      const closed = await as(server, staff.manager)
        .post('/api/v1/closing/kidzone')
        .send({ countedCash: 600_000 })
        .expect(201);

      await as(server, staff.admin)
        .post(`/api/v1/closing/${closed.body.data.id}/reopen`)
        .send({ reason: 'First reopen' })
        .expect(201);

      const response = await as(server, staff.admin)
        .post(`/api/v1/closing/${closed.body.data.id}/reopen`)
        .send({ reason: 'Second reopen' })
        .expect(409);
      expect(response.body.error).toBe('DAY_ALREADY_REOPENED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Closing history', () => {
    it('is admin only and highlights non-zero differences', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager).post('/api/v1/closing/kidzone').send({ countedCash: 595_000 }).expect(201);
      await takeOrder().expect(201);
      await as(server, staff.cashier).post('/api/v1/closing/restaurant').send({ countedCash: 73_920 }).expect(201);

      await as(server, staff.manager).get('/api/v1/closing').expect(403);

      const all = await as(server, staff.admin).get('/api/v1/closing').expect(200);
      expect(all.body.data).toHaveLength(2);

      const differences = await as(server, staff.admin).get('/api/v1/closing?onlyDifferences=true').expect(200);
      expect(differences.body.data).toHaveLength(1);
      expect(differences.body.data[0]).toMatchObject({
        section: Section.KIDZONE,
        difference: -5_000,
        hasDifference: true,
        isReopened: false,
      });
    });
  });

  it('requires authentication for every receipt and closing endpoint', async () => {
    await request(server).get('/api/v1/closing').expect(401);
    await request(server).get('/api/v1/closing/kidzone/preview').expect(401);
    await request(server).get('/api/v1/receipts/kidzone/00000000-0000-4000-8000-000000000000').expect(401);
  });
});
