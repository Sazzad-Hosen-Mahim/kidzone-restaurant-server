import request from 'supertest';
import { TestContext, createTestApp } from './utils/test-app';

describe('Health (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /health reports the database and Redis without authentication', async () => {
    const response = await request(ctx.app.getHttpServer()).get('/health');

    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('info.database.status', 'up');
    expect(response.body.details).toHaveProperty('redis');
    // The health probe is outside the { data, meta } envelope on purpose.
    expect(response.body).not.toHaveProperty('data');
  });

  it('rejects an Origin that is not on the CORS allow-list', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://not-allowed.example.com');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows an Origin from the configured allow-list, with credentials', async () => {
    const allowed = ctx.config.corsOrigins[0];
    const response = await request(ctx.app.getHttpServer()).get('/health').set('Origin', allowed);

    expect(response.headers['access-control-allow-origin']).toBe(allowed);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('returns the global error envelope for an unknown route', async () => {
    const response = await request(ctx.app.getHttpServer()).get('/api/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      error: expect.any(String),
      message: expect.any(String),
    });
  });
});
