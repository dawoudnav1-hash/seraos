/**
 * Structural accounting rules. Every check here is deterministic — confidence
 * is always 1 — and returns the shared CheckResult so it slots into the same
 * verification pipeline as tie-outs and judgment checks.
 */

import type { Cents, CheckResult, JournalEntry } from '@/lib/engine/types';
import { periodKey } from '@/lib/engine/primitives';

export type ChartOfAccounts = ReadonlySet<string> | readonly { code: string }[];

function chartHasAccount(chart: ChartOfAccounts, code: string): boolean {
  if (Array.isArray(chart)) return chart.some((a) => a.code === code);
  return (chart as ReadonlySet<string>).has(code);
}

export interface RuleContext {
  chart?: ChartOfAccounts;
  /** Period keys ('YYYY-MM') that are already closed and cannot take new entries. */
  closedPeriods?: readonly string[];
}

export function checkBalanced(je: JournalEntry): CheckResult {
  const debit = je.lines.reduce((s, l) => s + l.debitCents, 0);
  const credit = je.lines.reduce((s, l) => s + l.creditCents, 0);
  const pass = debit === credit;
  return {
    id: 'structural.balanced',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? `Debits and credits both total ${debit} cents.` : `Entry does not balance: debits ${debit} vs credits ${credit}.`,
  };
}

export function checkNoZeroLines(je: JournalEntry): CheckResult {
  const zero = je.lines.filter((l) => l.debitCents === 0 && l.creditCents === 0);
  const pass = zero.length === 0;
  return {
    id: 'structural.no_zero_lines',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? 'No zero-amount lines.' : `${zero.length} line(s) carry neither a debit nor a credit.`,
  };
}

export function checkNoMixedDebitCredit(je: JournalEntry): CheckResult {
  const mixed = je.lines.filter((l) => l.debitCents !== 0 && l.creditCents !== 0);
  const pass = mixed.length === 0;
  return {
    id: 'structural.no_mixed_debit_credit',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? 'No line carries both a debit and a credit.' : `${mixed.length} line(s) carry both a debit and a credit.`,
  };
}

export function checkEverySourced(je: JournalEntry): CheckResult {
  const unsourced = je.lines.filter((l) => l.sources.length === 0);
  const pass = unsourced.length === 0;
  return {
    id: 'structural.every_line_sourced',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? 'Every line has at least one source.' : `${unsourced.length} line(s) have no source — no source, not allowed.`,
  };
}

export function checkAccountsExist(je: JournalEntry, chart: ChartOfAccounts): CheckResult {
  const missing = [...new Set(je.lines.map((l) => l.account))].filter((a) => !chartHasAccount(chart, a));
  const pass = missing.length === 0;
  return {
    id: 'structural.accounts_exist',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? 'Every account exists in the chart of accounts.' : `Unknown account(s): ${missing.join(', ')}.`,
  };
}

export function checkPeriodOpen(je: JournalEntry, closedPeriods: readonly string[]): CheckResult {
  const key = periodKey(je.date);
  const pass = !closedPeriods.includes(key);
  return {
    id: 'structural.period_open',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? `Period ${key} is open.` : `Period ${key} is closed to new entries.`,
  };
}

/** Accruals must reverse strictly after their own date; any other type passes trivially. */
export function checkAccrualReversal(je: JournalEntry): CheckResult {
  if (je.type !== 'accrual') {
    return {
      id: 'structural.accrual_reverses',
      layer: 'structural',
      pass: true,
      confidence: 1,
      message: 'Not an accrual; reversal timing does not apply.',
    };
  }
  const pass = Boolean(je.reversesOn) && je.reversesOn! > je.date;
  return {
    id: 'structural.accrual_reverses',
    layer: 'structural',
    pass,
    confidence: 1,
    message: pass ? `Reverses on ${je.reversesOn}, after the entry date ${je.date}.` : 'An accrual must set reversesOn to a date strictly after the entry date.',
  };
}

export interface CapitalizationInput {
  amountCents: Cents;
  usefulLifeMonths: number;
  thresholdCents: Cents;
}

export interface CapitalizationDecision extends CheckResult {
  capitalize: boolean;
}

/** Capitalization policy: amount ≥ threshold AND useful life > 12 months → capitalize. */
export function capitalizationDecision(input: CapitalizationInput): CapitalizationDecision {
  const meetsAmount = input.amountCents >= input.thresholdCents;
  const meetsLife = input.usefulLifeMonths > 12;
  const capitalize = meetsAmount && meetsLife;
  const reason = capitalize
    ? `Amount ${input.amountCents}¢ ≥ threshold ${input.thresholdCents}¢, and useful life ${input.usefulLifeMonths}mo > 12mo.`
    : !meetsAmount
      ? `Amount ${input.amountCents}¢ is below the ${input.thresholdCents}¢ capitalization threshold.`
      : `Useful life ${input.usefulLifeMonths}mo is 12 months or less.`;
  return { id: 'structural.capitalization_policy', layer: 'structural', pass: true, confidence: 1, message: reason, capitalize };
}

export interface MaterialityInput {
  absoluteCents: Cents;
  percentOfBase?: number; // 0.05 = 5%
  base?: Cents;
}

export interface MaterialityThresholds {
  absoluteCents: Cents;
  percentBps: number; // 500 = 5%
}

export const DEFAULT_MATERIALITY_THRESHOLDS: MaterialityThresholds = { absoluteCents: 500000, percentBps: 500 };

export interface MaterialityDecision extends CheckResult {
  tier: 'immaterial' | 'material';
}

/** Material if it clears either the absolute-dollar or the percent-of-base threshold. */
export function materialityTier(input: MaterialityInput, thresholds: MaterialityThresholds = DEFAULT_MATERIALITY_THRESHOLDS): MaterialityDecision {
  const percentOfBaseBps =
    input.percentOfBase !== undefined
      ? Math.round(input.percentOfBase * 10000)
      : input.base
        ? Math.round((Math.abs(input.absoluteCents) / input.base) * 10000)
        : undefined;
  const overAbsolute = Math.abs(input.absoluteCents) >= thresholds.absoluteCents;
  const overPercent = percentOfBaseBps !== undefined && percentOfBaseBps >= thresholds.percentBps;
  const material = overAbsolute || overPercent;
  const parts: string[] = [];
  if (overAbsolute) parts.push(`absolute ${input.absoluteCents}¢ ≥ ${thresholds.absoluteCents}¢`);
  if (overPercent) parts.push(`${(percentOfBaseBps! / 100).toFixed(2)}% of base ≥ ${(thresholds.percentBps / 100).toFixed(2)}%`);
  const rationale = material
    ? `Material: ${parts.join(' and ')}.`
    : `Immaterial: below both the ${thresholds.absoluteCents}¢ absolute and ${(thresholds.percentBps / 100).toFixed(2)}% of base thresholds.`;
  return { id: 'structural.materiality_tier', layer: 'structural', pass: true, confidence: 1, message: rationale, tier: material ? 'material' : 'immaterial' };
}

/** Runs every structural check that applies given the context, and returns them all. */
export function runRules(je: JournalEntry, ctx: RuleContext = {}): CheckResult[] {
  const checks: CheckResult[] = [checkBalanced(je), checkNoZeroLines(je), checkNoMixedDebitCredit(je), checkEverySourced(je), checkAccrualReversal(je)];
  if (ctx.chart) checks.push(checkAccountsExist(je, ctx.chart));
  if (ctx.closedPeriods) checks.push(checkPeriodOpen(je, ctx.closedPeriods));
  return checks;
}
