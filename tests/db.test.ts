import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asc, eq, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { useTestDb } from './setup-db';

const db = await useTestDb();
const { closeDb, getDb, schema, DbLockedError } = await import('@/lib/db');
const { MIGRATIONS } = await import('@/lib/db/migrations');
const store = await import('@/lib/agents/store');

let runSeq = 0;
async function newRun() {
  const id = `run_db_${Date.now().toString(36)}_${++runSeq}`;
  return store.createRun({ id, title: 'Cash forecast', task: 'forecast', agent: 'CashAgent' });
}

describe('schema', () => {
  const tables = Object.values(schema).filter((t) => is(t, PgTable)) as PgTable[];

  it('applies every migration and records it', async () => {
    const rows = await db.select().from(schema.schemaMigrations).orderBy(asc(schema.schemaMigrations.id));
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('matches the Drizzle schema column for column', async () => {
    const { rows } = await db.execute<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      sql`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = rows
        .filter((r) => r.table_name === config.name)
        .map((r) => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`)
        .sort();
      const expected = config.columns
        .map((c) => `${c.name} ${c.getSQLType().replace('bigserial', 'bigint')}${c.notNull ? ' not null' : ''}`)
        .sort();
      expect(actual, config.name).toEqual(expected);
    }
  });

  it('has every index and unique constraint the schema declares', async () => {
    const { rows } = await db.execute<{ tablename: string; indexname: string }>(
      sql`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    for (const table of tables) {
      const config = getTableConfig(table);
      const expected = [
        ...config.indexes.map((i) => i.config.name),
        ...config.uniqueConstraints.map((u) => u.getName()),
        ...config.primaryKeys.map((p) => p.getName()),
        ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName),
      ];
      const actual = rows.filter((r) => r.tablename === config.name).map((r) => r.indexname);
      for (const name of expected) expect(actual, config.name).toContain(name);
    }
  });
});

describe('event log', () => {
  it('keeps seq gapless and in call order under concurrent appends', async () => {
    const run = await newRun();
    const notes = Array.from({ length: 40 }, (_, i) => `note ${i}`);
    await Promise.all(notes.map((note, i) => store.appendEvent(run.id, { type: 'progress', stepId: 's1', pct: i, note })));
    const rows = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id))
      .orderBy(asc(schema.runEvents.seq));
    expect(rows.map((r) => r.seq)).toEqual(notes.map((_, i) => i + 1));
    expect(rows.map((r) => (r.payload as { note: string }).note)).toEqual(notes);
    expect(await store.getRun(run.id)).toEqual(await store.replayRun(run.id));
  });

  it('serializes read-check-append sequences on one run', async () => {
    const run = await newRun();
    // Two callers race to be first; the lock lets exactly one through.
    const claim = () =>
      store.withRunLock(run.id, async (current, append) => {
        if (current.description === 'claimed') throw new Error('already claimed');
        await new Promise((r) => setTimeout(r, 5));
        return append({ type: 'progress', stepId: 's1', pct: 1, note: 'claimed' });
      });
    const results = await Promise.allSettled([claim(), claim()]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('refolds when the log under a cached run was reset', async () => {
    const run = await newRun();
    for (let i = 1; i <= 3; i++) await store.appendEvent(run.id, { type: 'progress', stepId: 's1', pct: i * 10, note: `old ${i}` });
    expect((await store.getRun(run.id))?.description).toBe('old 3');
    // Another process (npm run seed against a shared Postgres) resets and recreates the run.
    await db.execute(sql`DELETE FROM run_events WHERE run_id = ${run.id}`);
    await db.execute(sql`DELETE FROM runs WHERE id = ${run.id}`);
    await store.createRun({ id: run.id, title: 'Cash forecast', task: 'forecast', agent: 'CashAgent' });
    await db.insert(schema.runEvents).values({ runId: run.id, seq: 1, type: 'progress', payload: { type: 'progress', stepId: 's1', pct: 5, note: 'new 1' }, at: 1 });
    const after = await store.getRun(run.id);
    expect(after?.description).toBe('new 1');
    expect(after?.progressPct).toBe(5);
  });

  it('refuses to append to a run that does not exist', async () => {
    await expect(store.appendEvent('run_missing', { type: 'progress', stepId: 's1', pct: 1, note: 'x' })).rejects.toThrow(/Unknown run/);
  });
});

describe('ledger postings', () => {
  it('never posts the same idempotency key twice', async () => {
    const input = { runId: 'run_idem', approvalId: 'apr_x', memo: 'Payroll', amountCents: 31_200_000, idempotencyKey: 'je-2025-01-payroll' };
    const first = await store.recordPosting(input);
    const second = await store.recordPosting(input);
    expect(second.id).toBe(first.id);
    expect(await store.listPostings('run_idem')).toHaveLength(1);
  });

  it('keeps amounts above 32-bit range exact', async () => {
    await store.recordPosting({ runId: 'run_big', approvalId: 'apr_y', memo: 'Big', amountCents: 9_000_000_000_01 });
    const [row] = await store.listPostings('run_big');
    expect(row.amountCents).toBe(9_000_000_000_01);
  });
});

describe('embedded directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vert-pg-'));

  it('reopens an existing directory without reapplying migrations', { timeout: 60_000 }, async () => {
    await closeDb();
    delete process.env.DATABASE_URL;
    delete process.env.VERT_DB;
    process.env.VERT_PGLITE_DIR = dir;
    const first = await getDb();
    const before = await first.select().from(schema.schemaMigrations);
    await closeDb();
    const again = await getDb();
    expect(await again.select().from(schema.schemaMigrations)).toEqual(before);
    await closeDb();
    expect(fs.existsSync(path.join(dir, 'vert.lock'))).toBe(false);
  });

  it('refuses a directory another live process holds', async () => {
    // The parent process is alive for the whole test run.
    fs.writeFileSync(path.join(dir, 'vert.lock'), String(process.ppid));
    const err = await getDb().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbLockedError);
    expect((err as Error).message).toMatch(/stop the dev server/);
    fs.rmSync(path.join(dir, 'vert.lock'));
  });
});
