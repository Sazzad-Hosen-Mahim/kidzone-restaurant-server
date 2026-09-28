import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '@prisma/client';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, TEST_PASSWORD, as, login, seedStaff } from './utils/fixtures';

describe('Auth (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('POST /auth/login', () => {
    it('logs in with a phone number and returns a token plus an httpOnly cookie', async () => {
      const response = await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01711111111', password: TEST_PASSWORD })
        .expect(200);

      expect(response.body.data).toMatchObject({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: expect.any(Number),
        user: { phone: '+8801711111111', role: Role.ADMIN },
      });
      expect(response.body.meta).toHaveProperty('timestamp');
      expect(response.body.data.user).not.toHaveProperty('passwordHash');

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const refresh = cookies.find((c) => c.startsWith('kz_refresh='));
      expect(refresh).toBeDefined();
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toContain('Path=/api/v1/auth');
    });

    it('accepts an email address as the identifier', async () => {
      await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: staff.admin.email, password: TEST_PASSWORD })
        .expect(200);
    });

    it('rejects a wrong password and an unknown account with the same message', async () => {
      const wrongPassword = await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01711111111', password: 'Wrong#2026pass' })
        .expect(401);

      const unknownUser = await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01799999999', password: TEST_PASSWORD })
        .expect(401);

      expect(wrongPassword.body.message).toBe('Invalid credentials');
      expect(unknownUser.body.message).toBe('Invalid credentials');
      expect(wrongPassword.body).toMatchObject({ statusCode: 401, error: expect.any(String) });
    });

    it('rejects a deactivated account', async () => {
      await ctx.prisma.user.update({ where: { id: staff.cashier.id }, data: { isActive: false } });

      await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: staff.cashier.phone, password: TEST_PASSWORD })
        .expect(401);
    });

    it('rejects a body with an unknown property', async () => {
      const response = await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01711111111', password: TEST_PASSWORD, isAdmin: true })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_FAILED');
      expect(response.body.details.errors.join(' ')).toContain('isAdmin');
    });

    it('records both the success and the failure in the audit log', async () => {
      await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01711111111', password: 'Wrong#2026pass' })
        .expect(401);

      const actions = await ctx.prisma.auditLog.findMany({ select: { action: true } });
      expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['LOGIN', 'LOGIN_FAILED']));
    });
  });

  describe('GET /auth/me', () => {
    it('returns the caller profile', async () => {
      const response = await as(server, staff.manager).get('/api/v1/auth/me').expect(200);

      expect(response.body.data).toMatchObject({
        id: staff.manager.id,
        role: Role.KIDZONE_MANAGER,
        phone: '+8801722222222',
      });
    });

    it('rejects a missing or malformed token', async () => {
      await request(server).get('/api/v1/auth/me').expect(401);
      await request(server).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-token').expect(401);
    });

    it('rejects a token belonging to a user deactivated after the token was issued', async () => {
      await as(server, staff.cashier).get('/api/v1/auth/me').expect(200);

      await ctx.prisma.user.update({ where: { id: staff.cashier.id }, data: { isActive: false } });

      const response = await as(server, staff.cashier).get('/api/v1/auth/me').expect(401);
      expect(response.body.message).toMatch(/no longer active/i);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token and issues a new access token', async () => {
      const first = await login(server, staff.admin.phone);

      const response = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', first.refreshCookie)
        .expect(200);

      expect(response.body.data.accessToken).toEqual(expect.any(String));

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const rotated = cookies.find((c) => c.startsWith('kz_refresh='));
      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(first.refreshCookie);
    });

    it('refuses a refresh token that has already been rotated, and kills every session', async () => {
      const first = await login(server, staff.admin.phone);
      await request(server).post('/api/v1/auth/refresh').set('Cookie', first.refreshCookie).expect(200);

      // Replaying the original token is treated as theft.
      const replay = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', first.refreshCookie)
        .expect(401);
      expect(replay.body.message).toMatch(/already been used/i);

      const live = await ctx.prisma.refreshToken.count({ where: { userId: staff.admin.id, revokedAt: null } });
      expect(live).toBe(0);
    });

    it('refuses to refresh a deactivated account', async () => {
      const session = await login(server, staff.cashier.phone);
      await ctx.prisma.user.update({ where: { id: staff.cashier.id }, data: { isActive: false } });

      const response = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', session.refreshCookie)
        .expect(401);
      expect(response.body.message).toMatch(/no longer active/i);
    });

    it('refuses an access token presented as a refresh token', async () => {
      await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `kz_refresh=${staff.admin.accessToken}`)
        .expect(401);
    });

    it('requires a cookie', async () => {
      await request(server).post('/api/v1/auth/refresh').expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the presented refresh token', async () => {
      const session = await login(server, staff.admin.phone);

      await request(server)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .set('Cookie', session.refreshCookie)
        .expect(200);

      await request(server).post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie).expect(401);
    });
  });

  describe('PATCH /auth/change-password', () => {
    it('changes the password and revokes every session', async () => {
      const session = await login(server, staff.manager.phone);

      await request(server)
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'Brand#New2027' })
        .expect(200);

      await request(server).post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie).expect(401);
      await login(server, staff.manager.phone, 'Brand#New2027');
    });

    it('rejects a wrong current password', async () => {
      const response = await as(server, staff.manager)
        .patch('/api/v1/auth/change-password')
        .send({ currentPassword: 'Nope#2026pass', newPassword: 'Brand#New2027' })
        .expect(400);

      expect(response.body.error).toBe('CURRENT_PASSWORD_INCORRECT');
    });

    it('rejects reusing the same password', async () => {
      const response = await as(server, staff.manager)
        .patch('/api/v1/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
        .expect(400);

      expect(response.body.error).toBe('PASSWORD_UNCHANGED');
    });

    it('enforces the password policy', async () => {
      await as(server, staff.manager)
        .patch('/api/v1/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'alllowercase' })
        .expect(400);
    });
  });

});
