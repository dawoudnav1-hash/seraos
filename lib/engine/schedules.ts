/**
 * Roll-forwards and schedules. Every schedule reduces to opening + movements
 * = closing, checked against the GL where one is supplied. Rows are shaped
 * to drop straight into a spreadsheet workpaper.
 */

import type { Cents, IsoDate, SourceRef } from '@/lib/engine/types';
import { monthEnd, periodsInRange } from '@/lib/engine/primitives';
import {
  amortizationForPeriod,
  amortizationToDate,
  type AmortizationItem,
  depreciationForPeriod,
  depreciationToDate,
  type DepreciableAsset,
  prepaidAmortizedForPeriod,
  prepaidRemainingBalance,
  type PrepaidItem,
  ratableRevenueForPeriod,
  ratableRevenueToDate,
  type RatableRevenueContract,
} from '@/lib/engine/calc';

// ---------------------------------------------------------------------------
// Generic roll-forward
// ---------------------------------------------------------------------------

export type MovementKind = 'addition' | 'reduction' | 'depreciation' | 'amortization' | 'recognition' | 'disposal' | 'adjustment';

export interface Movement {
  kind: MovementKind;
  /** The movement's signed effect on the balance — generators below choose the sign for their domain. */
  amountCents: Cents;
  date: IsoDate;
  sources: SourceRef[];
  label?: string;
}

export interface RollForwardInput {
  opening: Cents;
  movements: Movement[];
  glBalance?: Cents;
}

export interface RollForwardResult {
  opening: Cents;
  byKind: Partial<Record<MovementKind, Cents>>;
  movements: Movement[];
  closing: Cents;
  tiesToGl: boolean | null;
  differenceCents: Cents | null;
}

/** opening + sum(movements) = closing; movements never get their sign guessed here. */
export function rollForward(input: RollForwardInput): RollForwardResult {
  const byKind: Partial<Record<MovementKind, Cents>> = {};
  for (const m of input.movements) byKind[m.kind] = (byKind[m.kind] ?? 0) + m.amountCents;
  const movementTotal = input.movements.reduce((s, m) => s + m.amountCents, 0);
  const closing = input.opening + movementTotal;
  const tiesToGl = input.glBalance === undefined ? null : closing === input.glBalance;
  const differenceCents = input.glBalance === undefined ? null : input.glBalance - closing;
  return { opening: input.opening, byKind, movements: input.movements, closing, tiesToGl, differenceCents };
}

// ---------------------------------------------------------------------------
// Fixed-asset roll-forward, by class
// ---------------------------------------------------------------------------

export interface FixedAssetClassActivity {
  class: string;
  openingCostCents: Cents;
  openingAccumCents: Cents;
  additions: { amountCents: Cents; date: IsoDate; sources: SourceRef[] }[];
  disposals: { costCents: Cents; accumCents: Cents; date: IsoDate; sources: SourceRef[] }[];
  depreciation: { amountCents: Cents; date: IsoDate; sources: SourceRef[] }[];
  glCostBalance?: Cents;
  glAccumBalance?: Cents;
}

export interface FixedAssetRollForwardRow {
  class: string;
  cost: RollForwardResult;
  accumulatedDepreciation: RollForwardResult;
  netBookValueOpening: Cents;
  netBookValueClosing: Cents;
}

export function fixedAssetRollForward(activity: FixedAssetClassActivity[]): {
  rows: FixedAssetRollForwardRow[];
  totals: { costClosing: Cents; accumClosing: Cents; nbvClosing: Cents };
} {
  const rows = activity.map((a): FixedAssetRollForwardRow => {
    const cost = rollForward({
      opening: a.openingCostCents,
      movements: [
        ...a.additions.map((x) => ({ kind: 'addition' as const, amountCents: x.amountCents, date: x.date, sources: x.sources })),
        ...a.disposals.map((x) => ({ kind: 'disposal' as const, amountCents: -x.costCents, date: x.date, sources: x.sources })),
      ],
      glBalance: a.glCostBalance,
    });
    const accumulatedDepreciation = rollForward({
      opening: a.openingAccumCents,
      movements: [
        ...a.depreciation.map((x) => ({ kind: 'depreciation' as const, amountCents: x.amountCents, date: x.date, sources: x.sources })),
        ...a.disposals.map((x) => ({ kind: 'disposal' as const, amountCents: -x.accumCents, date: x.date, sources: x.sources })),
      ],
      glBalance: a.glAccumBalance,
    });
    return {
      class: a.class,
      cost,
      accumulatedDepreciation,
      netBookValueOpening: a.openingCostCents - a.openingAccumCents,
      netBookValueClosing: cost.closing - accumulatedDepreciation.closing,
    };
  });
  const totals = rows.reduce(
    (t, r) => ({
      costClosing: t.costClosing + r.cost.closing,
      accumClosing: t.accumClosing + r.accumulatedDepreciation.closing,
      nbvClosing: t.nbvClosing + r.netBookValueClosing,
    }),
    { costClosing: 0, accumClosing: 0, nbvClosing: 0 },
  );
  return { rows, totals };
}

// ---------------------------------------------------------------------------
// Per-asset / per-item monthly schedules
// ---------------------------------------------------------------------------

export interface PeriodRange {
  fromPeriod: string;
  toPeriod: string;
}

export interface DepreciationScheduleRow {
  assetId: string;
  period: string;
  openingAccumCents: Cents;
  depreciationCents: Cents;
  closingAccumCents: Cents;
}

