import pg from 'pg';

const { Pool } = pg;

/** Create a PostgreSQL pool. Connection settings use DATABASE_URL or standard PG* environment variables. */
export function createDatabasePool(options = {}) {
  const sslFlag = process.env.PGSSL;
  if (sslFlag !== undefined && !['true', 'false'].includes(sslFlag.toLowerCase())) {
    throw new TypeError('PGSSL must be "true" or "false" when set');
  }
  const ssl = options.ssl ?? (sslFlag?.toLowerCase() === 'true' ? { rejectUnauthorized: true } : false);
  return new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    ssl,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'edge-offloading',
    ...options,
  });
}

/** Run work in one transaction and roll back before rethrowing any failure. */
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
