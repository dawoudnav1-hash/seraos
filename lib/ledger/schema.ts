/**
 * The WAREHOUSE: normalized, multi-company Postgres tables that mirror a
 * connected ledger (QuickBooks/Xero) or a manual import, so agents and,
 * per the founder's requirement, a user's own ledger software can read
 * structured accounting data straight out of the database instead of an API.
 *
 * Every row that comes from a provider carries `provider` + `externalId`
 * (provenance) and is unique on `(companyId, externalId)`, which is what
 * makes `LedgerSink` upserts idempotent — the same page of provider data can
 * be replayed any number of times. Money is integer cents (`bigint`, mode
 * 'number' — see `lib/engine/types.ts`), never float.
 *
 * `lib/ledger/ddl.ts` mirrors this file as raw SQL for the platform migration
 * list; keep the two in sync by hand.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const ledgerCompanies = pgTable('ledger_companies', {
  id: text('id').primaryKey(),
  client: text('client').notNull(),
  provider: text('provider').notNull(), // 'quickbooks' | 'xero' | 'manual'
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull(),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    code: text('code'),
    name: text('name').notNull(),
    providerType: text('provider_type').notNull(),
    providerSubtype: text('provider_subtype'),
    /** Filled later by the ontology classifier (lib/context/ontology.ts); null until then. */
    ontologySubtype: text('ontology_subtype'),
    /** asset | liability | equity | revenue | expense — best-effort from providerType until the classifier runs. */
    class: text('class'),
    /** debit | credit — the account's normal balance side. */
    normalBalance: text('normal_balance'),
    currency: text('currency'),
    active: boolean('active').notNull().default(true),
    parentAccountId: text('parent_account_id'),
    currentBalanceCents: bigint('current_balance_cents', { mode: 'number' }),
    providerUpdatedAt: text('provider_updated_at'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExternal: unique('ledger_accounts_company_external_uq').on(t.companyId, t.externalId),
    byCompanyType: index('ledger_accounts_company_type_idx').on(t.companyId, t.providerType),
    parentFk: index('ledger_accounts_parent_idx').on(t.parentAccountId),
  }),
);

export const ledgerContacts = pgTable(
  'ledger_contacts',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(), // 'vendor' | 'customer' | 'employee' | 'other'
    name: text('name').notNull(),
    email: text('email'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExternal: unique('ledger_contacts_company_external_uq').on(t.companyId, t.externalId),
    byCompanyKind: index('ledger_contacts_company_kind_idx').on(t.companyId, t.kind),
  }),
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    sourceType: text('source_type').notNull(),
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    currency: text('currency'),
    status: text('status'),
    providerUpdatedAt: text('provider_updated_at'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExternal: unique('ledger_entries_company_external_uq').on(t.companyId, t.externalId),
    byCompanyDate: index('ledger_entries_company_date_idx').on(t.companyId, t.date),
  }),
);

export const ledgerLines = pgTable(
  'ledger_lines',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    contactId: text('contact_id').references(() => ledgerContacts.id),
    description: text('description'),
    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    dimensions: jsonb('dimensions').notNull().default({}),
  },
  (t) => ({
    byEntryLine: unique('ledger_lines_entry_line_uq').on(t.entryId, t.lineNo),
    byAccount: index('ledger_lines_account_idx').on(t.accountId),
    byContact: index('ledger_lines_contact_idx').on(t.contactId),
    debitXorCredit: check(
      'ledger_lines_debit_xor_credit',
      sql`${t.debitCents} = 0 OR ${t.creditCents} = 0`,
    ),
  }),
);

export const ledgerBankTransactions = pgTable(
  'ledger_bank_transactions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    date: date('date', { mode: 'string' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    counterparty: text('counterparty'),
    reference: text('reference'),
    status: text('status').notNull().default('unreviewed'), // unreviewed|categorized|matched|excluded
    categoryAccountId: text('category_account_id').references(() => ledgerAccounts.id),
    matchedEntryId: text('matched_entry_id').references(() => ledgerEntries.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExternal: unique('ledger_bank_txn_company_external_uq').on(t.companyId, t.externalId),
    byCompanyDate: index('ledger_bank_txn_company_date_idx').on(t.companyId, t.date),
    byCompanyStatus: index('ledger_bank_txn_company_status_idx').on(t.companyId, t.status),
    byBankAccount: index('ledger_bank_txn_account_idx').on(t.bankAccountId),
  }),
);

export const ledgerDocuments = pgTable(
  'ledger_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(), // invoice|bill|credit_note|payment
    contactId: text('contact_id').references(() => ledgerContacts.id),
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
    status: text('status'),
    currency: text('currency'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExternal: unique('ledger_documents_company_external_uq').on(t.companyId, t.externalId),
    byCompanyKindStatus: index('ledger_documents_company_kind_status_idx').on(
      t.companyId,
      t.kind,
      t.status,
    ),
    byDueDate: index('ledger_documents_due_date_idx').on(t.companyId, t.dueDate),
  }),
);

/** Month-end close state. A closed period's lines/balances should be treated as frozen by callers. */
export const ledgerPeriods = pgTable(
  'ledger_periods',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    period: text('period').notNull(), // 'YYYY-MM'
    status: text('status').notNull().default('open'), // open|closed
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ name: 'ledger_periods_pkey', columns: [t.companyId, t.period] }),
  }),
);

/**
 * Materialized per-account, per-period balances so trend/flux/reasonableness reads
 * don't re-sum `ledger_lines` on every call. Rebuilt by `recomputeBalances`.
 */
export const ledgerAccountBalances = pgTable(
  'ledger_account_balances',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'cascade' }),
    period: text('period').notNull(), // 'YYYY-MM'
    openingCents: bigint('opening_cents', { mode: 'number' }).notNull().default(0),
    debitsCents: bigint('debits_cents', { mode: 'number' }).notNull().default(0),
    creditsCents: bigint('credits_cents', { mode: 'number' }).notNull().default(0),
    closingCents: bigint('closing_cents', { mode: 'number' }).notNull().default(0),
    source: text('source').notNull().default('computed'), // computed|provider
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'ledger_account_balances_pkey', columns: [t.companyId, t.accountId, t.period] }),
    byCompanyPeriod: index('ledger_account_balances_company_period_idx').on(t.companyId, t.period),
  }),
);

/** One row per (company, entity) the sync tracks — 'accounts', 'entries', 'bank_transactions', ... */
export const ledgerSyncState = pgTable(
  'ledger_sync_state',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => ledgerCompanies.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    cursor: text('cursor'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    rowsUpserted: integer('rows_upserted').notNull().default(0),
    status: text('status').notNull().default('idle'), // idle|running|ok|error
    error: text('error'),
  },
  (t) => ({
    pk: primaryKey({ name: 'ledger_sync_state_pkey', columns: [t.companyId, t.entity] }),
  }),
);