export function depreciationSchedule(assets: readonly (DepreciableAsset & { id: string })[], range: PeriodRange): { rows: DepreciationScheduleRow[]; totalDepreciationCents: Cents } {
  const periods = periodsInRange(range.fromPeriod, range.toPeriod);
  const rows: DepreciationScheduleRow[] = [];
  for (const asset of assets) {
    for (const period of periods) {
      const periodEndDate = monthEnd(`${period}-01`);
      const closingAccumCents = depreciationToDate(asset, periodEndDate);
      const depreciationCents = depreciationForPeriod(asset, period);
      rows.push({ assetId: asset.id, period, openingAccumCents: closingAccumCents - depreciationCents, depreciationCents, closingAccumCents });
    }
  }
  return { rows, totalDepreciationCents: rows.reduce((s, r) => s + r.depreciationCents, 0) };
}

export interface AmortizationScheduleRow {
  itemId: string;
  period: string;
  openingBalanceCents: Cents;
  amortizationCents: Cents;
  closingBalanceCents: Cents;
}

export function amortizationSchedule(items: readonly (AmortizationItem & { id: string })[], range: PeriodRange): { rows: AmortizationScheduleRow[]; totalAmortizationCents: Cents } {
  const periods = periodsInRange(range.fromPeriod, range.toPeriod);
  const rows: AmortizationScheduleRow[] = [];
  for (const item of items) {
    for (const period of periods) {
      const periodEndDate = monthEnd(`${period}-01`);
      const closingCumCents = amortizationToDate(item, periodEndDate);
      const amortizationCents = amortizationForPeriod(item, period);
      rows.push({
        itemId: item.id,
        period,
        openingBalanceCents: item.amountCents - (closingCumCents - amortizationCents),
        amortizationCents,
        closingBalanceCents: item.amountCents - closingCumCents,
      });
    }
  }
  return { rows, totalAmortizationCents: rows.reduce((s, r) => s + r.amortizationCents, 0) };
}

// ---------------------------------------------------------------------------
// Deferred revenue
// ---------------------------------------------------------------------------

export interface DeferredRevenueContract extends RatableRevenueContract {
  id: string;
  billedCents: Cents;
}

export interface DeferredRevenueScheduleRow {
  contractId: string;
  period: string;
  recognizedCents: Cents;
  recognizedToDateCents: Cents;
  /** billed − recognized to date. */
  endingBalanceCents: Cents;
}

export function deferredRevenueSchedule(contracts: readonly DeferredRevenueContract[], range: PeriodRange): { rows: DeferredRevenueScheduleRow[] } {
  const periods = periodsInRange(range.fromPeriod, range.toPeriod);
  const rows: DeferredRevenueScheduleRow[] = [];
  for (const c of contracts) {
    for (const period of periods) {
      const periodEndDate = monthEnd(`${period}-01`);
      const recognizedToDateCents = ratableRevenueToDate(c, periodEndDate);
      const recognizedCents = ratableRevenueForPeriod(c, period);
      rows.push({ contractId: c.id, period, recognizedCents, recognizedToDateCents, endingBalanceCents: c.billedCents - recognizedToDateCents });
    }
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Prepaid schedule
// ---------------------------------------------------------------------------

export interface PrepaidScheduleRow {
  itemId: string;
  period: string;
  amortizedCents: Cents;
  remainingBalanceCents: Cents;
}

export function prepaidSchedule(items: readonly (PrepaidItem & { id: string })[], range: PeriodRange): { rows: PrepaidScheduleRow[] } {
  const periods = periodsInRange(range.fromPeriod, range.toPeriod);
  const rows: PrepaidScheduleRow[] = [];
  for (const item of items) {
    for (const period of periods) {
      const periodEndDate = monthEnd(`${period}-01`);
      rows.push({
        itemId: item.id,
        period,
        amortizedCents: prepaidAmortizedForPeriod(item, period),
        remainingBalanceCents: prepaidRemainingBalance(item, periodEndDate),
      });
    }
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Accrual schedule
// ---------------------------------------------------------------------------

export interface AccrualRecord {
  id: string;
  amountCents: Cents;
  date: IsoDate;
  reversesOn: IsoDate;
  sources: SourceRef[];
}

export function accrualSchedule(accruals: readonly AccrualRecord[], asOf: IsoDate): { open: AccrualRecord[]; reversed: AccrualRecord[]; openTotalCents: Cents; reversedTotalCents: Cents } {
  const open = accruals.filter((a) => a.reversesOn > asOf);
  const reversed = accruals.filter((a) => a.reversesOn <= asOf);
  return {
    open,
    reversed,
    openTotalCents: open.reduce((s, a) => s + a.amountCents, 0),
    reversedTotalCents: reversed.reduce((s, a) => s + a.amountCents, 0),
  };
}

// ---------------------------------------------------------------------------
// Balance-sheet account roll-forward vs. reported/GL balance
// ---------------------------------------------------------------------------

export interface BalanceSheetActivity {
  amountCents: Cents;
  date: IsoDate;
  sources: SourceRef[];
  kind?: MovementKind;
}

export interface BalanceSheetRollForwardInput {
  account: string;
  opening: Cents;
  activity: BalanceSheetActivity[];
  reportedClosing?: Cents;
}

export function balanceSheetRollForward(input: BalanceSheetRollForwardInput): RollForwardResult & { account: string } {
  const result = rollForward({
    opening: input.opening,
    movements: input.activity.map((a) => ({ kind: a.kind ?? 'adjustment', amountCents: a.amountCents, date: a.date, sources: a.sources })),
    glBalance: input.reportedClosing,
  });
  return { ...result, account: input.account };
}
