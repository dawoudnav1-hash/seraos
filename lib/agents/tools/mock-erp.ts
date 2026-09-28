import trialBalance from '@/fixtures/trial-balance.json';
import payroll from '@/fixtures/payroll-register.json';
import threeWayMatch from '@/fixtures/three-way-match.json';
import section163j from '@/fixtures/section-163j.json';
import cashForecast from '@/fixtures/cash-forecast.json';
import leases from '@/fixtures/leases.json';
import fixedAssets from '@/fixtures/fixed-assets.json';

/** The system of record the agents read from. Deterministic, fixture-backed. */
export const MockERP = {
  trialBalance,
  payroll,
  threeWayMatch,
  section163j,
  cashForecast,
  leases,
  fixedAssets,
  subledgers: {
    ap: threeWayMatch,
    payroll,
    leases,
    fixed_assets: fixedAssets.register,
    gl_april_expenses: fixedAssets.aprilExpenses,
  } as Record<string, unknown>,
};

/** Months of runway at the current net weekly burn — derived, never stored. */
export function runwayMonths(): number {
  const net = cashForecast.weeklyBurnCents - cashForecast.weeklyCollectionsCents;
  return Math.round(cashForecast.openingCashCents / net / (52 / 12));
}

export type SubledgerName = keyof typeof MockERP.subledgers;

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    cents / 100,
  );
}
