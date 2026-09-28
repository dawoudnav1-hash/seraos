import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'node:path';
import * as schema from './schema';

const DB_PATH = process.env.VERT_DB ?? path.join(process.cwd(), 'vert.db');

function createDb() {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

export function migrate(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, task TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, agent TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL DEFAULT (unixepoch() * 1000));
    CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id, seq);
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
      decided_by TEXT NOT NULL, decided_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_postings (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, approval_id TEXT NOT NULL, memo TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, posted_at INTEGER NOT NULL);
  `);
  const cols = sqlite.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'client')) {
    sqlite.exec(`ALTER TABLE runs ADD COLUMN client TEXT NOT NULL DEFAULT ''`);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __vertDb: ReturnType<typeof createDb> | undefined;
}

export const db = globalThis.__vertDb ?? createDb();
if (process.env.NODE_ENV !== 'production') globalThis.__vertDb = db;
export { schema };
