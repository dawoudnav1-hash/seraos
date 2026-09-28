/**
 * Depreciation, amortization, revenue recognition and accrual math. Every
 * function is pure and deterministic. Cumulative amounts are rounded once,
 * at the total; a period's amount is the difference between two rounded
 * cumulative totals, so a schedule always telescopes to exactly the
 * depreciable base or contract total — the last period absorbs whatever
 * rounding the earlier ones left behind, with no special-casing needed.
 */

import type { Cents, IsoDate } from '@/lib/engine/types';
import { addDays, daysBetween, monthEnd, roundHalfUp, sum } from '@/lib/engine/primitives';

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export type DepreciationConvention = 'month_after_in_service' | 'mid_month' | 'full_month' | 'half_year';
export type DepreciationMethod = 'straight_line' | 'declining_balance_200' | 'declining_balance_150';

export interface DepreciableAsset {
  costCents: Cents;
  salvageCents: Cents;
  lifeMonths: number;
  placedInService: IsoDate;
  /** Default 'straight_line'. */
  method?: DepreciationMethod;
  /** Default 'month_after_in_service' (matches the common close convention). */
  convention?: DepreciationConvention;
  disposal?: { date: IsoDate; depreciateInDisposalMonth?: boolean };
}

function monthIndex(date: IsoDate): number {
  const [y, m] = date.split('-').map(Number);
  return y * 12 + (m - 1);
}

function periodToIndex(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return y * 12 + (m - 1);
}

function yearOfIndex(idx: number): number {
  return Math.floor(idx / 12);
}

function monthOfIndex(idx: number): number {
  return (idx % 12) + 1;
}

/**
 * Months of depreciation earned by the end of `asOfIdx`, per convention,
 * uncapped by life or disposal (callers cap separately). May be fractional
 * for mid_month (a half month in the month placed in service).
 */
function rawMonthsElapsed(asset: DepreciableAsset, asOfIdx: number): number {
  const startIdx = monthIndex(asset.placedInService);
  const convention = asset.convention ?? 'month_after_in_service';
  switch (convention) {
    case 'full_month':
      return asOfIdx < startIdx ? 0 : asOfIdx - startIdx + 1;
    case 'month_after_in_service': {
      const firstIdx = startIdx + 1;
      return asOfIdx < firstIdx ? 0 : asOfIdx - firstIdx + 1;
    }
    case 'mid_month':
      if (asOfIdx < startIdx) return 0;
      return asOfIdx === startIdx ? 0.5 : 0.5 + (asOfIdx - startIdx);
    case 'half_year': {
      // Ties to the calendar year: year 1 earns 6 months (spread Jul-Dec),
      // every full subsequent calendar year earns 12.
      const startYear = yearOfIndex(startIdx);
      const asOfYear = yearOfIndex(asOfIdx);
      const asOfMonth = monthOfIndex(asOfIdx);
      if (asOfYear < startYear) return 0;
      if (asOfYear === startYear) return Math.max(0, Math.min(6, asOfMonth - 6));
      const yearsAfterFirst = asOfYear - startYear - 1;
      return 6 + yearsAfterFirst * 12 + asOfMonth;
    }
  }
}

/** rawMonthsElapsed, capped by life and frozen at disposal (per the disposal convention). */
function monthsElapsedCapped(asset: DepreciableAsset, asOfIdx: number): number {
  let n = rawMonthsElapsed(asset, asOfIdx);
  if (asset.disposal) {
    const disposalIdx = monthIndex(asset.disposal.date);
    const cutoffIdx = asset.disposal.depreciateInDisposalMonth ? disposalIdx : disposalIdx - 1;
    if (asOfIdx > cutoffIdx) n = Math.min(n, rawMonthsElapsed(asset, cutoffIdx));
  }
  return Math.min(Math.max(0, n), asset.lifeMonths);
}

function straightLineCumulative(asset: DepreciableAsset, asOfIdx: number): Cents {
  const base = asset.costCents - asset.salvageCents;
  const n = monthsElapsedCapped(asset, asOfIdx);
  return roundHalfUp((base * n) / asset.lifeMonths);
}

function decliningBalanceRateMultiplier(method: DepreciationMethod): number {
  if (method === 'declining_balance_200') return 2;
  if (method === 'declining_balance_150') return 1.5;
  throw new Error(`${method} is not a declining-balance method`);
}

/**
 * Monthly declining-balance schedule that switches to straight-line on the
 * remaining balance once SL would produce a larger amount, per in-service
 * month. The final month always takes whatever remains, so the schedule
 * ties to (cost - salvage) exactly regardless of rounding along the way.
 */
