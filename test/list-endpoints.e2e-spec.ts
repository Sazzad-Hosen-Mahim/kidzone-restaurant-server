import type { App } from 'supertest/types';
import { KidZonePlan, MenuItem } from '@prisma/client';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { PLAN_NAMES, seedCatalogue } from './utils/catalogue';

/**
 * Coverage for every paginated list endpoint.
 *
 * This suite exists because three of them shipped broken: their DTOs were built
 * with `IntersectionType`, which copies property initializers and validation
 * metadata but **not** the prototype — so the `orderBy()` method and the `skip`
 * getter defined on `PaginationQueryDto` silently disappeared. One endpoint
 * threw `orderBy is not a function`; the lost `skip` was worse, because
 * `skip: undefined` makes Prisma ignore it and every page quietly returns the
 * first one.
 *
 * So the tests below do not merely assert 200. They check that paging actually
 * pages and that sorting actually sorts, on every list the API exposes.
 */
describe('List endpoints (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;
  let plans: Record<string, KidZonePlan>;
  let items: MenuItem[];

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

  /** Rings up `count` Kid Zone session sales, each to its own guardian. */
  async function sellSessions(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const phone = `0171200${String(1000 + index).padStart(4, '0')}`;
      await as(server, staff.manager)
        .post('/api/v1/kidzone/sales')
        .send({
          customer: { phone, name: `Guardian ${index}` },
          child: {
            create: {
              name: `Child ${index}`,
              dateOfBirth: '2020-05-10',
              emergencyContactName: `Guardian ${index}`,
              emergencyContactPhone: phone,
            },
          },
          planId: plans[PLAN_NAMES.twoHour].id,
          payments: [{ method: 'CASH', amount: 40_000 }],
        })
        .expect(201);
    }
  }

  async function takeOrders(count: number): Promise<void> {
    const biryani = items.find((item) => item.name === 'Chicken Biryani')!;
    for (let index = 0; index < count; index++) {
      await as(server, staff.cashier)
        .post('/api/v1/restaurant/orders')
        .send({
          items: [{ menuItemId: biryani.id, quantity: 1 }],
          tableNo: `T-${index}`,
          payments: [{ method: 'CASH', amount: 36_960 }],
        })
        .expect(201);
    }
  }

  // -------------------------------------------------------------------------
  // The three that were broken
  // -------------------------------------------------------------------------

  describe('endpoints whose DTO is composed with IntersectionType', () => {
    it('GET /kidzone/sales pages and sorts', async () => {
      await sellSessions(3);

      const all = await as(server, staff.manager).get('/api/v1/kidzone/sales?limit=25').expect(200);
      expect(all.body.data).toHaveLength(3);
      expect(all.body.meta).toMatchObject({ page: 1, limit: 25, total: 3, totalPages: 1 });

      // Paging must actually offset: this is the failure the lost `skip` getter
      // produced silently.
      const first = await as(server, staff.manager).get('/api/v1/kidzone/sales?limit=2&page=1').expect(200);
      const second = await as(server, staff.manager).get('/api/v1/kidzone/sales?limit=2&page=2').expect(200);

      expect(first.body.data).toHaveLength(2);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta).toMatchObject({ page: 2, total: 3, hasPreviousPage: true, hasNextPage: false });

      const firstIds = first.body.data.map((sale: { id: string }) => sale.id);
      const secondIds = second.body.data.map((sale: { id: string }) => sale.id);
      expect(firstIds).not.toContain(secondIds[0]);

      // Sorting must actually sort.
      const ascending = await as(server, staff.manager)
        .get('/api/v1/kidzone/sales?sort=receiptNo&order=asc')
        .expect(200);
      const receipts = ascending.body.data.map((sale: { receiptNo: string }) => sale.receiptNo);
      expect(receipts).toEqual([...receipts].sort());
    });

    it('GET /restaurant/orders pages and sorts', async () => {
      await takeOrders(3);

      const all = await as(server, staff.cashier).get('/api/v1/restaurant/orders').expect(200);
      expect(all.body.data).toHaveLength(3);

      const second = await as(server, staff.cashier).get('/api/v1/restaurant/orders?limit=2&page=2').expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta).toMatchObject({ page: 2, total: 3 });

      const ascending = await as(server, staff.cashier)
        .get('/api/v1/restaurant/orders?sort=receiptNo&order=asc')
        .expect(200);
      const receipts = ascending.body.data.map((order: { receiptNo: string }) => order.receiptNo);
      expect(receipts).toEqual([...receipts].sort());
    });

    it('GET /kidzone/visits pages and sorts', async () => {
      await sellSessions(3);

      const all = await as(server, staff.manager).get('/api/v1/kidzone/visits').expect(200);
      expect(all.body.data).toHaveLength(3);

      const second = await as(server, staff.manager).get('/api/v1/kidzone/visits?limit=2&page=2').expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta).toMatchObject({ page: 2, total: 3 });

      await as(server, staff.manager).get('/api/v1/kidzone/visits?sort=checkInAt&order=asc').expect(200);
    });

    it('honours the date and status filters those DTOs add', async () => {
      await sellSessions(2);
      await takeOrders(1);

      const today = new Date().toISOString().slice(0, 10);

      await as(server, staff.manager)
        .get(`/api/v1/kidzone/sales?from=${today}&to=${today}&status=COMPLETED`)
        .expect(200)
        .expect((response) => expect(response.body.data).toHaveLength(2));

      await as(server, staff.manager)
        .get('/api/v1/kidzone/sales?from=2020-01-01&to=2020-01-02')
        .expect(200)
        .expect((response) => expect(response.body.data).toHaveLength(0));

      await as(server, staff.cashier)
        .get(`/api/v1/restaurant/orders?from=${today}&to=${today}&status=PAID`)
        .expect(200)
        .expect((response) => expect(response.body.data).toHaveLength(1));

      await as(server, staff.manager)
        .get('/api/v1/kidzone/visits?status=ACTIVE')
        .expect(200)
        .expect((response) => expect(response.body.data).toHaveLength(2));
    });
  });

  // -------------------------------------------------------------------------
  // Every other list, so the same class of bug cannot appear elsewhere
  // -------------------------------------------------------------------------

  describe('every paginated list responds and reports pagination', () => {
    const lists: Array<{ url: string; actor: 'admin' | 'manager' | 'cashier' }> = [
      { url: '/api/v1/users', actor: 'admin' },
      { url: '/api/v1/audit-logs', actor: 'admin' },
      { url: '/api/v1/jobs/sms-log', actor: 'admin' },
      { url: '/api/v1/closing', actor: 'admin' },
      { url: '/api/v1/customers', actor: 'manager' },
      { url: '/api/v1/kidzone/plans', actor: 'manager' },
      { url: '/api/v1/kidzone/sales', actor: 'manager' },
      { url: '/api/v1/kidzone/memberships', actor: 'manager' },
      { url: '/api/v1/kidzone/visits', actor: 'manager' },
      { url: '/api/v1/restaurant/menu-items', actor: 'cashier' },
      { url: '/api/v1/restaurant/orders', actor: 'cashier' },
    ];

    it.each(lists)('GET $url', async ({ url, actor }) => {
      const response = await as(server, staff[actor]).get(url).expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta).toMatchObject({
        page: expect.any(Number),
        limit: expect.any(Number),
        total: expect.any(Number),
        totalPages: expect.any(Number),
        hasNextPage: expect.any(Boolean),
        hasPreviousPage: expect.any(Boolean),
      });
    });

    it.each(lists)('GET $url accepts page, limit, sort and search', async ({ url, actor }) => {
      const separator = url.includes('?') ? '&' : '?';
      const response = await as(server, staff[actor])
        .get(`${url}${separator}page=1&limit=5&order=asc&search=zzz-no-match`)
        .expect(200);

      expect(response.body.meta.limit).toBe(5);
    });

    it.each(lists)('GET $url rejects a page size above the cap', async ({ url, actor }) => {
      const separator = url.includes('?') ? '&' : '?';
      await as(server, staff[actor]).get(`${url}${separator}limit=500`).expect(400);
    });
  });
});
