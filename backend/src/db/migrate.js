import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(here, '../../db/migrations');

/** Apply ordered SQL migrations once, detecting edits to migrations already applied. */
export async function runMigrations(pool, migrationsDirectory = DEFAULT_MIGRATIONS_DIR) {
  const files = (await readdir(migrationsDirectory))
    .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((a, b) => Number(a.match(/^\d+/)[0]) - Number(b.match(/^\d+/)[0]));
  const versions = new Set();
  for (const name of files) {
    const version = Number(name.match(/^\d+/)[0]);
    if (versions.has(version)) throw new Error(`duplicate migration version ${version}`);
    versions.add(version);
  }

  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('edge-offloading-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const name of files) {
      const version = Number(name.match(/^\d+/)[0]);
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = await client.query('SELECT name, checksum FROM schema_migrations WHERE version = $1', [version]);
      if (prior.rowCount) {
        if (prior.rows[0].name !== name || prior.rows[0].checksum !== checksum) {
          throw new Error(`applied migration ${version} does not match file ${name}; add a new migration instead of editing it`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)',
          [version, name, checksum],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('edge-offloading-migrations'))");
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createDatabasePool } = await import('./pool.js');
  const pool = createDatabasePool();
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date.');
  } finally {
    await pool.end();
  }
}
