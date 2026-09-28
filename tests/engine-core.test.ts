import { describe, expect, it } from 'vitest';
import type { JournalEntry, JournalLine, SourceRef } from '@/lib/engine/types';
import {
  AllocationError,
  ArithmeticError,
  InvalidDateError,
  MoneyParseError,
  addDays,
  addMonths,
  allocate,
  daysBetween,
  daysInMonth,
  fiscalPeriodKey,
  fiscalPeriodNumber,
  fiscalYear,
  formatMoney,
  isInPeriod,
  isValidIsoDate,
  monthEnd,
  parseIsoDate,
  parseMoney,
  percentChangeBps,
  periodKey,
  periodsInRange,
  roundHalfEven,
  roundHalfUp,
  sum,
} from '@/lib/engine/primitives';
import {
  DEFAULT_MATERIALITY_THRESHOLDS,
  capitalizationDecision,
  checkAccountsExist,
  checkAccrualReversal,
  checkBalanced,
  checkEverySourced,
  checkNoMixedDebitCredit,
  checkNoZeroLines,
  checkPeriodOpen,
  materialityTier,
  runRules,
} from '@/lib/engine/rules';
import {
  amortizationForPeriod,
  amortizationToDate,
  depreciationForPeriod,
  depreciationToDate,
  estimateAccrualFromReceivedNotInvoiced,
  estimateAccrualFromRunRate,
  loanAmortizationSchedule,
  milestoneRevenueForPeriod,
  milestoneRevenueToDate,
  pointInTimeRevenueForPeriod,
  pointInTimeRevenueToDate,
  prepaidAmortizedForPeriod,
  prepaidRemainingBalance,
  ratableRevenueForPeriod,
  ratableRevenueToDate,
  type DepreciableAsset,
} from '@/lib/engine/calc';
import {
  JournalBuildError,
  PayrollBuildError,
  attachEvidence,
  buildAccrualEntry,
  buildAmortizationEntry,
  buildDepreciationEntry,
  buildFixedAssetEntry,
  buildManualEntry,
  buildPayrollEntry,
  buildPrepaidEntry,
  buildReclassEntry,
  buildRevenueRecognitionEntry,
  buildReversingEntry,
  computeIdempotencyKey,
} from '@/lib/engine/journal';
import { accrualSchedule, balanceSheetRollForward, deferredRevenueSchedule, depreciationSchedule, fixedAssetRollForward, rollForward } from '@/lib/engine/schedules';

const src = (id: string): SourceRef[] => [{ system: 'gl', id }];

// ===========================================================================
// primitives.ts — money
// ===========================================================================

describe('parseMoney', () => {
  it('parses a plain currency string', () => {
    expect(parseMoney('$1,299.99')).toBe(129999);
  });

  it('treats parens as negative (accounting format)', () => {
    expect(parseMoney('(1,173.30)')).toBe(-117330);
  });

  it('parses a leading-minus decimal with no grouping', () => {
    expect(parseMoney('-12.5')).toBe(-1250);
  });

  it('treats a space as thousands grouping', () => {
    expect(parseMoney('1 234.56')).toBe(123456);
  });

  it('parses plain numbers as dollars, rounding half up to cents', () => {
    expect(parseMoney(1234.56)).toBe(123456);
    expect(parseMoney(0.005)).toBe(1); // half-cent rounds up
  });

  it('parses a bare integer with US grouping', () => {
    expect(parseMoney('1,234')).toBe(123400);
  });

  it('throws MoneyParseError on the European format by default', () => {
    expect(() => parseMoney('1.234,56')).toThrow(MoneyParseError);
  });

  it('parses the European format when locale is given', () => {
    expect(parseMoney('1.234,56', { locale: 'eu' })).toBe(123456);
  });

  it('throws on a comma decimal that does not group in 3s (ambiguous)', () => {
    expect(() => parseMoney('12,50')).toThrow(MoneyParseError);
  });

  it('throws on an empty or garbage string', () => {
    expect(() => parseMoney('')).toThrow(MoneyParseError);
    expect(() => parseMoney('abc')).toThrow(MoneyParseError);
  });

  it('round-trips through formatMoney', () => {
    expect(formatMoney(129999)).toBe('$1,299.99');
    expect(formatMoney(-117330)).toBe('($1,173.30)');
    expect(formatMoney(500, { parens: true })).toBe('($5.00)');
  });
});

describe('rounding', () => {
  it('roundHalfUp rounds .5 toward +Infinity, both signs', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-2);
    expect(roundHalfUp(2.4)).toBe(2);
  });

  it('roundHalfEven rounds exact .5 to the nearest even integer', () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });
});

describe('allocate', () => {
  it('sums exactly to the total even when it does not divide evenly', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(sum(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]); // largest-remainder, tie broken by index
  });

  it('sums exactly for a ten-cent split three ways', () => {
    const parts = allocate(10, [1, 1, 1]);
    expect(sum(parts)).toBe(10);
    expect(parts).toEqual([4, 3, 3]);
  });

  it('divides evenly with no remainder when weights divide cleanly', () => {
    expect(allocate(10000, [50, 30, 20])).toEqual([5000, 3000, 2000]);
  });

  it('sums exactly to a large odd total across five weights', () => {
    const parts = allocate(1000003, [3, 1, 4, 1, 5]);
    expect(sum(parts)).toBe(1000003);
    expect(parts.length).toBe(5);
  });

  it('throws AllocationError on negative weights', () => {
    expect(() => allocate(100, [1, -1])).toThrow(AllocationError);
  });
});

