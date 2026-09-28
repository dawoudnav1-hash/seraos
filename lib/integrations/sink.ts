/**
 * Structural interface for the Postgres warehouse another engineer owns
 * (lib/ledger/**). Defined here, matched field-for-field, so the sync route
 * writes through it instead of holding rows in the API layer; at merge the
 * lead re-points this import at lib/ledger/types.ts. Do not add lib/ledger/**
 * from this worktree — the in-memory implementation below is only for tests
 * and for running the sync route before that module lands.
 */

export interface WhCompany {
  id: string;
  client: string;
  provider: 'quickbooks' | 'xero' | 'manual';
  externalId: string;
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}

export interface WhAccount {
  externalId: string;
  code: string | null;
  name: string;
  providerType: string;
  providerSubtype: string | null;
  currency: string | null;
  active: boolean;
  parentExternalId: string | null;
  currentBalanceCents: number | null;
  updatedAt: string | null;
}

export interface WhContact {
  externalId: string;
  kind: 'vendor' | 'customer' | 'employee' | 'other';
  name: string;
  email: string | null;
  active: boolean;
}

export interface WhLine {
  lineNo: number;
  accountExternalId: string;
  contactExternalId: string | null;
  description: string | null;
  debitCents: number;
  creditCents: number;
  dimensions: Record<string, string>;
}

export interface WhEntry {
  externalId: string;
  sourceType: string;
  number: string | null;
  date: string;
  memo: string | null;
  currency: string | null;
  status: string | null;
  updatedAt: string | null;
  lines: WhLine[];
}

export interface WhBankTxn {
  externalId: string;
  bankAccountExternalId: string;
  date: string;
  /** Signed; positive = money in. */
  amountCents: number;
  description: string;
  counterparty: string | null;
  reference: string | null;
  status: 'unreviewed' | 'categorized' | 'matched' | 'excluded';
  categoryAccountExternalId: string | null;
}

export interface WhDocument {
  externalId: string;
  kind: 'invoice' | 'bill' | 'credit_note' | 'payment';
  contactExternalId: string | null;
  number: string | null;
  date: string;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;
  status: string | null;
  currency: string | null;
}

export interface LedgerSink {
  upsertCompany(c: WhCompany): Promise<void>;
  upsertAccounts(companyId: string, rows: WhAccount[]): Promise<number>;
  upsertContacts(companyId: string, rows: WhContact[]): Promise<number>;
  /** Entries WITH their lines. */
  upsertEntries(companyId: string, rows: WhEntry[]): Promise<number>;
  upsertBankTransactions(companyId: string, rows: WhBankTxn[]): Promise<number>;
  upsertDocuments(companyId: string, rows: WhDocument[]): Promise<number>;
  getSyncCursor(companyId: string, entity: string): Promise<string | null>;
  setSyncCursor(companyId: string, entity: string, cursor: string, rowsUpserted: number): Promise<void>;
}

interface CursorRow {
  cursor: string;
  rowsUpserted: number;
}

/** For tests and for running `/sync` before the Postgres warehouse lands. */
export class InMemoryLedgerSink implements LedgerSink {
  readonly companies = new Map<string, WhCompany>();
  readonly accounts = new Map<string, Map<string, WhAccount>>();
  readonly contacts = new Map<string, Map<string, WhContact>>();
  readonly entries = new Map<string, Map<string, WhEntry>>();
  readonly bankTxns = new Map<string, Map<string, WhBankTxn>>();
  readonly documents = new Map<string, Map<string, WhDocument>>();
  private readonly cursors = new Map<string, CursorRow>();

  async upsertCompany(c: WhCompany): Promise<void> {
    this.companies.set(c.id, c);
  }

  async upsertAccounts(companyId: string, rows: WhAccount[]): Promise<number> {
    const table = this.accounts.get(companyId) ?? new Map<string, WhAccount>();
    for (const row of rows) table.set(row.externalId, row);
    this.accounts.set(companyId, table);
    return rows.length;
  }

  async upsertContacts(companyId: string, rows: WhContact[]): Promise<number> {
    const table = this.contacts.get(companyId) ?? new Map<string, WhContact>();
    for (const row of rows) table.set(row.externalId, row);
    this.contacts.set(companyId, table);
    return rows.length;
  }

  async upsertEntries(companyId: string, rows: WhEntry[]): Promise<number> {
    const table = this.entries.get(companyId) ?? new Map<string, WhEntry>();
    for (const row of rows) table.set(row.externalId, row);
    this.entries.set(companyId, table);
    return rows.length;
  }

  async upsertBankTransactions(companyId: string, rows: WhBankTxn[]): Promise<number> {
    const table = this.bankTxns.get(companyId) ?? new Map<string, WhBankTxn>();
    for (const row of rows) table.set(row.externalId, row);
    this.bankTxns.set(companyId, table);
    return rows.length;
  }

  async upsertDocuments(companyId: string, rows: WhDocument[]): Promise<number> {
    const table = this.documents.get(companyId) ?? new Map<string, WhDocument>();
    for (const row of rows) table.set(row.externalId, row);
    this.documents.set(companyId, table);
    return rows.length;
  }

  async getSyncCursor(companyId: string, entity: string): Promise<string | null> {
    return this.cursors.get(`${companyId}:${entity}`)?.cursor ?? null;
  }

  async setSyncCursor(companyId: string, entity: string, cursor: string, rowsUpserted: number): Promise<void> {
    this.cursors.set(`${companyId}:${entity}`, { cursor, rowsUpserted });
  }
}

let sink: LedgerSink = new InMemoryLedgerSink();

/** Swap the backing sink — the lead points this at the Postgres warehouse at merge. */
export function setLedgerSink(next: LedgerSink): void {
  sink = next;
}

export function getLedgerSink(): LedgerSink {
  return sink;
}
