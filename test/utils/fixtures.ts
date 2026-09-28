import { Role } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '@/prisma/prisma.service';
import { PasswordService } from '@modules/auth/password.service';
import { TestContext } from './test-app';

export const TEST_PASSWORD = 'Test#2026pass';

export interface SeededUser {
  id: string;
  name: string;
  phone: string;
  email: string;
  role: Role;
  accessToken: string;
  refreshCookie: string;
}

/** Creates a staff account directly in the database, bypassing the API. */
export async function createUser(
  prisma: PrismaService,
  passwords: PasswordService,
  overrides: { role: Role; phone: string; name?: string; email?: string; isActive?: boolean },
): Promise<{ id: string; phone: string; email: string; role: Role }> {
  const email = overrides.email ?? `${overrides.phone.slice(-6)}@kidzone.test`;
  const user = await prisma.user.create({
    data: {
      name: overrides.name ?? `${overrides.role} user`,
      phone: overrides.phone,
      email,
      passwordHash: await passwords.hash(TEST_PASSWORD),
      role: overrides.role,
      isActive: overrides.isActive ?? true,
    },
  });
  return { id: user.id, phone: user.phone, email: email, role: user.role };
}

/** Logs in over HTTP and returns the access token plus the refresh cookie. */
export async function login(
  app: App,
  identifier: string,
  password: string = TEST_PASSWORD,
): Promise<{ accessToken: string; refreshCookie: string; body: Record<string, any> }> {
  const response = await request(app).post('/api/v1/auth/login').send({ identifier, password }).expect(200);

  const setCookie = response.headers['set-cookie'] as unknown as string[] | undefined;
  const refreshCookie = (setCookie ?? []).find((c) => c.startsWith('kz_refresh=')) ?? '';

  return {
    accessToken: response.body.data.accessToken as string,
    refreshCookie: refreshCookie.split(';')[0],
    body: response.body,
  };
}

/** Creates the three standard roles and logs each of them in. */
export async function seedStaff(ctx: TestContext): Promise<Record<'admin' | 'manager' | 'cashier', SeededUser>> {
  const passwords = ctx.app.get(PasswordService);
  const server = ctx.app.getHttpServer() as App;

  const definitions = [
    { key: 'admin' as const, role: Role.ADMIN, phone: '+8801711111111', name: 'Admin User' },
    { key: 'manager' as const, role: Role.KIDZONE_MANAGER, phone: '+8801722222222', name: 'Kid Zone Manager' },
    { key: 'cashier' as const, role: Role.RESTAURANT_CASHIER, phone: '+8801733333333', name: 'Restaurant Cashier' },
  ];

  const out = {} as Record<'admin' | 'manager' | 'cashier', SeededUser>;

  for (const def of definitions) {
    const user = await createUser(ctx.prisma, passwords, { role: def.role, phone: def.phone, name: def.name });
    const session = await login(server, def.phone);
    out[def.key] = { ...user, name: def.name, accessToken: session.accessToken, refreshCookie: session.refreshCookie };
  }

  return out;
}

/** Convenience wrapper: an authenticated supertest agent for one user. */
export function as(app: App, user: SeededUser) {
  const agent = request(app);
  return {
    get: (url: string) => agent.get(url).set('Authorization', `Bearer ${user.accessToken}`),
    post: (url: string) => request(app).post(url).set('Authorization', `Bearer ${user.accessToken}`),
    patch: (url: string) => request(app).patch(url).set('Authorization', `Bearer ${user.accessToken}`),
    put: (url: string) => request(app).put(url).set('Authorization', `Bearer ${user.accessToken}`),
    delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${user.accessToken}`),
  };
}