describe('percentChangeBps', () => {
  it('computes a positive change in basis points', () => {
    expect(percentChangeBps(100, 110)).toBe(1000); // +10%
  });

  it('computes a negative change in basis points', () => {
    expect(percentChangeBps(200, 150)).toBe(-2500); // -25%
  });

  it('throws ArithmeticError from a zero base', () => {
    expect(() => percentChangeBps(0, 100)).toThrow(ArithmeticError);
  });
});

// ===========================================================================
// primitives.ts — dates
// ===========================================================================

describe('date helpers', () => {
  it('validates real calendar dates and rejects fake ones', () => {
    expect(isValidIsoDate('2026-04-15')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false); // no Feb 30
    expect(isValidIsoDate('2026-13-01')).toBe(false); // no month 13
    expect(() => parseIsoDate('2026-02-30')).toThrow(InvalidDateError);
  });

  it('daysInMonth accounts for leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29); // leap
    expect(daysInMonth(2026, 2)).toBe(28); // not leap
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('monthEnd finds the last day of the month', () => {
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthEnd('2024-02-01')).toBe('2024-02-29');
  });

  it('addMonths clamps the day into the destination month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    expect(addMonths('2026-03-01', -2)).toBe('2026-01-01');
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('daysBetween is exclusive by default, inclusive on request', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-01', '2026-01-31', { inclusive: true })).toBe(31);
    expect(daysBetween('2026-01-01', '2026-01-01', { inclusive: true })).toBe(1);
  });

  it('periodKey and isInPeriod agree on the same month', () => {
    expect(periodKey('2026-04-15')).toBe('2026-04');
    expect(isInPeriod('2026-04-30', '2026-04')).toBe(true);
    expect(isInPeriod('2026-05-01', '2026-04')).toBe(false);
  });

  it('periodsInRange lists every month inclusive, across a year boundary', () => {
    expect(periodsInRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('fiscal helpers respect a configurable fiscal year start month', () => {
    // FY starting October: Oct 2026 - Sep 2027 is FY2027.
    expect(fiscalYear('2026-10-01', 10)).toBe(2027);
    expect(fiscalYear('2026-09-30', 10)).toBe(2026);
    expect(fiscalPeriodNumber('2026-10-01', 10)).toBe(1);
    expect(fiscalPeriodNumber('2026-09-30', 10)).toBe(12);
    expect(fiscalPeriodKey('2026-10-01', 10)).toBe('FY2027-P01');
  });

  it('a calendar fiscal year (start month 1) is a no-op', () => {
    expect(fiscalYear('2026-11-01', 1)).toBe(2026);
    expect(fiscalPeriodNumber('2026-11-01', 1)).toBe(11);
  });
});

// ===========================================================================
// calc.ts — depreciation
// ===========================================================================

describe('straight-line depreciation', () => {
  it('reproduces the fixed-asset register golden number: 3 months accumulated = 67,484¢', () => {
    // Truck: cost 1,349,500¢, salvage 269,756¢, life 48mo, placed in service Dec 2025.
    // Hand check: base = 1,079,744; 1,079,744 * 3 / 48 = 67,484.0 exactly.
    const truck: DepreciableAsset = { costCents: 1349500, salvageCents: 269756, lifeMonths: 48, placedInService: '2025-12-15' };
    expect(depreciationToDate(truck, '2026-03-31')).toBe(67484);
  });

  it('starts the month after in-service by default (matches the register convention)', () => {
    const truck: DepreciableAsset = { costCents: 1349500, salvageCents: 269756, lifeMonths: 48, placedInService: '2025-12-15' };
    expect(depreciationToDate(truck, '2025-12-31')).toBe(0); // no depreciation in the placed-in-service month
    expect(depreciationForPeriod(truck, '2026-01')).toBeGreaterThan(0); // first full month after
  });

  it('full_month convention depreciates a partial first month in full', () => {
    const asset: DepreciableAsset = { costCents: 120000, salvageCents: 0, lifeMonths: 12, placedInService: '2026-01-15', convention: 'full_month' };
    expect(depreciationForPeriod(asset, '2026-01')).toBe(10000); // 120000/12
  });

  it('mid_month convention takes a half month in the first and thirteenth month', () => {
    const asset: DepreciableAsset = { costCents: 120000, salvageCents: 0, lifeMonths: 12, placedInService: '2026-01-15', convention: 'mid_month' };
    expect(depreciationForPeriod(asset, '2026-01')).toBe(5000); // 120000 * 0.5/12
    expect(depreciationForPeriod(asset, '2026-02')).toBe(10000); // full month 2
    expect(depreciationToDate(asset, '2027-06-30')).toBe(120000); // fully depreciated, ties exactly
  });

  it('half_year convention spreads 6 months across the first calendar year', () => {
    const asset: DepreciableAsset = { costCents: 120000, salvageCents: 0, lifeMonths: 24, placedInService: '2026-03-01', convention: 'half_year' };
    expect(depreciationToDate(asset, '2026-12-31')).toBe(30000); // 6 of 24 months earned in year 1
    expect(depreciationToDate(asset, '2027-12-31')).toBe(90000); // +12 months
  });

  it('does not depreciate in the month of disposal by default', () => {
    const asset: DepreciableAsset = {
      costCents: 891437,
      salvageCents: 0,
      lifeMonths: 60,
      placedInService: '2026-02-10',
      disposal: { date: '2026-04-08' },
    };
    expect(depreciationForPeriod(asset, '2026-04')).toBe(0);
    expect(depreciationForPeriod(asset, '2026-05')).toBe(0); // asset is gone
  });

  it('can be configured to depreciate through the disposal month', () => {
    const asset: DepreciableAsset = {
      costCents: 120000,
      salvageCents: 0,
      lifeMonths: 12,
      placedInService: '2026-01-01',
      convention: 'full_month',
      disposal: { date: '2026-04-15', depreciateInDisposalMonth: true },
    };
    expect(depreciationForPeriod(asset, '2026-04')).toBeGreaterThan(0);
    expect(depreciationForPeriod(asset, '2026-05')).toBe(0);
  });

  it('a full monthly schedule always sums to exactly the depreciable base', () => {
    const asset: DepreciableAsset = { costCents: 1349500, salvageCents: 269756, lifeMonths: 48, placedInService: '2025-12-15' };
    // Depreciation starts Jan 2026 (month after in-service) and runs 48 months, through Dec 2029.
    const total = periodsInRange('2025-12', '2029-12').reduce((s, p) => s + depreciationForPeriod(asset, p), 0);
    expect(total).toBe(1349500 - 269756);
  });
});

describe('declining balance depreciation', () => {
  it('switches to straight-line once SL exceeds DB, and ties exactly to the base', () => {
    // Hand check (200% DB, 10mo life, no salvage, full_month convention):
    // 200000,160000,128000,102400,81920,65536,65536,65536,65536,65536 (switch at month 7).
    const asset: DepreciableAsset = {
      costCents: 1000000,
      salvageCents: 0,
      lifeMonths: 10,
      placedInService: '2026-01-01',
      convention: 'full_month',
      method: 'declining_balance_200',
    };
    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((m) => depreciationForPeriod(asset, `2026-${m}`));
    expect(months).toEqual([200000, 160000, 128000, 102400, 81920, 65536, 65536, 65536, 65536, 65536]);
    expect(sum(months)).toBe(1000000);
    expect(depreciationToDate(asset, '2026-10-31')).toBe(1000000);
  });

  it('150% declining balance also ties to the depreciable base exactly', () => {
    const asset: DepreciableAsset = {
      costCents: 500000,
      salvageCents: 50000,
      lifeMonths: 6,
      placedInService: '2026-01-01',
      convention: 'full_month',
      method: 'declining_balance_150',
    };
    let total = 0;
    for (const m of ['01', '02', '03', '04', '05', '06']) total += depreciationForPeriod(asset, `2026-${m}`);
    expect(total).toBe(450000);
  });
});

// ===========================================================================
// calc.ts — amortization, revenue, prepaid, accruals, loans
// ===========================================================================

describe('amortization', () => {
  it('monthly proration sums exactly to the amount over the term', () => {
    const item = { amountCents: 360000, startDate: '2026-01-01', endDate: '2026-12-31', proration: 'monthly' as const };
    let total = 0;
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) total += amortizationForPeriod(item, `2026-${m}`);
    expect(total).toBe(360000);
    expect(amortizationForPeriod(item, '2026-01')).toBe(30000);
  });

  it('daily proration sums exactly to the amount across a 365-day term', () => {
    const item = { amountCents: 365000, startDate: '2026-01-01', endDate: '2026-12-31', proration: 'daily' as const };
    expect(amortizationToDate(item, '2026-12-31')).toBe(365000);
    let total = 0;
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) total += amortizationForPeriod(item, `2026-${m}`);
    expect(total).toBe(365000);
  });
});

describe('revenue recognition', () => {
  it('ratable recognition is daily-prorated and ties exactly over 365 days', () => {
    const contract = { totalCents: 1200000, startDate: '2026-01-01', endDate: '2026-12-31' };
    // Hand check: Jan (31/365 days) = round(1,200,000 * 31/365) = 101,918.
    expect(ratableRevenueForPeriod(contract, '2026-01')).toBe(101918);
    let total = 0;
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) total += ratableRevenueForPeriod(contract, `2026-${m}`);
    expect(total).toBe(1200000);
    expect(ratableRevenueToDate(contract, '2026-12-31')).toBe(1200000);
  });

  it('recognizes nothing before the contract starts and nothing more after it ends', () => {
    const contract = { totalCents: 100000, startDate: '2026-06-01', endDate: '2026-06-30' };
    expect(ratableRevenueToDate(contract, '2026-05-31')).toBe(0);
    expect(ratableRevenueToDate(contract, '2027-01-01')).toBe(100000);
  });

  it('point-in-time recognizes the full amount on the recognition date, nothing before', () => {
    const item = { amountCents: 50000, recognitionDate: '2026-04-15' };
    expect(pointInTimeRevenueToDate(item, '2026-04-14')).toBe(0);
    expect(pointInTimeRevenueToDate(item, '2026-04-15')).toBe(50000);
    expect(pointInTimeRevenueForPeriod(item, '2026-04')).toBe(50000);
    expect(pointInTimeRevenueForPeriod(item, '2026-05')).toBe(0);
  });

  it('milestone recognition sums achieved milestones, ignoring unmet ones', () => {
    const milestones = [
      { amountCents: 30000, achievedOn: '2026-02-01' },
      { amountCents: 20000, achievedOn: '2026-04-01' },
    ];
    expect(milestoneRevenueToDate(milestones, '2026-03-01')).toBe(30000);
    expect(milestoneRevenueToDate(milestones, '2026-04-01')).toBe(50000);
    expect(milestoneRevenueForPeriod(milestones, '2026-04')).toBe(20000);
  });
});

