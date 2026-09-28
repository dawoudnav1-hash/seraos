import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { RunEvent } from '@/lib/domain/reducer';

// Timestamps are epoch milliseconds. bigint in 'number' mode is exact up to 2^53,
// which covers both timestamps and cents.
const epochMs = (name: string) => bigint(name, { mode: 'number' });

// ------------------------------------------------------------------ runs

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  task: text('task').notNull(),
  client: text('client').notNull().default(''),
  status: text('status').notNull(),
  agent: text('agent').notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

/** The append-only log every run is folded from. `seq` is gapless per run. */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<RunEvent>().notNull(),
    at: epochMs('at')
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (t) => ({ byRun: uniqueIndex('run_events_run_idx').on(t.runId, t.seq) }),
);

/** Every ledger post must be recorded here with an approving human before it lands. */
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason'),
  decidedBy: text('decided_by').notNull(),
  decidedAt: epochMs('decided_at').notNull(),
});

export const ledgerPostings = pgTable('ledger_postings', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  approvalId: text('approval_id').notNull(),
  memo: text('memo').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  postedAt: epochMs('posted_at').notNull(),
  /** 'quickbooks' | 'xero' once a connector posts it; null for the mock ledger. */
  provider: text('provider'),
  externalId: text('external_id'),
  /** The same key never posts twice. */
  idempotencyKey: text('idempotency_key').unique(),
});

// ------------------------------------------------------------------ datasets

export const datasets = pgTable('datasets', {
  id: text('id').primaryKey(),
  client: text('client').notNull(),
  name: text('name').notNull(),
  source: text('source').notNull(),
  columns: jsonb('columns').notNull(),
  rowCount: integer('row_count').notNull(),
  createdAt: epochMs('created_at').notNull(),
});

export const datasetRows = pgTable(
  'dataset_rows',
  {
    datasetId: text('dataset_id').notNull(),
    idx: integer('idx').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.datasetId, t.idx] }) }),
);

// ------------------------------------------------------------------ context graph

export const graphNodes = pgTable(
  'graph_nodes',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
    client: text('client').notNull().default(''),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => ({ byClientKind: index('graph_nodes_client_kind_idx').on(t.client, t.kind) }),
);

export const graphEdges = pgTable(
  'graph_edges',
  {
    id: text('id').primaryKey(),
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    kind: text('kind').notNull(),
    props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
    runId: text('run_id'),
    stepId: text('step_id'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => ({
    byFrom: index('graph_edges_from_idx').on(t.fromId),
    byTo: index('graph_edges_to_idx').on(t.toId),
  }),
);

// ------------------------------------------------------------------ memory and learning

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    /** 'process' | 'historical' | 'user' | 'semantic' */
    kind: text('kind').notNull(),
    client: text('client').notNull().default(''),
    userId: text('user_id').notNull().default(''),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    confidence: real('confidence').notNull().default(1),
    source: text('source').notNull().default(''),
    hits: integer('hits').notNull().default(0),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => ({ byKey: unique('memories_kind_client_user_key_uq').on(t.kind, t.client, t.userId, t.key) }),
);

export const learnedRules = pgTable('learned_rules', {
  id: text('id').primaryKey(),
  client: text('client').notNull(),
  kind: text('kind').notNull(),
  pattern: jsonb('pattern').notNull(),
  action: jsonb('action').notNull(),
  /** 'candidate' | 'promoted' | 'rejected' */
  status: text('status').notNull(),
  confirmations: integer('confirmations').notNull().default(0),
  rejections: integer('rejections').notNull().default(0),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

// ------------------------------------------------------------------ integrations

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    client: text('client').notNull(),
    externalId: text('external_id'),
    /** Encrypted at rest by the connector; never stored in the clear. */
    tokensEnc: text('tokens_enc'),
    status: text('status').notNull(),
    scopes: text('scopes'),
    connectedAt: epochMs('connected_at'),
    updatedAt: epochMs('updated_at').notNull(),
    lastSyncAt: epochMs('last_sync_at'),
  },
  (t) => ({ byClient: unique('integrations_provider_client_uq').on(t.provider, t.client) }),
);

// ------------------------------------------------------------------ bookkeeping

/** Which entries of MIGRATIONS have been applied to this database. */
export const schemaMigrations = pgTable('schema_migrations', {
  id: text('id').primaryKey(),
  appliedAt: epochMs('applied_at').notNull(),
});
