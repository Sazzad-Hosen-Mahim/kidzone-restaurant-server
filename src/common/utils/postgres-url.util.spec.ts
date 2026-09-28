import { describePostgresUrl, parsePostgresUrl } from './postgres-url.util';

describe('parsePostgresUrl', () => {
  it('splits a standard connection URL', () => {
    expect(parsePostgresUrl('postgresql://kidzone:secret@db.example.com:5433/kidzone?schema=public')).toEqual({
      host: 'db.example.com',
      port: '5433',
      user: 'kidzone',
      password: 'secret',
      database: 'kidzone',
    });
  });

  it('accepts the postgres:// scheme as well', () => {
    expect(parsePostgresUrl('postgres://u:p@localhost:5432/app').database).toBe('app');
  });

  it('defaults the port when the URL omits it', () => {
    expect(parsePostgresUrl('postgresql://user:pass@localhost/db')).toMatchObject({
      host: 'localhost',
      port: '5432',
      database: 'db',
    });
  });

  it('decodes a percent-encoded password', () => {
    // A password containing @ and / must survive the round trip.
    expect(parsePostgresUrl('postgresql://u:p%40ss%2Fword@localhost:5432/db').password).toBe('p@ss/word');
  });

  it('reports no password when none is given', () => {
    expect(parsePostgresUrl('postgresql://u@localhost:5432/db').password).toBeUndefined();
  });

  it('rejects a non-postgres URL and a URL with no database', () => {
    expect(() => parsePostgresUrl('mysql://u:p@localhost:3306/db')).toThrow(/postgresql/);
    expect(() => parsePostgresUrl('postgresql://u:p@localhost:5432/')).toThrow(/does not name a database/);
    expect(() => parsePostgresUrl('not a url')).toThrow(/not a valid URL/);
  });
});

describe('describePostgresUrl', () => {
  it('never includes the password', () => {
    const described = describePostgresUrl('postgresql://kidzone:sup3rsecret@db.example.com:5433/kidzone');
    expect(described).toBe('db.example.com:5433/kidzone');
    expect(described).not.toContain('sup3rsecret');
  });

  it('degrades gracefully on a malformed URL', () => {
    expect(describePostgresUrl('nonsense')).toBe('(unparseable database URL)');
  });
});