describe('prepaid amortization', () => {
  it('amortizes the paid amount over the coverage period and ties out the remaining balance', () => {
    const item = { paidCents: 120000, coverageStart: '2026-01-01', coverageEnd: '2026-12-31' };
    expect(prepaidRemainingBalance(item, '2025-12-31')).toBe(120000);
    expect(prepaidRemainingBalance(item, '2026-12-31')).toBe(0);
    let total = 0;
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) total += prepaidAmortizedForPeriod(item, `2026-${m}`);
    expect(total).toBe(120000);
  });
});

describe('accrual estimates', () => {
  it('sums received-not-invoiced items', () => {
    expect(estimateAccrualFromReceivedNotInvoiced([{ amountCents: 10000 }, { amountCents: 25000 }])).toBe(35000);
  });

  it('averages a recurring run-rate, rounded half up', () => {
    expect(estimateAccrualFromRunRate([10000, 10000, 11000])).toBe(10333); // 31000/3 = 10333.33 -> 10333
  });
});

describe('loan interest split (nice-to-have)', () => {
  it('splits a fixed payment into interest and principal, retiring the balance exactly', () => {
    // Hand check: 3 periods, 1% per period, $3,000 principal, $1,020 payment.
    const rows = loanAmortizationSchedule(300000, 100, 102000, 3);
    expect(rows).toEqual([
      { interestCents: 3000, principalCents: 99000, endingBalanceCents: 201000 },
      { interestCents: 2010, principalCents: 99990, endingBalanceCents: 101010 },
      { interestCents: 1010, principalCents: 101010, endingBalanceCents: 0 },
    ]);
  });
});

