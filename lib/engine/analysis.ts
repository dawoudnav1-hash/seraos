import type { Cents, SourceRef, Txn } from './types';

/**
 * Deterministic analysis engine. Every finding follows the reasoning
 * hierarchy Facts → Observations → Patterns and is evidence-backed. No
 * causal language ("caused", "because", "due to") — only "associated with",
 * since correlation in the numbers is all this engine can establish.
 */

export type FindingType = 'fact' | 'observation' | 'pattern';

export interface Finding {
  type: FindingType;
  text: string;
  valueCents?: Cents;
  /** Row keys, ids, or full source refs — whatever grounds this finding in the input. */
  evidence: SourceRef[] | string[];
  /** 0..1 */
  confidence: number;
}

function money(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export interface ColumnSchema {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  required?: boolean;
}

export interface DataQualityResult {
  score: number;
  rowCount: number;
  nullsByColumn: Record<string, number>;
  duplicates: { key: string; rowIndexes: number[] }[];
  typeMismatches: { rowIndex: number; column: string; expected: string; found: string }[];
  droppedRows: { rowIndex: number; reason: string }[];
  findings: Finding[];
}

function matchesType(v: unknown, type: ColumnSchema['type']): boolean {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  }
}

/** Row-level quality scan: nulls, duplicates, type mismatches, and every dropped row with a reason. */
export function dataQuality(rows: Record<string, unknown>[], schema: ColumnSchema[]): DataQualityResult {
  const nullsByColumn: Record<string, number> = {};
  for (const col of schema) nullsByColumn[col.name] = 0;
  const typeMismatches: DataQualityResult['typeMismatches'] = [];
  const droppedRows: DataQualityResult['droppedRows'] = [];
  const seen = new Map<string, number[]>();

  rows.forEach((row, i) => {
    let dropReason: string | null = null;
    for (const col of schema) {
      const v = row[col.name];
      const isNull = v === null || v === undefined || v === '';
      if (isNull) {
        nullsByColumn[col.name]++;
        if (col.required) dropReason = `missing required column "${col.name}"`;
        continue;
      }
      if (!matchesType(v, col.type)) {
        typeMismatches.push({ rowIndex: i, column: col.name, expected: col.type, found: typeof v });
      }
    }
    const key = schema.map((c) => String(row[c.name] ?? '')).join('|');
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(i);
    if (dropReason) droppedRows.push({ rowIndex: i, reason: dropReason });
  });

  const duplicates = [...seen.entries()].filter(([, idxs]) => idxs.length > 1).map(([key, rowIndexes]) => ({ key, rowIndexes }));

  const totalCells = Math.max(rows.length * schema.length, 1);
  const nullCells = Object.values(nullsByColumn).reduce((s, n) => s + n, 0);
  const dupExtras = duplicates.reduce((s, d) => s + (d.rowIndexes.length - 1), 0);
  const issues = nullCells + typeMismatches.length + dupExtras * 2 + droppedRows.length * 2;
  const score = rows.length === 0 ? 100 : Math.max(0, Math.round(100 - (issues / totalCells) * 100));

  const findings: Finding[] = [
    { type: 'fact', text: `Data quality score is ${score} out of 100 across ${rows.length} row(s) and ${schema.length} column(s).`, evidence: [], confidence: 1 },
  ];
  if (droppedRows.length > 0) {
    findings.push({
      type: 'observation',
      text: `${droppedRows.length} row(s) were dropped, each with an explicit reason recorded; none were dropped silently.`,
      evidence: droppedRows.map((d) => `row:${d.rowIndex}`),
      confidence: 1,
    });
  }
  if (duplicates.length > 0) {
    findings.push({
      type: 'observation',
      text: `${duplicates.length} duplicate row group(s) were found, associated with ${dupExtras} redundant row(s).`,
      evidence: duplicates.flatMap((d) => d.rowIndexes.map((r) => `row:${r}`)),
      confidence: 0.9,
    });
  }

  return { score, rowCount: rows.length, nullsByColumn, duplicates, typeMismatches, droppedRows, findings };
}

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

