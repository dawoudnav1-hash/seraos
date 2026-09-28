/**
 * Shared contracts for the deterministic engines, the skill runtime and the
 * integrations. Every engine imports from here so parallel modules agree.
 *
 * Money is always integer cents. Floats never touch a balance.
 */

/** Integer cents. `12345` is $123.45. */
export type Cents = number;

/** ISO date `YYYY-MM-DD`. */
export type IsoDate = string;

/** A pointer to the record that justifies a figure: "no source, not allowed". */
export interface SourceRef {
  /** Where it lives: 'gl', 'bank', 'stripe', 'quickbooks', 'xero', 'upload', 'register', 'payroll', … */
  system: string;
  /** The record id in that system (JE number, transaction id, row key, file#row). */
  id: string;
  /** Optional human label, e.g. "Best Buy – Laptop". */
  label?: string;
}

export const JOURNAL_ENTRY_TYPES = [
  'manual',
  'accrual',
  'reversing',
  'payroll',
  'revenue_recognition',
  'depreciation',
  'amortization',
  'prepaid',
  'fixed_asset',
  'reclass',
] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

export interface JournalLine {
  /** Chart-of-accounts code or id, e.g. "6410". */
  account: string;
  description: string;
  debitCents: Cents;
  creditCents: Cents;
  /** Evidence for this line. At least one per line before an entry may be proposed. */
  sources: SourceRef[];
  /** Optional dimensions: class, location, department, entity. */
  dimensions?: Record<string, string>;
}

/** A proposed entry. Agents propose these; only the posting service commits them. */
export interface JournalEntry {
  id: string;
  date: IsoDate;
  type: JournalEntryType;
  memo: string;
  lines: JournalLine[];
  /** Supporting files (workpapers, invoices) attached to the entry. */
  attachments: SourceRef[];
  /** For accruals and other auto-reversing entries. */
  reversesOn?: IsoDate;
  /** Idempotency key for posting; the same key never posts twice. */
  idempotencyKey: string;
}

/** A normalized ledger or bank transaction, whatever system it came from. */
export interface Txn {
  id: string;
  date: IsoDate;
  amountCents: Cents;
  description: string;
  /** Payee / payer / counterparty as it appears in the source. */
  counterparty?: string;
  /** Reference / check number / invoice number / payout id. */
  reference?: string;
  account?: string;
  currency?: string;
  source: SourceRef;
}

/** Result of any check: structural, tie-out, verifier, reasonableness. */
export interface CheckResult {
  id: string;
  layer: 'structural' | 'tie_out' | 'verifier' | 'reasonableness';
  pass: boolean;
  /** 0..1 */
  confidence: number;
  message: string;
  evidence?: SourceRef[];
}
