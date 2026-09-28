export interface PostgresConnection {
  host: string;
  port: string;
  user: string;
  password?: string;
  database: string;
}

/**
 * Splits a `postgresql://user:pass@host:port/db` URL into the pieces the
 * `pg_dump` / `pg_restore` command line wants.
 *
 * The split exists so the password can travel in `PGPASSWORD` while everything
 * else goes in argv: a connection URI on the command line would put the
 * password in the process list, where any other user on the host can read it.
 *
 * (Passing the URI in `PGDATABASE` does not work — libpq treats that variable
 * as a plain database name, not as a connection string.)
 */
export function parsePostgresUrl(url: string): PostgresConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`Expected a postgresql:// URL, got "${parsed.protocol}//"`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('DATABASE_URL does not name a database');
  }

  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database,
  };
}

/** `host:port/database` — safe to log, since the password is left out. */
export function describePostgresUrl(url: string): string {
  try {
    const { host, port, database } = parsePostgresUrl(url);
    return `${host}:${port}/${database}`;
  } catch {
    return '(unparseable database URL)';
  }
}
