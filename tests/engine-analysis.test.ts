import { describe, expect, it } from 'vitest';
import type { Txn } from '@/lib/engine/types';
import {
  budgetVsActual,
  dataQuality,
  describe as describeStats,
  expenseAnalysis,
  flux,
  periodOverPeriod,
  revenueAnalysis,
  waterfall,
  type ColumnSchema,
  type Finding,
} from '@/lib/engine/analysis';

function mkTxn(id: string, date: string, amountCents: number, opts: Partial<Omit<Txn, 'id' | 'date' | 'amountCents'>> = {}): Txn {
  return {
    id,
    date,
    amountCents,
    description: opts.description ?? id,
    counterparty: opts.counterparty,
    reference: opts.reference,
    source: { system: 'test', id },
  };
}

const CAUSAL_WORDS = /\b(caused|causes?d?\b|because|due to)\b/i;
function assertNoCausalLanguage(findings: Finding[]): void {
  for (const f of findings) expect(f.text).not.toMatch(CAUSAL_WORDS);
}

describe('dataQuality', () => {
  const schema: ColumnSchema[] = [
    { name: 'date', type: 'date', required: true },
    { name: 'amount', type: 'number', required: true },
    { name: 'vendor', type: 'string' },
  ];
  const rows: Record<string, unknown>[] = [
    { date: '2026-01-01', amount: 100, vendor: 'Acme' },
    { date: '2026-01-02', amount: 200, vendor: 'Beta' },
    { date: '2026-01-01', amount: 100, vendor: 'Acme' }, // duplicate of row 0
    { date: null, amount: 300, vendor: 'Gamma' }, // missing required date -> dropped
    { date: '2026-01-04', amount: '400', vendor: 'Delta' }, // type mismatch, not dropped
    { date: '2026-01-05', amount: 500, vendor: null }, // null optional column
  ];

  it('scores rows, counts nulls per column, finds duplicates and type mismatches, and drops only rows missing a required field', () => {
    const result = dataQuality(rows, schema);
    expect(result.nullsByColumn).toEqual({ date: 1, amount: 0, vendor: 1 });
    expect(result.duplicates).toEqual([{ key: '2026-01-01|100|Acme', rowIndexes: [0, 2] }]);
    expect(result.typeMismatches).toEqual([{ rowIndex: 4, column: 'amount', expected: 'number', found: 'string' }]);
    expect(result.droppedRows).toEqual([{ rowIndex: 3, reason: 'missing required column "date"' }]);
    expect(result.score).toBe(61);
  });

  it('never drops a row silently — every dropped row carries a reason', () => {
    const result = dataQuality(rows, schema);
    expect(result.droppedRows.length).toBeGreaterThan(0);
    for (const d of result.droppedRows) expect(d.reason.length).toBeGreaterThan(0);
    assertNoCausalLanguage(result.findings);
  });

  it('is deterministic for the same input', () => {
    expect(dataQuality(structuredClone(rows), schema)).toEqual(dataQuality(structuredClone(rows), schema));
  });
});

describe('describe (descriptive statistics)', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];

  it('computes mean, median, population stdev, percentiles and IQR', () => {
    const d = describeStats(values);
    expect(d.count).toBe(8);
    expect(d.mean).toBe(5);
    expect(d.median).toBe(4.5);
    expect(d.stdev).toBe(2);
    expect(d.percentiles[25]).toBe(4);
    expect(d.percentiles[75]).toBe(5.5);
    expect(d.iqr).toBe(1.5);
  });

  it('flags the 9 as an IQR outlier but not a z-score outlier (|z| = 2 < 3)', () => {
    const d = describeStats(values);
    expect(d.outliers).toEqual([{ index: 7, value: 9, zScore: 2, method: 'iqr' }]);
  });

  it('handles the empty array without throwing', () => {
    const d = describeStats([]);
    expect(d).toMatchObject({ count: 0, mean: 0, median: 0, stdev: 0, outliers: [] });
  });
});

