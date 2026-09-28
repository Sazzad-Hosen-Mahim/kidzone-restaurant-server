import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '@prisma/client';
import { PasswordService } from '@modules/auth/password.service';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { TEST_PASSWORD, createUser } from './utils/fixtures';

/**
 * The one suite that runs with rate limiting switched on. It lives in its own
 * file so the shared 5-attempts-per-minute login bucket cannot leak into the
 * other suites, which log in several times per test.
 */
describe('Rate limiting (e2e)', () => {
  let ctx: TestContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp({ throttle: true });
    server = ctx.app.getHttpServer() as App;
    await resetDatabase(ctx);
    await createUser(ctx.prisma, ctx.app.get(PasswordService), { role: Role.ADMIN, phone: '+8801755555555' });
  });

  afterAll(async () => {
    await ctx.close();
    process.env.THROTTLE_ENABLED = 'false';
  });

  it('blocks login after 5 failed attempts within a minute', async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await request(server)
        .post('/api/v1/auth/login')
        .send({ identifier: '01755555555', password: 'Wrong#2026pass' });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    expect(statuses[6]).toBe(429);
  });

  it('returns the standard error envelope with a stable code when throttled', async () => {
    const response = await request(server)
      .post('/api/v1/auth/login')
      .send({ identifier: '01755555555', password: TEST_PASSWORD });

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      statusCode: 429,
      error: 'TOO_MANY_LOGIN_ATTEMPTS',
      message: expect.stringContaining('Too many'),
    });
  });
});
