/**
 * Raw SQL mirror of `schema.ts`, for the platform migration list. Every
 * statement is idempotent (`IF NOT EXISTS`) so `LEDGER_MIGRATIONS` can be
 * re-applied safely — the lead appends this array to the platform's own
 * migration list rather than us owning the runner.
 *
 * Keep this in sync with `schema.ts` by hand; `tests/ledger.test.ts` applies
 * this exact array against PGlite, so a drift between the two fails tests.
 */
export const LEDGER_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_ledger_companies',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_companies (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        fiscal_year_start_month INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '002_ledger_accounts',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_accounts (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        code TEXT,
        name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider_subtype TEXT,
        ontology_subtype TEXT,
        class TEXT,
        normal_balance TEXT,
        currency TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        parent_account_id TEXT,
        current_balance_cents BIGINT,
        provider_updated_at TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_accounts_company_external_uq UNIQUE (company_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_accounts_company_type_idx ON ledger_accounts (company_id, provider_type);
      CREATE INDEX IF NOT EXISTS ledger_accounts_parent_idx ON ledger_accounts (parent_account_id);
    `,
  },
  {
    id: '003_ledger_contacts',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_contacts (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_contacts_company_external_uq UNIQUE (company_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_contacts_company_kind_idx ON ledger_contacts (company_id, kind);
    `,
  },
  {
    id: '004_ledger_entries',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        number TEXT,
        date DATE NOT NULL,
        memo TEXT,
        currency TEXT,
        status TEXT,
        provider_updated_at TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_entries_company_external_uq UNIQUE (company_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_entries_company_date_idx ON ledger_entries (company_id, date);
    `,
  },
  {
    id: '005_ledger_lines',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_lines (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
        line_no INTEGER NOT NULL,
        account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
        contact_id TEXT REFERENCES ledger_contacts(id),
        description TEXT,
        debit_cents BIGINT NOT NULL DEFAULT 0,
        credit_cents BIGINT NOT NULL DEFAULT 0,
        dimensions JSONB NOT NULL DEFAULT '{}',
        CONSTRAINT ledger_lines_entry_line_uq UNIQUE (entry_id, line_no),
        CONSTRAINT ledger_lines_debit_xor_credit CHECK (debit_cents = 0 OR credit_cents = 0)
      );
      CREATE INDEX IF NOT EXISTS ledger_lines_account_idx ON ledger_lines (account_id);
      CREATE INDEX IF NOT EXISTS ledger_lines_contact_idx ON ledger_lines (contact_id);
    `,
  },
  {
    id: '006_ledger_bank_transactions',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_bank_transactions (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        bank_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
        date DATE NOT NULL,
        amount_cents BIGINT NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        reference TEXT,
        status TEXT NOT NULL DEFAULT 'unreviewed',
        category_account_id TEXT REFERENCES ledger_accounts(id),
        matched_entry_id TEXT REFERENCES ledger_entries(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_bank_txn_company_external_uq UNIQUE (company_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_bank_txn_company_date_idx ON ledger_bank_transactions (company_id, date);
      CREATE INDEX IF NOT EXISTS ledger_bank_txn_company_status_idx ON ledger_bank_transactions (company_id, status);
      CREATE INDEX IF NOT EXISTS ledger_bank_txn_account_idx ON ledger_bank_transactions (bank_account_id);
    `,
  },
  {
    id: '007_ledger_documents',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_documents (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        contact_id TEXT REFERENCES ledger_contacts(id),
        number TEXT,
        date DATE NOT NULL,
        due_date DATE,
        total_cents BIGINT NOT NULL,
        balance_cents BIGINT NOT NULL,
        status TEXT,
        currency TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_documents_company_external_uq UNIQUE (company_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_documents_company_kind_status_idx ON ledger_documents (company_id, kind, status);
      CREATE INDEX IF NOT EXISTS ledger_documents_due_date_idx ON ledger_documents (company_id, due_date);
    `,
  },
  {
    id: '008_ledger_periods',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_periods (
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        closed_at TIMESTAMPTZ,
        PRIMARY KEY (company_id, period)
      );
    `,
  },
  {
    id: '009_ledger_account_balances',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_account_balances (
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        opening_cents BIGINT NOT NULL DEFAULT 0,
        debits_cents BIGINT NOT NULL DEFAULT 0,
        credits_cents BIGINT NOT NULL DEFAULT 0,
        closing_cents BIGINT NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'computed',
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (company_id, account_id, period)
      );
      CREATE INDEX IF NOT EXISTS ledger_account_balances_company_period_idx ON ledger_account_balances (company_id, period);
    `,
  },
  {
    id: '010_ledger_sync_state',
    sql: `
      CREATE TABLE IF NOT EXISTS ledger_sync_state (
        company_id TEXT NOT NULL REFERENCES ledger_companies(id) ON DELETE CASCADE,
        entity TEXT NOT NULL,
        cursor TEXT,
        last_run_at TIMESTAMPTZ,
        rows_upserted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        error TEXT,
        PRIMARY KEY (company_id, entity)
      );
    `,
  },
];
