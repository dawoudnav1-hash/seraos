import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  task: text('task').notNull(),
  client: text('client').notNull().default(''),
  status: text('status').notNull(),
  agent: text('agent').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    at: integer('at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ byRun: index('run_events_run_idx').on(t.runId, t.seq) }),
);

/** Every ledger post must be recorded here with an approving human before it lands. */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason'),
  decidedBy: text('decided_by').notNull(),
  decidedAt: integer('decided_at').notNull(),
});

export const ledgerPostings = sqliteTable('ledger_postings', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  approvalId: text('approval_id').notNull(),
  memo: text('memo').notNull(),
  amountCents: integer('amount_cents').notNull(),
  postedAt: integer('posted_at').notNull(),
});