function decliningBalanceMonthlySchedule(asset: DepreciableAsset): Cents[] {
  const rate = decliningBalanceRateMultiplier(asset.method ?? 'straight_line') / asset.lifeMonths;
  let bookValue = asset.costCents;
  const schedule: Cents[] = [];
  for (let m = 1; m <= asset.lifeMonths; m++) {
    const remainingMonths = asset.lifeMonths - m + 1;
    const remainingDepreciable = bookValue - asset.salvageCents;
    if (remainingDepreciable <= 0) {
      schedule.push(0);
      continue;
    }
    let amount: Cents;
    if (m === asset.lifeMonths) {
      amount = remainingDepreciable;
    } else {
      const dbAmount = roundHalfUp(bookValue * rate);
      const slAmount = roundHalfUp(remainingDepreciable / remainingMonths);
      amount = Math.min(remainingDepreciable, Math.max(dbAmount, slAmount));
    }
    schedule.push(amount);
    bookValue -= amount;
  }
  return schedule;
}

function decliningBalanceCumulative(asset: DepreciableAsset, asOfIdx: number): Cents {
  // DB is stepped by whole in-service months; a fractional convention (mid_month,
  // half_year) is rounded to the nearest whole month for this method only.
  const n = Math.min(asset.lifeMonths, Math.max(0, Math.round(monthsElapsedCapped(asset, asOfIdx))));
  if (n <= 0) return 0;
  return sum(decliningBalanceMonthlySchedule(asset).slice(0, n));
}

function cumulativeAtIndex(asset: DepreciableAsset, idx: number): Cents {
  const method = asset.method ?? 'straight_line';
  return method === 'straight_line' ? straightLineCumulative(asset, idx) : decliningBalanceCumulative(asset, idx);
}

export function depreciationToDate(asset: DepreciableAsset, asOf: IsoDate): Cents {
  return cumulativeAtIndex(asset, monthIndex(asOf));
}

export function depreciationForPeriod(asset: DepreciableAsset, period: string): Cents {
  const idx = periodToIndex(period);
  return cumulativeAtIndex(asset, idx) - cumulativeAtIndex(asset, idx - 1);
}

// ---------------------------------------------------------------------------
// Amortization (intangibles, prepaids, deferred costs)
// ---------------------------------------------------------------------------

export interface AmortizationItem {
  amountCents: Cents;
  startDate: IsoDate;
  endDate: IsoDate; // inclusive
  /** Default 'monthly'. */
  proration?: 'monthly' | 'daily';
}

function monthlyAmortizationCumulative(item: AmortizationItem, asOfIdx: number): Cents {
  const startIdx = monthIndex(item.startDate);
  const endIdx = monthIndex(item.endDate);
  const totalMonths = endIdx - startIdx + 1;
  const n = Math.min(totalMonths, Math.max(0, asOfIdx - startIdx + 1));
  return roundHalfUp((item.amountCents * n) / totalMonths);
}

function dailyCumulative(totalCents: Cents, startDate: IsoDate, endDate: IsoDate, asOf: IsoDate): Cents {
  const totalDays = daysBetween(startDate, endDate, { inclusive: true });
  if (asOf < startDate) return 0;
  const capped = asOf > endDate ? endDate : asOf;
  const elapsedDays = daysBetween(startDate, capped, { inclusive: true });
  return roundHalfUp((totalCents * elapsedDays) / totalDays);
}

export function amortizationToDate(item: AmortizationItem, asOf: IsoDate): Cents {
  return (item.proration ?? 'monthly') === 'daily' ? dailyCumulative(item.amountCents, item.startDate, item.endDate, asOf) : monthlyAmortizationCumulative(item, monthIndex(asOf));
}

export function amortizationForPeriod(item: AmortizationItem, period: string): Cents {
  if ((item.proration ?? 'monthly') === 'daily') {
    const firstDay = `${period}-01`;
    const lastDay = monthEnd(firstDay);
    const before = addDays(firstDay, -1);
    return dailyCumulative(item.amountCents, item.startDate, item.endDate, lastDay) - dailyCumulative(item.amountCents, item.startDate, item.endDate, before);
  }
  const idx = periodToIndex(period);
  return monthlyAmortizationCumulative(item, idx) - monthlyAmortizationCumulative(item, idx - 1);
}

// ---------------------------------------------------------------------------
// Revenue recognition
// ---------------------------------------------------------------------------

export interface RatableRevenueContract {
  totalCents: Cents;
  startDate: IsoDate;
  endDate: IsoDate; // inclusive
}

/** Ratable recognition, prorated by the day so a full-term schedule ties to the cent. */
export function ratableRevenueToDate(contract: RatableRevenueContract, asOf: IsoDate): Cents {
  return dailyCumulative(contract.totalCents, contract.startDate, contract.endDate, asOf);
}

