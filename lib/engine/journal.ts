/**
 * Builders for every journal entry type. Every builder takes explicit
 * account codes and SourceRefs — never guesses an account — and runs the
 * structural rules before returning, so an unbalanced or unsourced entry
 * never leaves this module.
 */

import { createHash } from 'node:crypto';
import type { CheckResult, IsoDate, JournalEntry, JournalEntryType, JournalLine, SourceRef } from '@/lib/engine/types';
import type { Cents } from '@/lib/engine/types';
import { addMonths, startOfMonth } from '@/lib/engine/primitives';
import { runRules } from '@/lib/engine/rules';

/** Thrown when a built entry fails a structural check (unbalanced, unsourced, ...). */
export class JournalBuildError extends Error {
  readonly checks: CheckResult[];
  constructor(checks: CheckResult[]) {
    const failed = checks.filter((c) => !c.pass);
    super(`Journal entry failed validation: ${failed.map((c) => c.message).join('; ')}`);
    this.name = 'JournalBuildError';
    this.checks = checks;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/** sha256 of the canonical (key-sorted) JSON of (date, type, lines) — identical content, identical key. */
export function computeIdempotencyKey(date: IsoDate, type: JournalEntryType, lines: JournalLine[]): string {
  const payload = canonicalize({ date, type, lines });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function attachEvidence(je: JournalEntry, refs: SourceRef[]): JournalEntry {
  return { ...je, attachments: [...je.attachments, ...refs] };
}

function finalize(type: JournalEntryType, date: IsoDate, memo: string, lines: JournalLine[], attachments: SourceRef[], reversesOn?: IsoDate): JournalEntry {
  const idempotencyKey = computeIdempotencyKey(date, type, lines);
  const je: JournalEntry = {
    id: `JE-${idempotencyKey.slice(0, 16)}`,
    date,
    type,
    memo,
    lines,
    attachments,
    idempotencyKey,
    ...(reversesOn ? { reversesOn } : {}),
  };
  const checks = runRules(je, {});
  if (checks.some((c) => !c.pass)) throw new JournalBuildError(checks);
  return je;
}

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

export interface ManualLineInput {
  account: string;
  description: string;
  debitCents: Cents;
  creditCents: Cents;
  sources: SourceRef[];
  dimensions?: Record<string, string>;
}

export interface ManualEntryInput {
  date: IsoDate;
  memo: string;
  lines: ManualLineInput[];
  attachments?: SourceRef[];
}

export function buildManualEntry(input: ManualEntryInput): JournalEntry {
  return finalize('manual', input.date, input.memo, input.lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// accrual
// ---------------------------------------------------------------------------

export interface AccrualEntryInput {
  date: IsoDate;
  memo: string;
  expenseAccount: string;
  liabilityAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

/** Debits expense, credits the accrued liability. reversesOn is set to the first day of next period. */
export function buildAccrualEntry(input: AccrualEntryInput): JournalEntry {
  const lines: JournalLine[] = [
    { account: input.expenseAccount, description: input.memo, debitCents: input.amountCents, creditCents: 0, sources: input.sources },
    { account: input.liabilityAccount, description: input.memo, debitCents: 0, creditCents: input.amountCents, sources: input.sources },
  ];
  const reversesOn = startOfMonth(addMonths(input.date, 1));
  return finalize('accrual', input.date, input.memo, lines, input.attachments ?? [], reversesOn);
}

// ---------------------------------------------------------------------------
// reversing
// ---------------------------------------------------------------------------

/** Swaps every line's debit/credit and links back to the original entry's id. */
export function buildReversingEntry(je: JournalEntry, date: IsoDate): JournalEntry {
  const lines: JournalLine[] = je.lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }));
  const attachments: SourceRef[] = [...je.attachments, { system: 'gl', id: je.id, label: 'Original entry reversed' }];
  return finalize('reversing', date, `Reversal of ${je.id}: ${je.memo}`, lines, attachments);
}

// ---------------------------------------------------------------------------
// payroll
// ---------------------------------------------------------------------------

export interface PayrollWithholding {
  account: string;
  amountCents: Cents;
  description: string;
}

export interface PayrollEntryInput {
  date: IsoDate;
  memo: string;
  wagesExpenseAccount: string;
  grossWagesCents: Cents;
  employerTaxExpenseAccount: string;
  employerTaxesCents: Cents;
  employerTaxLiabilityAccount: string;
  withholdings: PayrollWithholding[];
  netPayAccount: string;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export class PayrollBuildError extends Error {}

/**
 * Net pay is computed, never taken as input, so gross wages, withholdings and
 * net pay always balance by construction — there is no arithmetic left for a
 * caller to get wrong.
 */
export function buildPayrollEntry(input: PayrollEntryInput): JournalEntry {
  const withheldTotal = input.withholdings.reduce((s, w) => s + w.amountCents, 0);
  const netPayCents = input.grossWagesCents - withheldTotal;
  if (netPayCents < 0) throw new PayrollBuildError(`Withholdings (${withheldTotal}¢) exceed gross wages (${input.grossWagesCents}¢).`);

  const lines: JournalLine[] = [
    { account: input.wagesExpenseAccount, description: 'Gross wages', debitCents: input.grossWagesCents, creditCents: 0, sources: input.sources },
    { account: input.employerTaxExpenseAccount, description: 'Employer payroll taxes', debitCents: input.employerTaxesCents, creditCents: 0, sources: input.sources },
    ...input.withholdings.map((w) => ({ account: w.account, description: w.description, debitCents: 0, creditCents: w.amountCents, sources: input.sources })),
    { account: input.employerTaxLiabilityAccount, description: 'Employer payroll taxes payable', debitCents: 0, creditCents: input.employerTaxesCents, sources: input.sources },
    { account: input.netPayAccount, description: 'Net pay', debitCents: 0, creditCents: netPayCents, sources: input.sources },
  ];
  return finalize('payroll', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// revenue_recognition
// ---------------------------------------------------------------------------

export interface RevenueRecognitionEntryInput {
  date: IsoDate;
  memo: string;
  deferredRevenueAccount: string;
  revenueAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export function buildRevenueRecognitionEntry(input: RevenueRecognitionEntryInput): JournalEntry {
  const lines: JournalLine[] = [
    { account: input.deferredRevenueAccount, description: input.memo, debitCents: input.amountCents, creditCents: 0, sources: input.sources },
    { account: input.revenueAccount, description: input.memo, debitCents: 0, creditCents: input.amountCents, sources: input.sources },
  ];
  return finalize('revenue_recognition', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// depreciation
// ---------------------------------------------------------------------------

export interface DepreciationLineInput {
  accumulatedDepreciationAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  description?: string;
}

export interface DepreciationEntryInput {
  date: IsoDate;
  memo: string;
  depreciationExpenseAccount: string;
  lines: DepreciationLineInput[];
  expenseSources: SourceRef[];
  attachments?: SourceRef[];
}

export function buildDepreciationEntry(input: DepreciationEntryInput): JournalEntry {
  const total = input.lines.reduce((s, l) => s + l.amountCents, 0);
  const lines: JournalLine[] = [
    { account: input.depreciationExpenseAccount, description: input.memo, debitCents: total, creditCents: 0, sources: input.expenseSources },
    ...input.lines.map((l) => ({
      account: l.accumulatedDepreciationAccount,
      description: l.description ?? 'Accumulated depreciation',
      debitCents: 0,
      creditCents: l.amountCents,
      sources: l.sources,
    })),
  ];
  return finalize('depreciation', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// amortization
// ---------------------------------------------------------------------------

export interface AmortizationLineInput {
  accumulatedAmortizationAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  description?: string;
}

export interface AmortizationEntryInput {
  date: IsoDate;
  memo: string;
  amortizationExpenseAccount: string;
  lines: AmortizationLineInput[];
  expenseSources: SourceRef[];
  attachments?: SourceRef[];
}

export function buildAmortizationEntry(input: AmortizationEntryInput): JournalEntry {
  const total = input.lines.reduce((s, l) => s + l.amountCents, 0);
  const lines: JournalLine[] = [
    { account: input.amortizationExpenseAccount, description: input.memo, debitCents: total, creditCents: 0, sources: input.expenseSources },
    ...input.lines.map((l) => ({
      account: l.accumulatedAmortizationAccount,
      description: l.description ?? 'Accumulated amortization',
      debitCents: 0,
      creditCents: l.amountCents,
      sources: l.sources,
    })),
  ];
  return finalize('amortization', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// prepaid
// ---------------------------------------------------------------------------

export interface PrepaidEntryInput {
  date: IsoDate;
  memo: string;
  expenseAccount: string;
  prepaidAssetAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export function buildPrepaidEntry(input: PrepaidEntryInput): JournalEntry {
  const lines: JournalLine[] = [
    { account: input.expenseAccount, description: input.memo, debitCents: input.amountCents, creditCents: 0, sources: input.sources },
    { account: input.prepaidAssetAccount, description: input.memo, debitCents: 0, creditCents: input.amountCents, sources: input.sources },
  ];
  return finalize('prepaid', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// fixed_asset (capitalize / dispose)
// ---------------------------------------------------------------------------

export interface CapitalizeFixedAssetInput {
  kind: 'capitalize';
  date: IsoDate;
  memo: string;
  fixedAssetAccount: string;
  offsetAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export interface DisposeFixedAssetInput {
  kind: 'dispose';
  date: IsoDate;
  memo: string;
  fixedAssetCostAccount: string;
  costCents: Cents;
  accumulatedDepreciationAccount: string;
  accumulatedDepreciationCents: Cents;
  proceedsAccount: string;
  proceedsCents: Cents;
  gainLossAccount: string;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export type FixedAssetEntryInput = CapitalizeFixedAssetInput | DisposeFixedAssetInput;

export function buildFixedAssetEntry(input: FixedAssetEntryInput): JournalEntry {
  if (input.kind === 'capitalize') {
    const lines: JournalLine[] = [
      { account: input.fixedAssetAccount, description: input.memo, debitCents: input.amountCents, creditCents: 0, sources: input.sources },
      { account: input.offsetAccount, description: input.memo, debitCents: 0, creditCents: input.amountCents, sources: input.sources },
    ];
    return finalize('fixed_asset', input.date, input.memo, lines, input.attachments ?? []);
  }

  const netBookValue = input.costCents - input.accumulatedDepreciationCents;
  const gainLoss = input.proceedsCents - netBookValue; // > 0 gain, < 0 loss
  const lines: JournalLine[] = [
    { account: input.accumulatedDepreciationAccount, description: 'Remove accumulated depreciation', debitCents: input.accumulatedDepreciationCents, creditCents: 0, sources: input.sources },
    ...(input.proceedsCents !== 0 ? [{ account: input.proceedsAccount, description: 'Disposal proceeds', debitCents: input.proceedsCents, creditCents: 0, sources: input.sources }] : []),
    ...(gainLoss < 0 ? [{ account: input.gainLossAccount, description: 'Loss on disposal of fixed assets', debitCents: -gainLoss, creditCents: 0, sources: input.sources }] : []),
    { account: input.fixedAssetCostAccount, description: 'Remove asset cost', debitCents: 0, creditCents: input.costCents, sources: input.sources },
    ...(gainLoss > 0 ? [{ account: input.gainLossAccount, description: 'Gain on disposal of fixed assets', debitCents: 0, creditCents: gainLoss, sources: input.sources }] : []),
  ];
  return finalize('fixed_asset', input.date, input.memo, lines, input.attachments ?? []);
}

// ---------------------------------------------------------------------------
// reclass
// ---------------------------------------------------------------------------

export interface ReclassEntryInput {
  date: IsoDate;
  memo: string;
  fromAccount: string;
  toAccount: string;
  amountCents: Cents;
  sources: SourceRef[];
  attachments?: SourceRef[];
}

export function buildReclassEntry(input: ReclassEntryInput): JournalEntry {
  const lines: JournalLine[] = [
    { account: input.toAccount, description: input.memo, debitCents: input.amountCents, creditCents: 0, sources: input.sources },
    { account: input.fromAccount, description: input.memo, debitCents: 0, creditCents: input.amountCents, sources: input.sources },
  ];
  return finalize('reclass', input.date, input.memo, lines, input.attachments ?? []);
}