// ===========================================================================
// rules.ts
// ===========================================================================

function baseEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const lines: JournalLine[] = overrides.lines ?? [
    { account: '6410', description: 'Expense', debitCents: 10000, creditCents: 0, sources: src('JE-1') },
    { account: '2100', description: 'Liability', debitCents: 0, creditCents: 10000, sources: src('JE-1') },
  ];
  return {
    id: 'JE-TEST',
    date: '2026-04-15',
    type: 'manual',
    memo: 'test entry',
    lines,
    attachments: [],
    idempotencyKey: 'test',
    ...overrides,
  };
}

describe('rules', () => {
  it('checkBalanced passes a balanced entry and fails an unbalanced one', () => {
    expect(checkBalanced(baseEntry()).pass).toBe(true);
    const unbalanced = baseEntry({ lines: [{ account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') }] });
    expect(checkBalanced(unbalanced).pass).toBe(false);
  });

  it('checkNoZeroLines catches a line with neither debit nor credit', () => {
    const je = baseEntry({ lines: [{ account: '6410', description: 'x', debitCents: 0, creditCents: 0, sources: src('a') }] });
    expect(checkNoZeroLines(je).pass).toBe(false);
  });

  it('checkNoMixedDebitCredit catches a line with both a debit and a credit', () => {
    const je = baseEntry({ lines: [{ account: '6410', description: 'x', debitCents: 100, creditCents: 50, sources: src('a') }] });
    expect(checkNoMixedDebitCredit(je).pass).toBe(false);
  });

  it('checkEverySourced catches a line with no source', () => {
    const je = baseEntry({ lines: [{ account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: [] }] });
    expect(checkEverySourced(je).pass).toBe(false);
  });

  it('checkAccountsExist catches an account missing from the chart', () => {
    const chart = new Set(['6410', '2100']);
    expect(checkAccountsExist(baseEntry(), chart).pass).toBe(true);
    const je = baseEntry({ lines: [{ account: '9999', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') }] });
    expect(checkAccountsExist(je, chart).pass).toBe(false);
  });

  it('checkAccountsExist also accepts a chart given as an array of {code}', () => {
    const chart = [{ code: '6410' }, { code: '2100' }];
    expect(checkAccountsExist(baseEntry(), chart).pass).toBe(true);
  });

  it('checkPeriodOpen catches an entry dated into a closed period', () => {
    expect(checkPeriodOpen(baseEntry(), ['2026-03']).pass).toBe(true);
    expect(checkPeriodOpen(baseEntry(), ['2026-04']).pass).toBe(false);
  });

  it('checkAccrualReversal requires reversesOn strictly after the entry date, only for accruals', () => {
    expect(checkAccrualReversal(baseEntry({ type: 'manual' })).pass).toBe(true); // n/a
    expect(checkAccrualReversal(baseEntry({ type: 'accrual', reversesOn: '2026-05-01' })).pass).toBe(true);
    expect(checkAccrualReversal(baseEntry({ type: 'accrual' })).pass).toBe(false); // missing reversesOn
    expect(checkAccrualReversal(baseEntry({ type: 'accrual', reversesOn: '2026-04-15' })).pass).toBe(false); // not after
  });

  it('capitalizationDecision requires amount AND useful life over the thresholds', () => {
    expect(capitalizationDecision({ amountCents: 60000, usefulLifeMonths: 24, thresholdCents: 50000 }).capitalize).toBe(true);
    expect(capitalizationDecision({ amountCents: 40000, usefulLifeMonths: 24, thresholdCents: 50000 }).capitalize).toBe(false);
    expect(capitalizationDecision({ amountCents: 60000, usefulLifeMonths: 12, thresholdCents: 50000 }).capitalize).toBe(false);
  });

  it('materialityTier flags an amount over the absolute default threshold', () => {
    const d = materialityTier({ absoluteCents: DEFAULT_MATERIALITY_THRESHOLDS.absoluteCents + 1 });
    expect(d.tier).toBe('material');
  });

  it('materialityTier flags an amount over the percent-of-base threshold even if small in dollars', () => {
    const d = materialityTier({ absoluteCents: 1000, percentOfBase: 0.06 }); // 6% > 5% default
    expect(d.tier).toBe('material');
  });

  it('materialityTier calls a small amount immaterial', () => {
    const d = materialityTier({ absoluteCents: 100, base: 1000000 });
    expect(d.tier).toBe('immaterial');
  });

  it('runRules aggregates every applicable check, including chart and period checks when given', () => {
    const checks = runRules(baseEntry(), { chart: new Set(['6410', '2100']), closedPeriods: ['2026-01'] });
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks.every((c) => c.layer === 'structural' && c.confidence === 1)).toBe(true);
  });
});

// ===========================================================================
// journal.ts
// ===========================================================================

describe('journal builders', () => {
  it('buildManualEntry produces a balanced, sourced entry', () => {
    const je = buildManualEntry({
      date: '2026-04-15',
      memo: 'Manual JE',
      lines: [
        { account: '6410', description: 'Expense', debitCents: 5000, creditCents: 0, sources: src('doc-1') },
        { account: '2100', description: 'Liability', debitCents: 0, creditCents: 5000, sources: src('doc-1') },
      ],
    });
    expect(je.type).toBe('manual');
    expect(je.lines.reduce((s, l) => s + l.debitCents, 0)).toBe(je.lines.reduce((s, l) => s + l.creditCents, 0));
  });

  it('buildAccrualEntry auto-sets reversesOn to the first day of the next period', () => {
    const je = buildAccrualEntry({
      date: '2026-04-15',
      memo: 'Accrue April consulting fees',
      expenseAccount: '6500',
      liabilityAccount: '2200',
      amountCents: 250000,
      sources: src('estimate-1'),
    });
    expect(je.reversesOn).toBe('2026-05-01');
    expect(je.lines[0].debitCents).toBe(250000);
    expect(je.lines[1].creditCents).toBe(250000);
  });

  it('buildReversingEntry swaps every line and links back to the original id', () => {
    const original = buildAccrualEntry({
      date: '2026-04-15',
      memo: 'Accrue',
      expenseAccount: '6500',
      liabilityAccount: '2200',
      amountCents: 100000,
      sources: src('estimate-1'),
    });
    const reversal = buildReversingEntry(original, '2026-05-01');
    expect(reversal.type).toBe('reversing');
    expect(reversal.lines[0].debitCents).toBe(original.lines[0].creditCents);
    expect(reversal.lines[0].creditCents).toBe(original.lines[0].debitCents);
    expect(reversal.memo).toContain(original.id);
    expect(reversal.attachments.some((a) => a.id === original.id)).toBe(true);
  });

  it('buildPayrollEntry balances gross wages, employer taxes, withholdings and net pay', () => {
    const je = buildPayrollEntry({
      date: '2026-04-30',
      memo: 'April payroll',
      wagesExpenseAccount: '6100',
      grossWagesCents: 500000,
      employerTaxExpenseAccount: '6150',
      employerTaxesCents: 38250,
      employerTaxLiabilityAccount: '2310',
      withholdings: [
        { account: '2320', amountCents: 75000, description: 'Federal withholding' },
        { account: '2330', amountCents: 31000, description: 'FICA employee' },
        { account: '2340', amountCents: 15000, description: 'State withholding' },
      ],
      netPayAccount: '2350',
      sources: src('payroll-run-1'),
    });
    const debit = je.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = je.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(538250);
    const netPayLine = je.lines.find((l) => l.account === '2350')!;
    expect(netPayLine.creditCents).toBe(379000); // 500000 - (75000+31000+15000)
  });

  it('buildPayrollEntry omits zero lines for a run with no employer taxes or withholdings', () => {
    const je = buildPayrollEntry({
      date: '2026-04-30',
      memo: 'Contractor payroll',
      wagesExpenseAccount: '6100',
      grossWagesCents: 250000,
      employerTaxExpenseAccount: '6150',
      employerTaxesCents: 0,
      employerTaxLiabilityAccount: '2310',
      withholdings: [],
      netPayAccount: '2350',
      sources: src('payroll-run-2'),
    });
    expect(je.lines.map((l) => l.account)).toEqual(['6100', '2350']);
    expect(je.lines.every((l) => l.debitCents + l.creditCents > 0)).toBe(true);
  });

  it('buildPayrollEntry throws PayrollBuildError when withholdings exceed gross wages', () => {
    expect(() =>
      buildPayrollEntry({
        date: '2026-04-30',
        memo: 'Bad payroll',
        wagesExpenseAccount: '6100',
        grossWagesCents: 1000,
        employerTaxExpenseAccount: '6150',
        employerTaxesCents: 100,
        employerTaxLiabilityAccount: '2310',
        withholdings: [{ account: '2320', amountCents: 5000, description: 'Federal' }],
        netPayAccount: '2350',
        sources: src('payroll-run-2'),
      }),
    ).toThrow(PayrollBuildError);
  });

  it('buildRevenueRecognitionEntry debits deferred revenue and credits revenue', () => {
    const je = buildRevenueRecognitionEntry({
      date: '2026-04-30',
      memo: 'Recognize April subscription revenue',
      deferredRevenueAccount: '2400',
      revenueAccount: '4000',
      amountCents: 101918,
      sources: src('contract-1'),
    });
    expect(je.lines[0].debitCents).toBe(101918);
    expect(je.lines[1].creditCents).toBe(101918);
  });

  it('buildDepreciationEntry debits total expense and credits each class accumulated account', () => {
    const je = buildDepreciationEntry({
      date: '2026-04-30',
      memo: 'April depreciation',
      depreciationExpenseAccount: '6410',
      lines: [
        { accumulatedDepreciationAccount: '1519', amountCents: 30000, sources: src('FA-1') },
        { accumulatedDepreciationAccount: '1549', amountCents: 22495, sources: src('FA-2') },
      ],
      expenseSources: src('close-run-1'),
    });
    expect(je.lines[0].debitCents).toBe(52495);
  });

  it('buildAmortizationEntry mirrors depreciation for intangibles', () => {
    const je = buildAmortizationEntry({
      date: '2026-04-30',
      memo: 'April amortization',
      amortizationExpenseAccount: '6420',
      lines: [{ accumulatedAmortizationAccount: '1620', amountCents: 12000, sources: src('INT-1') }],
      expenseSources: src('close-run-1'),
    });
    expect(je.lines[0].debitCents).toBe(12000);
    expect(je.lines[1].creditCents).toBe(12000);
  });

  it('buildPrepaidEntry debits expense and credits the prepaid asset', () => {
    const je = buildPrepaidEntry({
      date: '2026-04-30',
      memo: 'April insurance expense',
      expenseAccount: '6600',
      prepaidAssetAccount: '1400',
      amountCents: 10000,
      sources: src('prepaid-1'),
    });
    expect(je.lines[0].debitCents).toBe(10000);
    expect(je.lines[1].creditCents).toBe(10000);
  });

  it('buildFixedAssetEntry capitalizes a purchase from expense to a fixed asset', () => {
    const je = buildFixedAssetEntry({
      kind: 'capitalize',
      date: '2026-04-03',
      memo: 'Capitalize laptop purchase',
      fixedAssetAccount: '1510',
      offsetAccount: '6200',
      amountCents: 129999,
      sources: src('JE-2026-0403'),
    });
    expect(je.lines[0].debitCents).toBe(129999);
  });

  it('buildFixedAssetEntry disposal records a loss when proceeds are below net book value', () => {
    const je = buildFixedAssetEntry({
      kind: 'dispose',
      date: '2026-04-08',
      memo: 'Dispose of server',
      fixedAssetCostAccount: '1510',
      costCents: 891437,
      accumulatedDepreciationAccount: '1519',
      accumulatedDepreciationCents: 14857,
      proceedsAccount: '1180',
      proceedsCents: 850000,
      gainLossAccount: '7910',
      sources: src('FA-2203'),
    });
    const lossLine = je.lines.find((l) => l.description.includes('Loss'));
    expect(lossLine).toBeDefined();
    expect(lossLine!.debitCents).toBe(891437 - 14857 - 850000);
    const debit = je.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = je.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(debit).toBe(credit);
  });

  it('buildFixedAssetEntry disposal records a gain when proceeds exceed net book value', () => {
    const je = buildFixedAssetEntry({
      kind: 'dispose',
      date: '2026-04-08',
      memo: 'Dispose of asset at a gain',
      fixedAssetCostAccount: '1510',
      costCents: 100000,
      accumulatedDepreciationAccount: '1519',
      accumulatedDepreciationCents: 80000,
      proceedsAccount: '1180',
      proceedsCents: 30000,
      gainLossAccount: '7910',
      sources: src('FA-X'),
    });
    const gainLine = je.lines.find((l) => l.description.includes('Gain'));
    expect(gainLine).toBeDefined();
    expect(gainLine!.creditCents).toBe(10000); // NBV 20000, proceeds 30000
  });

  it('buildReclassEntry moves an amount from one account to another, balanced', () => {
    const je = buildReclassEntry({
      date: '2026-04-30',
      memo: 'Reclass shelving to fixed assets',
      fromAccount: '6200',
      toAccount: '1520',
      amountCents: 72500,
      sources: src('JE-2026-0412'),
    });
    expect(je.lines[0].account).toBe('1520');
    expect(je.lines[0].debitCents).toBe(72500);
    expect(je.lines[1].account).toBe('6200');
    expect(je.lines[1].creditCents).toBe(72500);
  });

  it('throws JournalBuildError with the failed checks when lines would not balance', () => {
    expect(() =>
      buildManualEntry({
        date: '2026-04-15',
        memo: 'Bad entry',
        lines: [{ account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') }],
      }),
    ).toThrow(JournalBuildError);
    try {
      buildManualEntry({ date: '2026-04-15', memo: 'Bad entry', lines: [{ account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') }] });
    } catch (e) {
      expect(e).toBeInstanceOf(JournalBuildError);
      expect((e as InstanceType<typeof JournalBuildError>).checks.some((c) => c.id === 'structural.balanced' && !c.pass)).toBe(true);
    }
  });

  it('throws JournalBuildError when a line has no source', () => {
    expect(() =>
      buildManualEntry({
        date: '2026-04-15',
        memo: 'Unsourced',
        lines: [
          { account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: [] },
          { account: '2100', description: 'y', debitCents: 0, creditCents: 100, sources: [] },
        ],
      }),
    ).toThrow(JournalBuildError);
  });

  it('attachEvidence appends refs without mutating the original entry', () => {
    const je = buildManualEntry({
      date: '2026-04-15',
      memo: 'x',
      lines: [
        { account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') },
        { account: '2100', description: 'y', debitCents: 0, creditCents: 100, sources: src('a') },
      ],
    });
    const withEvidence = attachEvidence(je, [{ system: 'upload', id: 'file-1' }]);
    expect(withEvidence.attachments).toHaveLength(1);
    expect(je.attachments).toHaveLength(0); // original untouched
  });

  it('idempotencyKey is stable for identical content and changes when content changes', () => {
    const lines: JournalLine[] = [
      { account: '6410', description: 'x', debitCents: 100, creditCents: 0, sources: src('a') },
      { account: '2100', description: 'y', debitCents: 0, creditCents: 100, sources: src('a') },
    ];
    const k1 = computeIdempotencyKey('2026-04-15', 'manual', lines);
    const k2 = computeIdempotencyKey('2026-04-15', 'manual', JSON.parse(JSON.stringify(lines)));
    expect(k1).toBe(k2);
    const k3 = computeIdempotencyKey('2026-04-16', 'manual', lines);
    expect(k3).not.toBe(k1);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two builds of the same accrual produce the same idempotency key', () => {
    const input = { date: '2026-04-15', memo: 'Accrue', expenseAccount: '6500', liabilityAccount: '2200', amountCents: 100000, sources: src('estimate-1') };
    expect(buildAccrualEntry(input).idempotencyKey).toBe(buildAccrualEntry({ ...input }).idempotencyKey);
  });
});

// ===========================================================================
// schedules.ts
// ===========================================================================

describe('rollForward', () => {
  it('ties to a matching GL balance and reports zero difference', () => {
    const result = rollForward({
      opening: 100000,
      movements: [
        { kind: 'addition', amountCents: 50000, date: '2026-04-05', sources: src('a') },
        { kind: 'reduction', amountCents: -20000, date: '2026-04-20', sources: src('b') },
      ],
      glBalance: 130000,
    });
    expect(result.closing).toBe(130000);
    expect(result.tiesToGl).toBe(true);
    expect(result.differenceCents).toBe(0);
  });

  it('reports a non-zero difference when the GL does not tie', () => {
    const result = rollForward({
      opening: 100000,
      movements: [{ kind: 'addition', amountCents: 50000, date: '2026-04-05', sources: src('a') }],
      glBalance: 200000,
    });
    expect(result.closing).toBe(150000);
    expect(result.tiesToGl).toBe(false);
    expect(result.differenceCents).toBe(50000);
  });

  it('leaves tiesToGl and differenceCents null when no GL balance is supplied', () => {
    const result = rollForward({ opening: 0, movements: [] });
    expect(result.tiesToGl).toBeNull();
    expect(result.differenceCents).toBeNull();
  });

  it('groups movements by kind', () => {
    const result = rollForward({
      opening: 0,
      movements: [
        { kind: 'depreciation', amountCents: 100, date: '2026-04-01', sources: src('a') },
        { kind: 'depreciation', amountCents: 200, date: '2026-04-02', sources: src('a') },
      ],
    });
    expect(result.byKind.depreciation).toBe(300);
  });
});

describe('fixedAssetRollForward', () => {
  it('rolls cost and accumulated depreciation forward by class and ties net book value', () => {
    const { rows, totals } = fixedAssetRollForward([
      {
        class: 'Truck',
        openingCostCents: 1349500,
        openingAccumCents: 44989,
        additions: [],
        disposals: [],
        depreciation: [{ amountCents: 22495, date: '2026-04-30', sources: src('FA-2104') }],
      },
      {
        class: 'Computer',
        openingCostCents: 891437,
        openingAccumCents: 14857,
        additions: [],
        disposals: [{ costCents: 891437, accumCents: 14857, date: '2026-04-08', sources: src('FA-2203') }],
        depreciation: [],
      },
    ]);
    const truck = rows.find((r) => r.class === 'Truck')!;
    expect(truck.cost.closing).toBe(1349500);
    expect(truck.accumulatedDepreciation.closing).toBe(67484);
    expect(truck.netBookValueClosing).toBe(1349500 - 67484);
    const computer = rows.find((r) => r.class === 'Computer')!;
    expect(computer.cost.closing).toBe(0);
    expect(computer.accumulatedDepreciation.closing).toBe(0);
    expect(totals.nbvClosing).toBe(truck.netBookValueClosing + computer.netBookValueClosing);
  });
});

describe('depreciationSchedule', () => {
  it('produces per-asset per-month rows whose total matches depreciationToDate at the range end', () => {
    const asset = { id: 'FA-2104', costCents: 1349500, salvageCents: 269756, lifeMonths: 48, placedInService: '2025-12-15' };
    const { rows, totalDepreciationCents } = depreciationSchedule([asset], { fromPeriod: '2026-01', toPeriod: '2026-03' });
    expect(rows).toHaveLength(3);
    expect(rows[2].closingAccumCents).toBe(67484);
    expect(totalDepreciationCents).toBe(67484);
    // Each row's opening + this period = closing, and chains to the next row's opening.
    expect(rows[0].openingAccumCents).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].openingAccumCents).toBe(rows[i - 1].closingAccumCents);
  });
});

describe('deferredRevenueSchedule', () => {
  it('ending balance = billed - recognized, and recognition ties to the total at term end', () => {
    const contract = { id: 'C-1', totalCents: 600000, billedCents: 600000, startDate: '2026-01-01', endDate: '2026-06-30' };
    const { rows } = deferredRevenueSchedule([contract], { fromPeriod: '2026-01', toPeriod: '2026-06' });
    const last = rows[rows.length - 1];
    expect(last.recognizedToDateCents).toBe(600000);
    expect(last.endingBalanceCents).toBe(0);
    for (const row of rows) expect(row.endingBalanceCents).toBe(contract.billedCents - row.recognizedToDateCents);
    const marApr = rows.find((r) => r.period === '2026-03')!;
    expect(marApr.recognizedToDateCents).toBe(298343); // hand check: round(600000*90/181)
  });

  it('an unbilled portion still shows a negative or reduced ending balance correctly', () => {
    const contract = { id: 'C-2', totalCents: 120000, billedCents: 0, startDate: '2026-01-01', endDate: '2026-12-31' };
    const { rows } = deferredRevenueSchedule([contract], { fromPeriod: '2026-01', toPeriod: '2026-01' });
    expect(rows[0].endingBalanceCents).toBe(0 - rows[0].recognizedToDateCents);
  });
});

describe('accrualSchedule', () => {
  it('separates open accruals from ones already reversed as of a date', () => {
    const accruals = [
      { id: 'A-1', amountCents: 1000, date: '2026-03-31', reversesOn: '2026-04-01', sources: src('a') },
      { id: 'A-2', amountCents: 2000, date: '2026-04-30', reversesOn: '2026-05-01', sources: src('b') },
    ];
    const { open, reversed, openTotalCents, reversedTotalCents } = accrualSchedule(accruals, '2026-04-15');
    expect(reversed.map((a) => a.id)).toEqual(['A-1']);
    expect(open.map((a) => a.id)).toEqual(['A-2']);
    expect(reversedTotalCents).toBe(1000);
    expect(openTotalCents).toBe(2000);
  });
});

describe('balanceSheetRollForward', () => {
  it('rolls an account forward and flags a difference against the reported balance', () => {
    const result = balanceSheetRollForward({
      account: '1400',
      opening: 50000,
      activity: [{ amountCents: -10000, date: '2026-04-15', sources: src('a') }],
      reportedClosing: 35000,
    });
    expect(result.closing).toBe(40000);
    expect(result.tiesToGl).toBe(false);
    expect(result.differenceCents).toBe(-5000);
  });
});

// ===========================================================================
// End-to-end sanity: accrual -> reversal -> rules all agree
// ===========================================================================

describe('end to end: accrual then reversal', () => {
  it('an accrual and its reversal both pass every structural rule', () => {
    const accrual = buildAccrualEntry({
      date: '2026-04-30',
      memo: 'Accrue April utilities',
      expenseAccount: '6700',
      liabilityAccount: '2210',
      amountCents: 42500,
      sources: src('estimate-april'),
    });
    const reversal = buildReversingEntry(accrual, accrual.reversesOn!);
    for (const je of [accrual, reversal]) {
      const checks = runRules(je, {});
      expect(checks.every((c) => c.pass)).toBe(true);
    }
    expect(reversal.date).toBe('2026-05-01');
  });
});