export function ratableRevenueForPeriod(contract: RatableRevenueContract, period: string): Cents {
  const firstDay = `${period}-01`;
  const lastDay = monthEnd(firstDay);
  const before = addDays(firstDay, -1);
  return ratableRevenueToDate(contract, lastDay) - ratableRevenueToDate(contract, before);
}

export interface PointInTimeRevenueItem {
  amountCents: Cents;
  recognitionDate: IsoDate;
}

export function pointInTimeRevenueToDate(item: PointInTimeRevenueItem, asOf: IsoDate): Cents {
  return asOf >= item.recognitionDate ? item.amountCents : 0;
}

export function pointInTimeRevenueForPeriod(item: PointInTimeRevenueItem, period: string): Cents {
  return item.recognitionDate.startsWith(`${period}-`) ? item.amountCents : 0;
}

export interface Milestone {
  amountCents: Cents;
  achievedOn: IsoDate;
}

export function milestoneRevenueToDate(milestones: readonly Milestone[], asOf: IsoDate): Cents {
  return sum(milestones.filter((m) => m.achievedOn <= asOf).map((m) => m.amountCents));
}

export function milestoneRevenueForPeriod(milestones: readonly Milestone[], period: string): Cents {
  return sum(milestones.filter((m) => m.achievedOn.startsWith(`${period}-`)).map((m) => m.amountCents));
}

// ---------------------------------------------------------------------------
// Prepaid expenses
// ---------------------------------------------------------------------------

export interface PrepaidItem {
  paidCents: Cents;
  coverageStart: IsoDate;
  coverageEnd: IsoDate; // inclusive
}

export function prepaidAmortizedToDate(item: PrepaidItem, asOf: IsoDate): Cents {
  return dailyCumulative(item.paidCents, item.coverageStart, item.coverageEnd, asOf);
}

export function prepaidAmortizedForPeriod(item: PrepaidItem, period: string): Cents {
  const firstDay = `${period}-01`;
  const lastDay = monthEnd(firstDay);
  const before = addDays(firstDay, -1);
  return prepaidAmortizedToDate(item, lastDay) - prepaidAmortizedToDate(item, before);
}

export function prepaidRemainingBalance(item: PrepaidItem, asOf: IsoDate): Cents {
  return item.paidCents - prepaidAmortizedToDate(item, asOf);
}

// ---------------------------------------------------------------------------
// Accrual estimates
// ---------------------------------------------------------------------------

export interface ReceivedNotInvoicedItem {
  amountCents: Cents;
}

/** Sums goods/services received but not yet invoiced — the classic GRNI accrual. */
export function estimateAccrualFromReceivedNotInvoiced(items: readonly ReceivedNotInvoicedItem[]): Cents {
  return sum(items.map((i) => i.amountCents));
}

/** Estimates a recurring expense accrual from its recent monthly run-rate. */
export function estimateAccrualFromRunRate(recentMonthlyAmountsCents: readonly Cents[]): Cents {
  if (recentMonthlyAmountsCents.length === 0) throw new Error('Need at least one period of run-rate history.');
  return roundHalfUp(sum(recentMonthlyAmountsCents) / recentMonthlyAmountsCents.length);
}

// ---------------------------------------------------------------------------
// Loan / lease interest split (fixed payment, effective interest)
// ---------------------------------------------------------------------------

export interface LoanPeriodSplit {
  interestCents: Cents;
  principalCents: Cents;
  endingBalanceCents: Cents;
}

/** One period's interest/principal split for a fixed payment against a periodic rate (bps). */
export function loanPaymentSplit(beginningBalanceCents: Cents, periodicRateBps: number, paymentCents: Cents): LoanPeriodSplit {
  const interestCents = roundHalfUp((beginningBalanceCents * periodicRateBps) / 10000);
  const principalCents = Math.min(beginningBalanceCents, paymentCents - interestCents);
  return { interestCents, principalCents, endingBalanceCents: beginningBalanceCents - principalCents };
}

/** Full amortization table; the final period retires the loan exactly, absorbing rounding. */
export function loanAmortizationSchedule(principalCents: Cents, periodicRateBps: number, paymentCents: Cents, numPeriods: number): LoanPeriodSplit[] {
  const rows: LoanPeriodSplit[] = [];
  let balance = principalCents;
  for (let i = 0; i < numPeriods; i++) {
    if (i === numPeriods - 1) {
      const interestCents = roundHalfUp((balance * periodicRateBps) / 10000);
      rows.push({ interestCents, principalCents: balance, endingBalanceCents: 0 });
      balance = 0;
    } else {
      const row = loanPaymentSplit(balance, periodicRateBps, paymentCents);
      rows.push(row);
      balance = row.endingBalanceCents;
    }
  }
  return rows;
}
