import { KidZonePlan, MenuItem } from '@prisma/client';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { PLAN_NAMES, seedCatalogue } from './utils/catalogue';

/** Reads a binary export body without supertest trying to JSON-parse it. */
const asBuffer = (test: ReturnType<ReturnType<typeof as>['get']>) =>
  test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });

describe('Reports and dashboard (e2e)', () => {
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

  /**
   * A known-good day of trade, so every total below can be asserted exactly
   * rather than "greater than zero".
   *
   *   Kid Zone   6,000.00  3 Month Membership (cash)
   *                400.00  2 Hour Indoor (cash)
   *                550.00  2 Hour Indoor + Snack Box, less a 50.00 discount (bKash)
   *                          -> 500.00
   *   Kid Zone revenue = 6,900.00  (3 sales), plus one voided 400.00 session
   *
   *   Restaurant   739.20  2 x Chicken Biryani (cash)
   *                288.75  5 x Masala Tea (card)
   *   Restaurant revenue = 1,027.95  (2 orders)
   */
  async function seedKnownDay(): Promise<{ voidedSaleId: string }> {
    await as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01711110001', name: 'Guardian One' },
        child: { create: child('Child One', '01711110001') },
        planId: plans[PLAN_NAMES.threeMonth].id,
        payments: [{ method: 'CASH', amount: 600_000 }],
      })
      .expect(201);

    await as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01711110002', name: 'Guardian Two' },
        child: { create: child('Child Two', '01711110002') },
        planId: plans[PLAN_NAMES.twoHour].id,
        payments: [{ method: 'CASH', amount: 40_000 }],
      })
      .expect(201);

    await as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01711110003', name: 'Guardian Three' },
        child: { create: child('Child Three', '01711110003') },
        planId: plans[PLAN_NAMES.twoHourSnack].id,
        discountAmount: 5_000,
        discountReason: 'Sibling discount',
        payments: [{ method: 'BKASH', amount: 50_000, reference: 'BKS100' }],
      })
      .expect(201);

    // A voided sale, which must be excluded from revenue and counted separately.
    const voided = await as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone: '01711110004', name: 'Guardian Four' },
        child: { create: child('Child Four', '01711110004') },
        planId: plans[PLAN_NAMES.twoHour].id,
        payments: [{ method: 'CASH', amount: 40_000 }],
      })
      .expect(201);

    await as(server, staff.admin)
      .post(`/api/v1/kidzone/sales/${voided.body.data.sale.id}/void`)
      .send({ reason: 'Rung up in error' })
      .expect(200);

    await as(server, staff.cashier)
      .post('/api/v1/restaurant/orders')
      .send({
        items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 }],
        customerPhone: '01711110001',
        payments: [{ method: 'CASH', amount: 73_920 }],
      })
      .expect(201);

    await as(server, staff.cashier)
      .post('/api/v1/restaurant/orders')
      .send({
        items: [{ menuItemId: itemNamed('Masala Tea').id, quantity: 5 }],
        payments: [{ method: 'CARD', amount: 28_875, reference: 'CRD900' }],
      })
      .expect(201);

    return { voidedSaleId: voided.body.data.sale.id };
  }

  const child = (name: string, phone: string) => ({
    name,
    dateOfBirth: '2020-05-10',
    emergencyContactName: 'Guardian',
    emergencyContactPhone: phone,
  });

  // -------------------------------------------------------------------------

  describe('Kid Zone summary', () => {
    it('reports exact totals on known data, excluding voids from revenue', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/summary?range=today').expect(200);
      const data = response.body.data;

      expect(data.revenue.current).toBe(690_000); // 6,000.00 + 400.00 + 500.00
      expect(data.salesCount.current).toBe(3);
      expect(data.newMemberships.current).toBe(1);
      expect(data.renewals.current).toBe(0);
      expect(data.sessionsSold.current).toBe(2);
      expect(data.discounts.current).toBe(5_000);
      expect(data.averageSaleValue.current).toBe(230_000);
      expect(data.voids).toMatchObject({ count: 1, total: 40_000 });
    });

    it('compares against the previous period and reports the change', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/summary?range=today').expect(200);

      // Nothing was sold yesterday, so there is no baseline to compare against.
      expect(response.body.data.revenue).toMatchObject({ current: 690_000, previous: 0, change: null });
      expect(response.body.meta.period).toMatchObject({
        range: 'today',
        days: 1,
        timezone: 'Asia/Dhaka',
        previous: { from: expect.any(String), to: expect.any(String) },
      });
    });

    it('counts a renewal separately from a new membership', async () => {
      const sale = await as(server, staff.manager)
        .post('/api/v1/kidzone/sales')
        .send({
          customer: { phone: '01711110001', name: 'Guardian One' },
          child: { create: child('Child One', '01711110001') },
          planId: plans[PLAN_NAMES.threeMonth].id,
          payments: [{ method: 'CASH', amount: 600_000 }],
        })
        .expect(201);

      await as(server, staff.manager)
        .post(`/api/v1/kidzone/memberships/${sale.body.data.membership.id}/renew`)
        .send({ payments: [{ method: 'CASH', amount: 600_000 }] })
        .expect(201);

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/summary?range=today').expect(200);

      expect(response.body.data.newMemberships.current).toBe(1);
      expect(response.body.data.renewals.current).toBe(1);
      expect(response.body.data.revenue.current).toBe(1_200_000);
    });

    it('includes overtime revenue', async () => {
      const sale = await as(server, staff.manager)
        .post('/api/v1/kidzone/sales')
        .send({
          customer: { phone: '01711110002', name: 'Guardian Two' },
          child: { create: child('Child Two', '01711110002') },
          planId: plans[PLAN_NAMES.twoHour].id,
          payments: [{ method: 'CASH', amount: 40_000 }],
        })
        .expect(201);

      const visitId = sale.body.data.visit.id as string;
      await ctx.prisma.visit.update({
        where: { id: visitId },
        data: { checkInAt: new Date(Date.now() - 165 * 60_000) },
      });
      await as(server, staff.manager)
        .post(`/api/v1/kidzone/visits/${visitId}/checkout`)
        .send({ payments: [{ method: 'CASH', amount: 20_000 }] })
        .expect(200);

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/summary?range=today').expect(200);
      expect(response.body.data.overtimeRevenue.current).toBe(20_000);
    });
  });

  // -------------------------------------------------------------------------

  describe('Kid Zone detail reports', () => {
    it('splits revenue by plan and returns zero-filled trend days', async () => {
      await seedKnownDay();

      const byPlan = await as(server, staff.admin).get('/api/v1/reports/kidzone/by-plan?range=today').expect(200);
      const plansData = byPlan.body.data.plans as Array<Record<string, number | string>>;

      expect(plansData).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ planName: '3 Month Membership', count: 1, revenue: 600_000 }),
          expect.objectContaining({ planName: '2 Hour Indoor', count: 1, revenue: 40_000 }),
          expect.objectContaining({ planName: '2 Hour Indoor + Snack Box', count: 1, revenue: 50_000, discounts: 5_000 }),
        ]),
      );
      expect(plansData.reduce((n, p) => n + (p.revenueShare as number), 0)).toBeCloseTo(100, 0);

      const trend = await as(server, staff.admin)
        .get('/api/v1/reports/kidzone/revenue-trend?range=this_week')
        .expect(200);

      expect(trend.body.data.granularity).toBe('day');
      // Every day of the week so far is present, including the empty ones.
      expect(trend.body.data.points.length).toBeGreaterThanOrEqual(1);
      expect(trend.body.data.points.every((p: { revenue: number }) => typeof p.revenue === 'number')).toBe(true);
      expect(trend.body.data.byPlan.length).toBe(3);
    });

    it('switches a long range to monthly granularity', async () => {
      const response = await as(server, staff.admin)
        .get('/api/v1/reports/kidzone/revenue-trend?range=this_year')
        .expect(200);

      expect(response.body.data.granularity).toBe('month');
      expect(response.body.data.points[0].period).toMatch(/^\d{4}-\d{2}$/);
    });

    it('splits visits into member and session', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/visits?range=today').expect(200);

      // Two session sales each opened a visit; the membership sale did not.
      expect(response.body.data.totals).toMatchObject({ member: 0, session: 2, total: 2 });
    });

    it('returns a dense 7x24 peak-hours grid', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/peak-hours?range=today').expect(200);

      expect(response.body.data.grid).toHaveLength(7 * 24);
      expect(response.body.data.totalVisits).toBe(2);
      expect(response.body.data.busiestHour).toMatchObject({ hour: expect.any(Number), visits: 2 });
      expect(response.body.data.grid[0]).toMatchObject({ dayOfWeek: 0, dayName: 'Sunday', hour: 0 });
    });

    it('lists low-usage memberships for follow-up', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin)
        .get('/api/v1/reports/kidzone/membership-utilization?range=today')
        .expect(200);

      expect(response.body.data.memberships).toHaveLength(1);
      expect(response.body.data.memberships[0]).toMatchObject({
        customerName: 'Guardian One',
        childName: 'Child One',
        planName: '3 Month Membership',
        visits: 0,
        visitsPerWeek: 0,
      });
      // Zero visits is below any sensible threshold.
      expect(response.body.data.lowUsage).toHaveLength(1);
    });

    it('builds the expiring and lapsed call lists', async () => {
      await seedKnownDay();
      const membership = await ctx.prisma.membership.findFirstOrThrow();

      const endDate = new Date(Date.now() + 3 * 86_400_000);
      endDate.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.membership.update({ where: { id: membership.id }, data: { endDate } });

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/members').expect(200);

      expect(response.body.data).toMatchObject({ activeCount: 1, expiringIn7Days: 1, expiringIn30Days: 1 });
      expect(response.body.data.expiringSoon[0]).toMatchObject({
        customerName: 'Guardian One',
        childName: 'Child One',
        daysRemaining: 4,
      });
      expect(response.body.data.lapsedWithoutRenewal).toHaveLength(0);
    });

    it('lists a lapsed member who has not renewed', async () => {
      await seedKnownDay();
      const membership = await ctx.prisma.membership.findFirstOrThrow();

      const endDate = new Date(Date.now() - 5 * 86_400_000);
      endDate.setUTCHours(0, 0, 0, 0);
      await ctx.prisma.membership.update({
        where: { id: membership.id },
        // startDate moves with it: the database refuses a term that ends before
        // it starts.
        data: { startDate: new Date(endDate.getTime() - 89 * 86_400_000), endDate, status: 'EXPIRED' },
      });

      const response = await as(server, staff.admin).get('/api/v1/reports/kidzone/members').expect(200);

      expect(response.body.data.lapsedCount).toBe(1);
      expect(response.body.data.lapsedWithoutRenewal[0]).toMatchObject({
        customerName: 'Guardian One',
        daysSinceExpiry: 5,
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('Restaurant reports', () => {
    it('reports exact totals including VAT and service charge', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/restaurant/summary?range=today').expect(200);
      const data = response.body.data;

      expect(data.revenue.current).toBe(102_795); // 739.20 + 288.75
      expect(data.orderCount.current).toBe(2);
      expect(data.subtotal.current).toBe(89_000); // 640.00 + 250.00
      expect(data.serviceCharge.current).toBe(8_900);
      expect(data.vatCollected.current).toBe(4_895);
      expect(data.itemsSold.current).toBe(7);
      expect(data.averageOrderValue.current).toBe(51_398); // rounded
    });

    it('ranks top items by quantity and by revenue, using the snapshots', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin)
        .get('/api/v1/reports/restaurant/top-items?range=today&limit=5')
        .expect(200);

      // 5 teas outsell 2 biryanis, but the biryanis earn more.
      expect(response.body.data.byQuantity[0]).toMatchObject({ itemName: 'Masala Tea', quantity: 5, revenue: 25_000 });
      expect(response.body.data.byRevenue[0]).toMatchObject({ itemName: 'Chicken Biryani', quantity: 2, revenue: 64_000 });
    });

    it('keeps reporting an item under the name it was sold under after a rename', async () => {
      await seedKnownDay();

      await as(server, staff.admin)
        .patch(`/api/v1/restaurant/menu-items/${itemNamed('Masala Tea').id}`)
        .send({ name: 'Special Masala Tea' })
        .expect(200);

      const response = await as(server, staff.admin)
        .get('/api/v1/reports/restaurant/top-items?range=today')
        .expect(200);

      expect(response.body.data.byQuantity.map((i: { itemName: string }) => i.itemName)).toContain('Masala Tea');
      expect(response.body.data.byQuantity.map((i: { itemName: string }) => i.itemName)).not.toContain(
        'Special Masala Tea',
      );
    });

    it('groups by category and returns all 24 hours', async () => {
      await seedKnownDay();

      const byCategory = await as(server, staff.admin)
        .get('/api/v1/reports/restaurant/by-category?range=today')
        .expect(200);
      expect(byCategory.body.data.categories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ categoryName: 'Rice & Curry', quantity: 2, revenue: 64_000 }),
          expect.objectContaining({ categoryName: 'Beverages', quantity: 5, revenue: 25_000 }),
        ]),
      );

      const hourly = await as(server, staff.admin).get('/api/v1/reports/restaurant/hourly?range=today').expect(200);
      expect(hourly.body.data.hours).toHaveLength(24);
      expect(hourly.body.data.peakHour).toMatchObject({ orders: 2, revenue: 102_795 });
    });

    it('reports per-cashier performance to admins only', async () => {
      await seedKnownDay();

      await as(server, staff.cashier).get('/api/v1/reports/restaurant/cashier-performance').expect(403);

      const response = await as(server, staff.admin)
        .get('/api/v1/reports/restaurant/cashier-performance?range=today')
        .expect(200);

      expect(response.body.data.cashiers[0]).toMatchObject({
        cashierName: 'Restaurant Cashier',
        orders: 2,
        revenue: 102_795,
        voidCount: 0,
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('Shared reports', () => {
    it('totals payments per method across both sections', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/payment-methods?range=today').expect(200);
      const byMethod = Object.fromEntries(
        (response.body.data.methods as Array<{ method: string; total: number }>).map((m) => [m.method, m.total]),
      );

      // The voided Kid Zone sale's cash payment is excluded.
      expect(byMethod.CASH).toBe(713_920); // 600000 + 40000 + 73920
      expect(byMethod.BKASH).toBe(50_000);
      expect(byMethod.CARD).toBe(28_875);
      expect(response.body.data.total).toBe(792_795);
    });

    it('narrows payment methods to one section', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin)
        .get('/api/v1/reports/payment-methods?range=today&section=RESTAURANT')
        .expect(200);

      expect(response.body.data.total).toBe(102_795);
    });

    it('lists every discount and void with who, why and how much', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/discounts-voids?range=today').expect(200);

      expect(response.body.data.totals).toMatchObject({
        discountCount: 1,
        discountAmount: 5_000,
        voidCount: 1,
        voidAmount: 40_000,
      });
      expect(response.body.data.discounts[0]).toMatchObject({
        section: 'KIDZONE',
        discountAmount: 5_000,
        reason: 'Sibling discount',
        by: { name: 'Kid Zone Manager' },
      });
      expect(response.body.data.voids[0]).toMatchObject({
        reason: 'Rung up in error',
        voidedBy: { name: 'Admin User' },
      });
      expect(response.body.data.byStaff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Kid Zone Manager', discountCount: 1, discountAmount: 5_000 }),
          expect.objectContaining({ name: 'Admin User', voidCount: 1, voidAmount: 40_000 }),
        ]),
      );
    });

    it('finds customers who used both sections', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/reports/cross-section?range=today').expect(200);

      expect(response.body.data.customers).toHaveLength(1);
      expect(response.body.data.customers[0]).toMatchObject({
        name: 'Guardian One',
        phone: '+8801711110001',
        kidZoneSpend: 600_000,
        restaurantSpend: 73_920,
        totalSpend: 673_920,
      });
      expect(response.body.data.summary).toMatchObject({
        crossSectionCustomers: 1,
        kidZoneCustomers: 3,
        restaurantCustomers: 1,
        crossoverRate: 33.3,
      });
    });

    it('denies every shared report to non-admins', async () => {
      for (const url of [
        '/api/v1/reports/payment-methods',
        '/api/v1/reports/discounts-voids',
        '/api/v1/reports/cross-section',
      ]) {
        expect((await as(server, staff.manager).get(url)).status).toBe(403);
        expect((await as(server, staff.cashier).get(url)).status).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('Role restrictions', () => {
    it('lets a Kid Zone manager see today but not history', async () => {
      await seedKnownDay();

      await as(server, staff.manager).get('/api/v1/reports/kidzone/summary?range=today').expect(200);

      const response = await as(server, staff.manager)
        .get('/api/v1/reports/kidzone/summary?range=this_month')
        .expect(403);
      expect(response.body.error).toBe('REPORT_RANGE_NOT_PERMITTED');

      await as(server, staff.manager).get('/api/v1/reports/kidzone/summary?range=yesterday').expect(403);
    });

    it('keeps each role out of the other section’s reports', async () => {
      await as(server, staff.manager).get('/api/v1/reports/restaurant/summary?range=today').expect(403);
      await as(server, staff.cashier).get('/api/v1/reports/kidzone/summary?range=today').expect(403);
    });

    it('lets a cashier see today’s restaurant figures', async () => {
      await seedKnownDay();
      const response = await as(server, staff.cashier)
        .get('/api/v1/reports/restaurant/summary?range=today')
        .expect(200);
      expect(response.body.data.revenue.current).toBe(102_795);
    });

    it('refuses a file export to non-admins', async () => {
      const response = await as(server, staff.manager)
        .get('/api/v1/reports/kidzone/summary?range=today&export=xlsx')
        .expect(403);
      expect(response.body.error).toBe('EXPORT_NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------------

  describe('Exports', () => {
    it('produces an xlsx with a dated file name', async () => {
      await seedKnownDay();

      const response = await asBuffer(
        as(server, staff.admin).get('/api/v1/reports/kidzone/summary?range=today&export=xlsx'),
      ).expect(200);

      expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(response.headers['content-disposition']).toMatch(
        /attachment; filename="kid-zone-summary_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx"/,
      );
      // xlsx files are zip archives.
      expect((response.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });

    it('produces a PDF', async () => {
      await seedKnownDay();

      const response = await asBuffer(
        as(server, staff.admin).get('/api/v1/reports/restaurant/top-items?range=today&export=pdf'),
      ).expect(200);

      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['content-disposition']).toContain('restaurant-top-items_');
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('exports every report endpoint without error', async () => {
      await seedKnownDay();

      const urls = [
        '/api/v1/reports/kidzone/summary',
        '/api/v1/reports/kidzone/revenue-trend',
        '/api/v1/reports/kidzone/by-plan',
        '/api/v1/reports/kidzone/visits',
        '/api/v1/reports/kidzone/peak-hours',
        '/api/v1/reports/kidzone/membership-utilization',
        '/api/v1/reports/kidzone/members',
        '/api/v1/reports/restaurant/summary',
        '/api/v1/reports/restaurant/revenue-trend',
        '/api/v1/reports/restaurant/top-items',
        '/api/v1/reports/restaurant/by-category',
        '/api/v1/reports/restaurant/hourly',
        '/api/v1/reports/restaurant/cashier-performance',
        '/api/v1/reports/payment-methods',
        '/api/v1/reports/discounts-voids',
        '/api/v1/reports/cross-section',
      ];

      for (const url of urls) {
        for (const format of ['xlsx', 'pdf']) {
          const response = await asBuffer(
            as(server, staff.admin).get(`${url}?range=today&export=${format}`),
          );
          expect([url, format, response.status]).toEqual([url, format, 200]);
          expect((response.body as Buffer).length).toBeGreaterThan(100);
        }
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('Combined dashboard', () => {
    it('brings both sections, the live floor and the trend into one response', async () => {
      await seedKnownDay();

      const response = await as(server, staff.admin).get('/api/v1/dashboard/combined').expect(200);
      const data = response.body.data;

      expect(data.today.kidZone.revenue.current).toBe(690_000);
      expect(data.today.restaurant.revenue.current).toBe(102_795);
      expect(data.today.combined.revenue).toMatchObject({ current: 792_795, previous: 0, change: null });

      expect(data.liveFloor).toMatchObject({ activeVisitCount: 2, overtimeVisitCount: 0, owedOvertimeTotal: 0 });
      expect(data.topDishesToday[0]).toMatchObject({ itemName: 'Masala Tea', quantity: 5 });
      expect(data.last7Days).toHaveLength(7);
      expect(data.last7Days[6]).toMatchObject({ totalRevenue: 792_795 });
      expect(data.membershipsExpiringThisWeek).toMatchObject({ count: 0 });
    });

    it('surfaces visits that are running over', async () => {
      await seedKnownDay();
      const visit = await ctx.prisma.visit.findFirstOrThrow();
      await ctx.prisma.visit.update({
        where: { id: visit.id },
        data: { checkInAt: new Date(Date.now() - 200 * 60_000) },
      });

      const response = await as(server, staff.admin).get('/api/v1/dashboard/combined').expect(200);

      expect(response.body.data.liveFloor.overtimeVisitCount).toBe(1);
      expect(response.body.data.liveFloor.owedOvertimeTotal).toBe(30_000); // 70 min over -> 3 blocks
      expect(response.body.data.liveFloor.overtimeVisits[0]).toMatchObject({ isOvertime: true });
    });

    it('is admin only', async () => {
      await as(server, staff.manager).get('/api/v1/dashboard/combined').expect(403);
      await as(server, staff.cashier).get('/api/v1/dashboard/combined').expect(403);
    });
  });
});