export interface DescribeResult {
  count: number;
  mean: number;
  median: number;
  stdev: number;
  percentiles: Record<25 | 50 | 75 | 90 | 95 | 99, number>;
  iqr: number;
  zScores: number[];
  outliers: { index: number; value: number; zScore: number; method: 'z' | 'iqr' }[];
}

/** Mean, median, population stdev, percentiles (linear interpolation), IQR, z-scores and outliers by both methods. */
export function describe(values: number[]): DescribeResult {
  const n = values.length;
  if (n === 0) {
    return { count: 0, mean: 0, median: 0, stdev: 0, percentiles: { 25: 0, 50: 0, 75: 0, 90: 0, 95: 0, 99: 0 }, iqr: 0, zScores: [], outliers: [] };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const percentile = (p: number): number => {
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const percentiles = { 25: percentile(25), 50: percentile(50), 75: percentile(75), 90: percentile(90), 95: percentile(95), 99: percentile(99) } as const;
  const iqr = percentiles[75] - percentiles[25];
  const zScores = values.map((v) => (stdev === 0 ? 0 : (v - mean) / stdev));
  const lowerFence = percentiles[25] - 1.5 * iqr;
  const upperFence = percentiles[75] + 1.5 * iqr;
  const outliers: DescribeResult['outliers'] = [];
  values.forEach((v, i) => {
    const z = zScores[i];
    if (Math.abs(z) > 3) outliers.push({ index: i, value: v, zScore: z, method: 'z' });
    else if (v < lowerFence || v > upperFence) outliers.push({ index: i, value: v, zScore: z, method: 'iqr' });
  });
  return { count: n, mean, median: percentiles[50], stdev, percentiles, iqr, zScores, outliers };
}

// ---------------------------------------------------------------------------
// Flux (period-over-period change by account)
// ---------------------------------------------------------------------------

export interface FluxRow {
  account: string;
  amountCents: Cents;
  evidence?: SourceRef[];
}

export interface FluxOptions {
  absThresholdCents: Cents;
  /** Percentage threshold expressed in basis points (500 = 5%). */
  pctThresholdBps: number;
}

export interface FluxResult {
  account: string;
  currentCents: Cents;
  priorCents: Cents;
  changeCents: Cents;
  /** Percent change, or null when the prior balance was zero (percent change is undefined). */
  changePct: number | null;
  flagged: boolean;
  findings: Finding[];
}

/** Change by account, flagged only when both the absolute and percentage thresholds are met (percentage waived when prior = 0). */
export function flux(current: FluxRow[], prior: FluxRow[], opts: FluxOptions): FluxResult[] {
  const byAccount = new Map<string, { current: Cents; prior: Cents; evidence: SourceRef[] }>();
  for (const r of current) {
    const e = byAccount.get(r.account) ?? { current: 0, prior: 0, evidence: [] };
    e.current += r.amountCents;
    if (r.evidence) e.evidence.push(...r.evidence);
    byAccount.set(r.account, e);
  }
  for (const r of prior) {
    const e = byAccount.get(r.account) ?? { current: 0, prior: 0, evidence: [] };
    e.prior += r.amountCents;
    if (r.evidence) e.evidence.push(...r.evidence);
    byAccount.set(r.account, e);
  }

  const pctThresholdPct = opts.pctThresholdBps / 100;
  const results: FluxResult[] = [];
  for (const [account, e] of [...byAccount.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const changeCents = e.current - e.prior;
    const changePct = e.prior === 0 ? null : (changeCents / Math.abs(e.prior)) * 100;
    const absFlag = Math.abs(changeCents) >= opts.absThresholdCents;
    const pctFlag = changePct !== null && Math.abs(changePct) >= pctThresholdPct;
    const flagged = changeCents !== 0 && absFlag && (e.prior === 0 ? true : pctFlag);

    const findings: Finding[] = [];
    if (flagged) {
      const pctText = changePct === null ? 'from a zero prior-period base' : `${changePct.toFixed(1)}%`;
      findings.push({
        type: 'observation',
        text: `${account} changed by ${money(changeCents)} (${pctText}), associated with a prior-period balance of ${money(e.prior)}.`,
        valueCents: changeCents,
        evidence: e.evidence,
        confidence: 0.85,
      });
    }
    results.push({ account, currentCents: e.current, priorCents: e.prior, changeCents, changePct, flagged, findings });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Variance / budget vs actual
// ---------------------------------------------------------------------------

export type AccountType = 'revenue' | 'expense' | 'asset' | 'liability' | 'equity';

export interface VarianceRow {
  account: string;
  accountType: AccountType;
  amountCents: Cents;
  dims?: Record<string, string>;
}

export interface VarianceResult {
  key: string;
  account: string;
  accountType: AccountType;
  dims: Record<string, string>;
  actualCents: Cents;
  budgetCents: Cents;
  varianceCents: Cents;
  variancePct: number | null;
  favorable: boolean;
}

export interface BudgetVsActualResult {
  rows: VarianceResult[];
  /** Smallest set of rows, by |variance| descending, whose cumulative |variance| reaches >= 80% of the total. */
  paretoContributors: VarianceResult[];
  paretoCoveragePct: number;
  findings: Finding[];
}

function dimsKey(account: string, dims: Record<string, string>): string {
  const parts = Object.keys(dims).sort().map((k) => `${k}=${dims[k]}`);
  return [account, ...parts].join('|');
}

/** Actual vs budget by account (and optional dimensions), with favorability by account type and a Pareto cut of top drivers. */
export function budgetVsActual(actual: VarianceRow[], budget: VarianceRow[], dims: string[] = []): BudgetVsActualResult {
  const byKey = new Map<string, { account: string; accountType: AccountType; dims: Record<string, string>; actual: Cents; budget: Cents }>();
  const pick = (r: VarianceRow): Record<string, string> => {
    const picked: Record<string, string> = {};
    for (const d of dims) if (r.dims?.[d] !== undefined) picked[d] = r.dims[d];
    return picked;
  };
  for (const r of actual) {
    const picked = pick(r);
    const key = dimsKey(r.account, picked);
    const e = byKey.get(key) ?? { account: r.account, accountType: r.accountType, dims: picked, actual: 0, budget: 0 };
    e.actual += r.amountCents;
    byKey.set(key, e);
  }
  for (const r of budget) {
    const picked = pick(r);
    const key = dimsKey(r.account, picked);
    const e = byKey.get(key) ?? { account: r.account, accountType: r.accountType, dims: picked, actual: 0, budget: 0 };
    e.budget += r.amountCents;
    byKey.set(key, e);
  }

  const rows: VarianceResult[] = [...byKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, e]) => {
      const varianceCents = e.actual - e.budget;
      const variancePct = e.budget === 0 ? null : (varianceCents / Math.abs(e.budget)) * 100;
      const favorable = e.accountType === 'revenue' ? varianceCents >= 0 : varianceCents <= 0;
      return { key, account: e.account, accountType: e.accountType, dims: e.dims, actualCents: e.actual, budgetCents: e.budget, varianceCents, variancePct, favorable };
    });

  const totalAbsVariance = rows.reduce((s, r) => s + Math.abs(r.varianceCents), 0);
  if (totalAbsVariance === 0) {
    return { rows, paretoContributors: [], paretoCoveragePct: 0, findings: [] };
  }

  const byAbsDesc = [...rows].sort((a, b) => Math.abs(b.varianceCents) - Math.abs(a.varianceCents) || a.key.localeCompare(b.key));
  const paretoContributors: VarianceResult[] = [];
  let cum = 0;
  for (const r of byAbsDesc) {
    if (cum / totalAbsVariance >= 0.8) break;
    paretoContributors.push(r);
    cum += Math.abs(r.varianceCents);
  }
  const paretoCoveragePct = (cum / totalAbsVariance) * 100;

  const findings: Finding[] = [
    {
      type: 'pattern',
      text: `${paretoContributors.length} of ${rows.length} account(s) — ${paretoContributors.map((r) => r.account).join(', ')} — account for ${paretoCoveragePct.toFixed(1)}% of total variance.`,
      valueCents: cum,
      evidence: paretoContributors.map((r) => r.key),
      confidence: 0.8,
    },
  ];

  return { rows, paretoContributors, paretoCoveragePct, findings };
}

// ---------------------------------------------------------------------------
// Period over period
// ---------------------------------------------------------------------------

export interface PeriodPoint {
  /** Sortable period label, e.g. "2026-01" for months. */
  period: string;
  valueCents: Cents;
}

export interface PeriodOverPeriodResult extends PeriodPoint {
  momPct: number | null;
  qoqPct: number | null;
  yoyPct: number | null;
  ma3: number | null;
  ma6: number | null;
  ma12: number | null;
}

/** MoM/QoQ/YoY percent change and 3/6/12-period moving averages, assuming one evenly-spaced point per period, sorted. */
export function periodOverPeriod(series: PeriodPoint[]): PeriodOverPeriodResult[] {
  const sorted = [...series].sort((a, b) => a.period.localeCompare(b.period));
  const pctChange = (curr: Cents, prev: Cents | undefined): number | null => {
    if (prev === undefined || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };
  const movingAvg = (idx: number, window: number): number | null => {
    if (idx + 1 < window) return null;
    const slice = sorted.slice(idx + 1 - window, idx + 1);
    return slice.reduce((s, p) => s + p.valueCents, 0) / window;
  };
  return sorted.map((p, i) => ({
    period: p.period,
    valueCents: p.valueCents,
    momPct: pctChange(p.valueCents, sorted[i - 1]?.valueCents),
    qoqPct: pctChange(p.valueCents, sorted[i - 3]?.valueCents),
    yoyPct: pctChange(p.valueCents, sorted[i - 12]?.valueCents),
    ma3: movingAvg(i, 3),
    ma6: movingAvg(i, 6),
    ma12: movingAvg(i, 12),
  }));
}

// ---------------------------------------------------------------------------
// Revenue / expense analysis
// ---------------------------------------------------------------------------

export interface GroupTotal {
  key: string;
  totalCents: Cents;
  mixPct: number;
  count: number;
}

export interface ConcentrationResult {
  topKey: string | null;
  topShareCents: Cents;
  topSharePct: number;
}

export interface RevenueExpenseResult {
  totalCents: Cents;
  byGroup: GroupTotal[];
  topN: GroupTotal[];
  concentration: ConcentrationResult;
  growthPct: number | null;
  findings: Finding[];
}

function analyzeTxns(txns: Txn[], groupBy: (t: Txn) => string, topN: number, priorTotalCents: Cents | undefined, kind: 'revenue' | 'expense'): RevenueExpenseResult {
  const totals = new Map<string, { cents: Cents; count: number }>();
  for (const t of txns) {
    const key = groupBy(t);
    const e = totals.get(key) ?? { cents: 0, count: 0 };
    e.cents += Math.abs(t.amountCents);
    e.count += 1;
    totals.set(key, e);
  }
  const totalCents = [...totals.values()].reduce((s, e) => s + e.cents, 0);
  const byGroup: GroupTotal[] = [...totals.entries()]
    .map(([key, e]) => ({ key, totalCents: e.cents, mixPct: totalCents === 0 ? 0 : (e.cents / totalCents) * 100, count: e.count }))
    .sort((a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key));
  const top = byGroup[0] ?? null;
  const concentration: ConcentrationResult = { topKey: top?.key ?? null, topShareCents: top?.totalCents ?? 0, topSharePct: top?.mixPct ?? 0 };
  const growthPct = priorTotalCents === undefined || priorTotalCents === 0 ? null : ((totalCents - priorTotalCents) / Math.abs(priorTotalCents)) * 100;

  const findings: Finding[] = [
    { type: 'fact', text: `Total ${kind} across ${txns.length} transaction(s) is ${money(totalCents)}.`, valueCents: totalCents, evidence: txns.map((t) => t.id), confidence: 1 },
  ];
  if (top && concentration.topSharePct >= 25) {
    findings.push({
      type: 'observation',
      text: `${top.key} is associated with ${concentration.topSharePct.toFixed(1)}% of total ${kind}, the largest concentration among ${byGroup.length} group(s).`,
      valueCents: top.totalCents,
      evidence: [top.key],
      confidence: 0.85,
    });
  }
  if (growthPct !== null) {
    findings.push({
      type: 'observation',
      text: `Total ${kind} changed ${growthPct.toFixed(1)}% versus the prior period total of ${money(priorTotalCents!)}.`,
      valueCents: totalCents - priorTotalCents!,
      evidence: [],
      confidence: 0.85,
    });
  }

  return { totalCents, byGroup, topN: byGroup.slice(0, topN), concentration, growthPct, findings };
}

export function revenueAnalysis(txns: Txn[], groupBy: (t: Txn) => string, opts: { topN?: number; priorTotalCents?: Cents } = {}): RevenueExpenseResult {
  return analyzeTxns(txns, groupBy, opts.topN ?? 5, opts.priorTotalCents, 'revenue');
}

export function expenseAnalysis(txns: Txn[], groupBy: (t: Txn) => string, opts: { topN?: number; priorTotalCents?: Cents } = {}): RevenueExpenseResult {
  return analyzeTxns(txns, groupBy, opts.topN ?? 5, opts.priorTotalCents, 'expense');
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

export interface WaterfallDriver {
  label: string;
  deltaCents: Cents;
  evidence?: SourceRef[];
}

export interface WaterfallStep {
  label: string;
  deltaCents: Cents;
  runningTotalCents: Cents;
}

export interface WaterfallResult {
  startCents: Cents;
  endCents: Cents;
  steps: WaterfallStep[];
  /** start + sum(drivers) */
  expectedEndCents: Cents;
  /** endCents - expectedEndCents; nonzero means the drivers don't fully explain the change. */
  residualCents: Cents;
  reconciles: boolean;
  findings: Finding[];
}

/** Bridges start to end through named drivers, with the unexplained residual shown explicitly rather than absorbed. */
export function waterfall(startCents: Cents, drivers: WaterfallDriver[], endCents: Cents): WaterfallResult {
  let running = startCents;
  const steps: WaterfallStep[] = drivers.map((d) => {
    running += d.deltaCents;
    return { label: d.label, deltaCents: d.deltaCents, runningTotalCents: running };
  });
  const expectedEndCents = running;
  const residualCents = endCents - expectedEndCents;
  const reconciles = residualCents === 0;

  const findings: Finding[] = [
    {
      type: 'fact',
      text: `Start ${money(startCents)} plus ${drivers.length} driver(s) totals ${money(expectedEndCents)}; the stated end is ${money(endCents)}.`,
      valueCents: expectedEndCents,
      evidence: drivers.flatMap((d) => d.evidence ?? []),
      confidence: 1,
    },
  ];
  if (!reconciles) {
    findings.push({
      type: 'observation',
      text: `An unexplained residual of ${money(residualCents)} remains between the driver-based total and the stated end balance.`,
      valueCents: residualCents,
      evidence: [],
      confidence: 0.9,
    });
  }

  return { startCents, endCents, steps, expectedEndCents, residualCents, reconciles, findings };
}
