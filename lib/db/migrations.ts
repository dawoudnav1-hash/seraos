/**
 * The ordered DDL every database is brought up to at getDb() init. Applied ids
 * are recorded in schema_migrations, so an entry runs once per database.
 *
 * Append only: never edit or reorder a shipped entry; add a new one instead.
 * Keep lib/db/schema.ts in step (tests/db.test.ts checks the two agree).
 */
import { LEDGER_MIGRATIONS } from '@/lib/ledger/ddl';

const PLATFORM_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '0001_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id text PRIMARY KEY,
        title text NOT NULL,
        task text NOT NULL,
        client text NOT NULL DEFAULT '',
        status text NOT NULL,
        agent text NOT NULL,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id bigserial PRIMARY KEY,
        run_id text NOT NULL,
        seq integer NOT NULL,
        type text NOT NULL,
        payload jsonb NOT NULL,
        at bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
      );
      -- Unique so two writers can never both claim the same seq for a run.
      CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id, seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        decision text NOT NULL,
        reason text,
        decided_by text NOT NULL,
        decided_at bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_postings (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        approval_id text NOT NULL,
        memo text NOT NULL,
        amount_cents bigint NOT NULL,
        posted_at bigint NOT NULL,
        provider text,
        external_id text,
        idempotency_key text CONSTRAINT ledger_postings_idempotency_key_unique UNIQUE
      );
    `,
  },
  {
    id: '0002_datasets',
    sql: `
      CREATE TABLE IF NOT EXISTS datasets (
        id text PRIMARY KEY,
        client text NOT NULL,
        name text NOT NULL,
        source text NOT NULL,
        columns jsonb NOT NULL,
        row_count integer NOT NULL,
        created_at bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_rows (
        dataset_id text NOT NULL,
        idx integer NOT NULL,
        data jsonb NOT NULL,
        CONSTRAINT dataset_rows_dataset_id_idx_pk PRIMARY KEY (dataset_id, idx)
      );
    `,
  },
  {
    id: '0003_context_graph',
    sql: `
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id text PRIMARY KEY,
        kind text NOT NULL,
        label text NOT NULL,
        props jsonb NOT NULL DEFAULT '{}',
        client text NOT NULL DEFAULT '',
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS graph_nodes_client_kind_idx ON graph_nodes (client, kind);
      CREATE TABLE IF NOT EXISTS graph_edges (
        id text PRIMARY KEY,
        from_id text NOT NULL,
        to_id text NOT NULL,
        kind text NOT NULL,
        props jsonb NOT NULL DEFAULT '{}',
        run_id text,
        step_id text,
        created_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS graph_edges_from_idx ON graph_edges (from_id);
      CREATE INDEX IF NOT EXISTS graph_edges_to_idx ON graph_edges (to_id);
    `,
  },
  {
    id: '0004_memory',
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id text PRIMARY KEY,
        kind text NOT NULL,
        client text NOT NULL DEFAULT '',
        user_id text NOT NULL DEFAULT '',
        key text NOT NULL,
        value jsonb NOT NULL,
        confidence real NOT NULL DEFAULT 1,
        source text NOT NULL DEFAULT '',
        hits integer NOT NULL DEFAULT 0,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL,
        CONSTRAINT memories_kind_client_user_key_uq UNIQUE (kind, client, user_id, key)
      );
      CREATE TABLE IF NOT EXISTS learned_rules (
        id text PRIMARY KEY,
        client text NOT NULL,
        kind text NOT NULL,
        pattern jsonb NOT NULL,
        action jsonb NOT NULL,
        status text NOT NULL,
        confirmations integer NOT NULL DEFAULT 0,
        rejections integer NOT NULL DEFAULT 0,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL
      );
    `,
  },
  {
    id: '0005_integrations',
    sql: `
      CREATE TABLE IF NOT EXISTS integrations (
        id text PRIMARY KEY,
        provider text NOT NULL,
        client text NOT NULL,
        external_id text,
        tokens_enc text,
        status text NOT NULL,
        scopes text,
        connected_at bigint,
        updated_at bigint NOT NULL,
        last_sync_at bigint,
        CONSTRAINT integrations_provider_client_uq UNIQUE (provider, client)
      );
    `,
  },
];

/**
 * Platform tables, then the ledger warehouse synced from QuickBooks/Xero. Ledger
 * ids are namespaced so the two lists can grow independently.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  ...PLATFORM_MIGRATIONS,
  ...LEDGER_MIGRATIONS.map((m) => ({ id: `ledger/${m.id}`, sql: m.sql })),
];

/** Created before anything else so applied migrations can be recorded. */
export const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at bigint NOT NULL
  );
`;