describe('flux', () => {
  const current = [
    { account: '6100', amountCents: 12000 },
    { account: '6200', amountCents: 10500 },
    { account: '6300', amountCents: 5000 },
  ];
  const prior = [
    { account: '6100', amountCents: 10000 },
    { account: '6200', amountCents: 10000 },
    // 6300 has no prior-period activity at all: prior = 0.
  ];
  const result = flux(current, prior, { absThresholdCents: 1000, pctThresholdBps: 500 });
  const byAccount = Object.fromEntries(result.map((r) => [r.account, r]));

  it('flags a change that clears both the absolute and percentage thresholds', () => {
    expect(byAccount['6100']).toMatchObject({ currentCents: 12000, priorCents: 10000, changeCents: 2000, changePct: 20, flagged: true });
  });

  it('does not flag a change that clears the percentage threshold but not the absolute one (both are required)', () => {
    expect(byAccount['6200']).toMatchObject({ currentCents: 10500, priorCents: 10000, changeCents: 500, changePct: 5, flagged: false });
  });

  it('handles prior = 0 by waiving the percentage check (which is undefined) and flagging on the absolute threshold alone', () => {
    expect(byAccount['6300']).toMatchObject({ currentCents: 5000, priorCents: 0, changeCents: 5000, changePct: null, flagged: true });
  });

  it('every flagged row carries an evidence-backed, non-causal finding', () => {
    const flagged = result.filter((r) => r.flagged);
    expect(flagged.length).toBeGreaterThan(0);
    for (const r of flagged) expect(r.findings.length).toBeGreaterThan(0);
    assertNoCausalLanguage(result.flatMap((r) => r.findings));
  });
});

describe('budgetVsActual — Pareto contributors', () => {
  const actual = [
    { account: 'Payroll', accountType: 'expense' as const, amountCents: 500000 },
    { account: 'Rent', accountType: 'expense' as const, amountCents: 200000 },
    { account: 'Travel', accountType: 'expense' as const, amountCents: 150000 },
    { account: 'Office Supplies', accountType: 'expense' as const, amountCents: 12000 },
    { account: 'Software', accountType: 'expense' as const, amountCents: 30500 },
  ];
  const budget = [
    { account: 'Payroll', accountType: 'expense' as const, amountCents: 400000 },
    { account: 'Rent', accountType: 'expense' as const, amountCents: 200000 },
    { account: 'Travel', accountType: 'expense' as const, amountCents: 100000 },
    { account: 'Office Supplies', accountType: 'expense' as const, amountCents: 10000 },
    { account: 'Software', accountType: 'expense' as const, amountCents: 30000 },
  ];

  it('computes variance abs/% and favorability by account type', () => {
    const { rows } = budgetVsActual(actual, budget);
    const payroll = rows.find((r) => r.account === 'Payroll')!;
    expect(payroll).toMatchObject({ actualCents: 500000, budgetCents: 400000, varianceCents: 100000, variancePct: 25, favorable: false });
  });

  it('finds the smallest set of accounts explaining at least 80% of total variance', () => {
    const { paretoContributors, paretoCoveragePct } = budgetVsActual(actual, budget);
    expect(paretoContributors.map((r) => r.account)).toEqual(['Payroll', 'Travel']);
    expect(paretoCoveragePct).toBeCloseTo(98.36, 1);
    expect(paretoCoveragePct).toBeGreaterThanOrEqual(80);
  });

  it('is deterministic and free of causal language', () => {
    const first = budgetVsActual(actual, budget);
    const second = budgetVsActual(structuredClone(actual), structuredClone(budget));
    expect(second).toEqual(first);
    assertNoCausalLanguage(first.findings);
  });
});

describe('periodOverPeriod', () => {
  const series = [
    { period: '2026-01', valueCents: 1000 },
    { period: '2026-02', valueCents: 1100 },
    { period: '2026-03', valueCents: 1210 },
    { period: '2026-04', valueCents: 1331 },
  ];
  const result = periodOverPeriod(series);
  const byPeriod = Object.fromEntries(result.map((r) => [r.period, r]));

  it('has no MoM/QoQ/YoY for the first period', () => {
    expect(byPeriod['2026-01']).toMatchObject({ momPct: null, qoqPct: null, yoyPct: null, ma3: null });
  });

  it('computes MoM for each subsequent period', () => {
    expect(byPeriod['2026-02'].momPct).toBeCloseTo(10, 5);
    expect(byPeriod['2026-03'].momPct).toBeCloseTo(10, 5);
    expect(byPeriod['2026-04'].momPct).toBeCloseTo(10, 5);
  });

  it('computes QoQ once 3 prior periods exist, and leaves YoY null without 12', () => {
    expect(byPeriod['2026-04'].qoqPct).toBeCloseTo(33.1, 5);
    expect(byPeriod['2026-01'].yoyPct).toBeNull();
    expect(byPeriod['2026-04'].yoyPct).toBeNull();
  });

  it('computes the 3-period moving average once enough periods exist', () => {
    expect(byPeriod['2026-02'].ma3).toBeNull();
    expect(byPeriod['2026-03'].ma3).toBeCloseTo((1000 + 1100 + 1210) / 3, 5);
    expect(byPeriod['2026-04'].ma3).toBeCloseTo((1100 + 1210 + 1331) / 3, 5);
    expect(byPeriod['2026-04'].ma6).toBeNull();
    expect(byPeriod['2026-04'].ma12).toBeNull();
  });
});

