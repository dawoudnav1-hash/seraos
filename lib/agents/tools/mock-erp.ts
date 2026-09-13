import trialBalance from '@/fixtures/trial-balance.json';
import payroll from '@/fixtures/payroll-register.json';
import threeWayMatch from '@/fixtures/three-way-match.json';
import section163j from '@/fixtures/section-163j.json';
import cashForecast from '@/fixtures/cash-forecast.json';
import leases from '@/fixtures/leases.json';

/** The system of record the agents read from. Deterministic, fixture-backed. */
export const MockERP = {
  trialBalance,
  payroll,
  threeWayMatch,
  section163j,
  cashForecast,
  leases,
  subledgers: {
    ap: threeWayMatch,
    payroll,
    leases,
  } as Record<string, unknown>,
};

export type SubledgerName = keyof typeof MockERP.subledgers;

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    cents / 100,
  );
}
