import fs from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { BOOTSTRAP_SQL, MIGRATIONS } from './migrations';

/**
 * One Postgres, two ways to reach it: `DATABASE_URL` for a server, embedded
 * PGlite otherwise (`VERT_PGLITE_DIR`, default `.vert-pg`; `VERT_DB=memory` for
 * a throwaway in-memory database in tests). Both speak the same pg-core dialect,
 * so callers take a `Db` and never know which one they got.
 */
export type Db = PgDatabase<QueryResultHKT, typeof schema>;

/** What both drivers return from `db.execute`: at least the rows. */
export interface QueryResultHKT extends PgQueryResultHKT {
  type: QueryRows<Assume<this['row'], Record<string, unknown>>>;
}
interface QueryRows<T> {
  rows: T[];
}
type Assume<T, U> = T extends U ? T : U;

interface Handle {
  db: Db;
  /** Where the data lives, for log lines and error messages. */
  location: string;
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __vertDb: Promise<Handle> | undefined;
}

/** The process-wide database, opened and migrated on first use. */
export async function getDb(): Promise<Db> {
  return (await handle()).db;
}

/** Closes the database and forgets it; the next getDb() opens a fresh one. */
export async function closeDb(): Promise<void> {
  const pending = globalThis.__vertDb;
  globalThis.__vertDb = undefined;
  if (!pending) return;
  const handle = await pending.catch(() => null);
  await handle?.close();
}

/** Human-readable location of the current database, e.g. for the seed script. */
export async function dbLocation(): Promise<string> {
  return (await handle()).location;
}

function handle(): Promise<Handle> {
  // Cached on globalThis so Next's HMR and its separate server bundles share one
  // connection; a second PGlite on the same directory would corrupt it.
  globalThis.__vertDb ??= open().catch((err: unknown) => {
    globalThis.__vertDb = undefined;
    throw err;
  });
  return globalThis.__vertDb;
}

async function open(): Promise<Handle> {
  const url = process.env.DATABASE_URL;
  if (url) return openPostgres(url);
  if (process.env.VERT_DB === 'memory') return openPglite(null);
  return openPglite(path.resolve(process.env.VERT_PGLITE_DIR ?? '.vert-pg'));
}

async function openPostgres(url: string): Promise<Handle> {
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.Pool({ connectionString: url });
  // An idle client dropping its connection must not take the process down; the pool replaces it.
  pool.on('error', (err) => console.error('[vert] postgres pool error:', err.message));
  const client = await pool.connect();
  try {
    // Several app instances may boot at once; one migrates, the rest wait.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate({
        exec: async (sql) => void (await client.query(sql)),
        query: async (sql, params) => (await client.query(sql, params)).rows,
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } catch (err) {
    client.release();
    await pool.end();
    throw err;
  }
  client.release();
  return { db: drizzle(pool, { schema }), location: describeUrl(url), close: () => pool.end() };
}

/** host/database without credentials. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'DATABASE_URL';
  }
}

async function openPglite(dir: string | null): Promise<Handle> {
  const release = dir ? lockDataDir(dir) : () => {};
  try {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const client = dir ? await PGlite.create(dir) : await PGlite.create();
    try {
      await migrate({
        exec: async (sql) => void (await client.exec(sql)),
        query: async (sql, params) => (await client.query<Record<string, unknown>>(sql, params)).rows,
      });
    } catch (err) {
      await client.close();
      throw err;
    }
    return {
      db: drizzle(client, { schema }),
      location: dir ?? 'memory',
      close: async () => {
        await client.close();
        release();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

// ------------------------------------------------------------------ migrations

const MIGRATION_LOCK_KEY = 72_917_301;

interface SqlClient {
  /** Runs one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Applies every MIGRATIONS entry this database has not seen, in order, each in its own transaction. */
export async function migrate(client: SqlClient): Promise<string[]> {
  await client.exec(BOOTSTRAP_SQL);
  const applied = new Set((await client.query('SELECT id FROM schema_migrations')).map((r) => String(r.id)));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await client.exec('BEGIN');
    try {
      await client.exec(m.sql);
      await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [m.id, Date.now()]);
      await client.exec('COMMIT');
    } catch (err) {
      await client.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    ran.push(m.id);
  }
  return ran;
}

// ------------------------------------------------------------------ PGlite directory lock

const LOCK_FILE = 'vert.lock';

/** Raised when another live process already has the PGlite directory open. */
export class DbLockedError extends Error {
  readonly code = 'DB_LOCKED';
  constructor(
    readonly dir: string,
    readonly pid: number,
  ) {
    super(
      `The embedded database at ${dir} is open in another process (pid ${pid}), most likely the dev server. ` +
        'PGlite is single-process: stop the dev server and run this again, or reseed the running app with POST /api/dev/reset. ' +
        `If pid ${pid} is not Vert, delete ${path.join(dir, LOCK_FILE)}.`,
    );
    this.name = 'DbLockedError';
  }
}

/**
 * PGlite has no cross-process locking, and two processes writing one directory
 * corrupt it. A pid file claims the directory; a holder that has exited is stale.
 */
function lockDataDir(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      const holder = Number(fs.readFileSync(file, 'utf8').trim());
      // Our own pid is a leftover too: getDb opens once per process, and containers reuse pids.
      if (holder && holder !== process.pid && isAlive(holder)) throw new DbLockedError(dir, holder);
      fs.rmSync(file, { force: true });
    }
  }
  const release = () => {
    try {
      if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
  process.once('exit', release);
  return () => {
    process.off('exit', release);
    release();
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export { schema };