describe('revenueAnalysis / expenseAnalysis', () => {
  const txns = [
    mkTxn('R1', '2026-01-05', 600000, { counterparty: 'BigCo' }),
    mkTxn('R2', '2026-01-10', 150000, { counterparty: 'BigCo' }),
    mkTxn('R3', '2026-01-12', 100000, { counterparty: 'SmallCo' }),
    mkTxn('R4', '2026-01-14', 50000, { counterparty: 'TinyCo' }),
  ];
  const groupBy = (t: Txn) => t.counterparty ?? 'unknown';

  it('totals, mixes, ranks top N and identifies concentration', () => {
    const result = revenueAnalysis(txns, groupBy, { topN: 2 });
    expect(result.totalCents).toBe(900000);
    expect(result.byGroup[0]).toMatchObject({ key: 'BigCo', totalCents: 750000 });
    expect(result.byGroup[0].mixPct).toBeCloseTo(83.333, 2);
    expect(result.topN.map((g) => g.key)).toEqual(['BigCo', 'SmallCo']);
    expect(result.concentration.topKey).toBe('BigCo');
    expect(result.concentration.topSharePct).toBeCloseTo(83.333, 2);
  });

  it('computes growth against a supplied prior-period total', () => {
    const result = revenueAnalysis(txns, groupBy, { priorTotalCents: 750000 });
    expect(result.growthPct).toBeCloseTo(20, 5);
  });

  it('expenseAnalysis mirrors revenueAnalysis for expense transactions, with non-causal findings', () => {
    const result = expenseAnalysis(txns, groupBy, { priorTotalCents: 750000 });
    expect(result.totalCents).toBe(900000);
    assertNoCausalLanguage(result.findings);
  });
});

describe('waterfall', () => {
  const drivers = [
    { label: 'New sales', deltaCents: 50000 },
    { label: 'Refunds', deltaCents: -20000 },
    { label: 'FX', deltaCents: 5000 },
  ];

  it('bridges start to end with running totals when the drivers fully explain the change', () => {
    const result = waterfall(100000, drivers, 135000);
    expect(result.steps).toEqual([
      { label: 'New sales', deltaCents: 50000, runningTotalCents: 150000 },
      { label: 'Refunds', deltaCents: -20000, runningTotalCents: 130000 },
      { label: 'FX', deltaCents: 5000, runningTotalCents: 135000 },
    ]);
    expect(result.expectedEndCents).toBe(135000);
    expect(result.residualCents).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it('shows an unexplained residual explicitly rather than absorbing it', () => {
    const result = waterfall(100000, drivers, 140000);
    expect(result.residualCents).toBe(5000);
    expect(result.reconciles).toBe(false);
    expect(result.findings.some((f) => f.text.includes('unexplained residual'))).toBe(true);
    assertNoCausalLanguage(result.findings);
  });
});

describe('no causal language across the analysis engine', () => {
  it('never emits "caused", "because" or "due to" in any finding text', () => {
    const dq = dataQuality(
      [{ date: null, amount: 1 }],
      [
        { name: 'date', type: 'date', required: true },
        { name: 'amount', type: 'number' },
      ],
    );
    const fx = flux([{ account: 'A', amountCents: 50000 }], [{ account: 'A', amountCents: 10000 }], { absThresholdCents: 100, pctThresholdBps: 100 });
    const bva = budgetVsActual(
      [{ account: 'X', accountType: 'expense', amountCents: 50000 }],
      [{ account: 'X', accountType: 'expense', amountCents: 10000 }],
    );
    const rev = revenueAnalysis([mkTxn('T1', '2026-01-01', 100000, { counterparty: 'Only' })], (t) => t.counterparty ?? 'unknown', { priorTotalCents: 50000 });
    const wf = waterfall(1000, [{ label: 'driver', deltaCents: 500 }], 2000);

    const all: Finding[] = [...dq.findings, ...fx.flatMap((r) => r.findings), ...bva.findings, ...rev.findings, ...wf.findings];
    expect(all.length).toBeGreaterThan(0);
    assertNoCausalLanguage(all);
  });
});
