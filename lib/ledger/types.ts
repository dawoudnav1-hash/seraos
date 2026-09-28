/**
 * The WAREHOUSE contract. The QuickBooks/Xero sync writes through `LedgerSink`;
 * agents and the read API in `repository.ts` never touch the sync path.
 *
 * All money is integer cents (see `lib/engine/types.ts`). All dates are `IsoDate`
 * (`YYYY-MM-DD`) as given by the source system, never re-parsed into `Date`.
 */
import type { IsoDate } from '@/lib/engine/types';

export type LedgerProvider = 'quickbooks' | 'xero' | 'manual';

export interface WhCompany {
  /** Internal ledger company id, assigned by the caller and reused as `companyId` below. */
  id: string;
  client: string;
  provider: LedgerProvider;
  externalId: string;
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}

export interface WhAccount {
  externalId: string;
  code: string | null;
  name: string;
  /** The source system's account type, e.g. QBO "Bank" / Xero "BANK". Raw, unmapped. */
  providerType: string;
  providerSubtype: string | null;
  currency: string | null;
  active: boolean;
  /** externalId of the parent account, for sub-accounts. */
  parentExternalId: string | null;
  /** The provider's own running balance, if it sends one. Not authoritative — see `ledger_account_balances`. */
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
  /** e.g. 'journal_entry' | 'invoice' | 'bill' | 'payment' | 'deposit' | 'transfer', whatever the provider calls it. */
  sourceType: string;
  number: string | null;
  date: IsoDate;
  memo: string | null;
  currency: string | null;
  status: string | null;
  updatedAt: string | null;
  lines: WhLine[];
}

export interface WhBankTxn {
  externalId: string;
  bankAccountExternalId: string;
  date: IsoDate;
  /** Signed; positive is money in. */
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
  date: IsoDate;
  dueDate: IsoDate | null;
  totalCents: number;
  balanceCents: number;
  status: string | null;
  currency: string | null;
}

/**
 * The interface the QuickBooks/Xero sync codes against. Every `upsert*` is
 * idempotent on (companyId, externalId) — running the same page of provider
 * data twice updates rows in place rather than duplicating them. Returns the
 * number of rows written so the sync can report progress.
 */
export interface LedgerSink {
  upsertCompany(c: WhCompany): Promise<void>;
  upsertAccounts(companyId: string, rows: WhAccount[]): Promise<number>;
  upsertContacts(companyId: string, rows: WhContact[]): Promise<number>;
  upsertEntries(companyId: string, rows: WhEntry[]): Promise<number>;
  upsertBankTransactions(companyId: string, rows: WhBankTxn[]): Promise<number>;
  upsertDocuments(companyId: string, rows: WhDocument[]): Promise<number>;
  getSyncCursor(companyId: string, entity: string): Promise<string | null>;
  setSyncCursor(companyId: string, entity: string, cursor: string, rowsUpserted: number): Promise<void>;
}

/** Refused before it ever reaches storage: an entry whose debits and credits don't sum equal. */
export class UnbalancedEntryError extends Error {
  readonly externalId: string;
  readonly totalDebitCents: number;
  readonly totalCreditCents: number;

  constructor(externalId: string, totalDebitCents: number, totalCreditCents: number) {
    super(
      `entry ${externalId} does not balance: debits ${totalDebitCents} !== credits ${totalCreditCents}`,
    );
    this.name = 'UnbalancedEntryError';
    this.externalId = externalId;
    this.totalDebitCents = totalDebitCents;
    this.totalCreditCents = totalCreditCents;
  }
}

/** Refused: an entry line references an account (or contact) that hasn't been synced yet. */
export class UnknownReferenceError extends Error {
  readonly externalId: string;
  readonly kind: 'account' | 'contact';
  readonly referenceExternalId: string;

  constructor(externalId: string, kind: 'account' | 'contact', referenceExternalId: string) {
    super(`entry ${externalId} references unknown ${kind} "${referenceExternalId}"`);
    this.name = 'UnknownReferenceError';
    this.externalId = externalId;
    this.kind = kind;
    this.referenceExternalId = referenceExternalId;
  }
}
