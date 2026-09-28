/**
 * Money and date primitives. "The LLM does zero arithmetic": every engine in
 * this codebase builds on these instead of touching floats or Date math
 * directly. Money is always integer cents; rounding happens once, at the
 * point a total is struck, never accumulated line by line.
 */

import type { Cents, IsoDate } from '@/lib/engine/types';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type MoneyLocale = 'us' | 'eu';

/** Thrown when a money string cannot be parsed, or reads as the other locale's format. */
export class MoneyParseError extends Error {
  readonly code: 'ambiguous_format' | 'invalid_format';
  constructor(code: 'ambiguous_format' | 'invalid_format', message: string) {
    super(message);
    this.name = 'MoneyParseError';
    this.code = code;
  }
}

/**
 * Parses a money string or number into integer cents. Accepts "$1,299.99",
 * "(1,173.30)" (parens = negative), "-12.5", "1 234.56" (space grouping), and
 * plain numbers (treated as dollars). Under the default 'us' locale, "." is
 * the decimal marker and "," is thousands grouping; pass { locale: 'eu' } to
 * swap them. A string that reads as the other locale's format (e.g.
 * "1.234,56" under 'us') is ambiguous and throws rather than guessing.
 */
export function parseMoney(input: string | number, opts: { locale?: MoneyLocale } = {}): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyParseError('invalid_format', `Not a finite number: ${input}`);
    return roundHalfUp(input * 100);
  }

  const locale = opts.locale ?? 'us';
  const original = input;
  const trimmed = input.trim();
  if (trimmed === '') throw new MoneyParseError('invalid_format', 'Empty money string.');

  const parenWrapped = /^\(.*\)$/.test(trimmed);
  let body = (parenWrapped ? trimmed.slice(1, -1) : trimmed).trim();
  let negative = parenWrapped;

  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }
  if (body.endsWith('-')) {
    negative = true;
    body = body.slice(0, -1);
  }

  // Strip currency symbols / codes; keep digits, separators and grouping spaces.
  body = body.replace(/[^0-9.,\s]/g, '').trim();
  const noSpaces = body.replace(/\s+/g, '');
  if (noSpaces === '' || !/^[0-9.,]+$/.test(noSpaces)) {
    throw new MoneyParseError('invalid_format', `Unrecognized money format: "${original}"`);
  }

  const decimalMarker = locale === 'us' ? '.' : ',';
  const groupMarker = locale === 'us' ? ',' : '.';
  const hasDot = noSpaces.includes('.');
  const hasComma = noSpaces.includes(',');

  let integerPart: string;
  let fractionPart: string;

  if (hasDot && hasComma) {
    const lastDot = noSpaces.lastIndexOf('.');
    const lastComma = noSpaces.lastIndexOf(',');
    const decimalIdx = Math.max(lastDot, lastComma);
    const decimalChar = noSpaces[decimalIdx];
    if (decimalChar !== decimalMarker) {
      const otherLocale = locale === 'us' ? 'eu' : 'us';
      throw new MoneyParseError(
        'ambiguous_format',
        `"${original}" looks like the ${otherLocale === 'eu' ? 'European' : 'US'} money format; pass { locale: '${otherLocale}' } if that is intended.`,
      );
    }
    const groupChar = groupMarker;
    const integerRaw = noSpaces.slice(0, decimalIdx);
    fractionPart = noSpaces.slice(decimalIdx + 1);
    const groups = integerRaw.split(groupChar);
    if (groups.length < 2 || groups[0].length === 0 || groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3)) {
      throw new MoneyParseError('invalid_format', `Unrecognized money format: "${original}"`);
    }
    integerPart = groups.join('');
  } else if (hasDot || hasComma) {
    const marker = hasDot ? '.' : ',';
    const groups = noSpaces.split(marker);
    if (marker === groupMarker) {
      if (groups[0].length === 0 || groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3)) {
        const otherLocale = locale === 'us' ? 'eu' : 'us';
        throw new MoneyParseError(
          'ambiguous_format',
          `"${original}" doesn't group in 3s; it may be the ${otherLocale === 'eu' ? 'European' : 'US'} decimal format — pass { locale: '${otherLocale}' } if so.`,
        );
      }
      integerPart = groups.join('');
      fractionPart = '';
    } else {
      if (groups.length > 2) throw new MoneyParseError('invalid_format', `Unrecognized money format: "${original}"`);
      integerPart = groups[0] || '0';
      fractionPart = groups[1] ?? '';
    }
  } else {
    integerPart = noSpaces;
    fractionPart = '';
  }

  const fractionDigits = fractionPart.padEnd(2, '0');
  const centsDigits = fractionDigits.slice(0, 2);
  const extra = fractionDigits.slice(2);
  let cents = Number(integerPart || '0') * 100 + Number(centsDigits);
  if (extra.length > 0 && Number(extra[0]) >= 5) cents += 1; // sub-cent remainder rounds half up
  return negative ? -cents : cents;
}

/** Renders cents as "$1,234.56", with parentheses for negatives (or when forced). */
export function formatMoney(cents: Cents, opts: { parens?: boolean } = {}): string {
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  return cents < 0 || opts.parens ? `(${formatted})` : formatted;
}

/** Rounds .5 toward +Infinity — the common "round half up" accounting convention. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Banker's rounding: exact .5 goes to the nearest even integer. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  const EPS = 1e-9;
  if (diff < 0.5 - EPS) return floor;
  if (diff > 0.5 + EPS) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** Thrown when weights can't be turned into a valid allocation. */
export class AllocationError extends Error {}

/**
 * Splits totalCents across weights using the largest-remainder method: each
 * share is floored, then the leftover cents go one at a time to the shares
 * with the largest fractional remainder — so the parts always sum exactly to
 * the total, never off by a cent from rounding.
 */
export function allocate(totalCents: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) {
    if (totalCents !== 0) throw new AllocationError('Cannot allocate a non-zero total across zero weights.');
    return [];
  }
  if (weights.some((w) => w < 0)) throw new AllocationError('Allocation weights must be non-negative.');
  const weightSum = sum(weights);
  if (weightSum === 0) throw new AllocationError('Allocation weights must sum to more than zero.');

  const raw = weights.map((w) => (totalCents * w) / weightSum);
  const floors = raw.map(Math.floor);
  const remainder = totalCents - sum(floors); // always a non-negative integer: floor(x) <= x

  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  for (let k = 0; k < remainder; k++) result[order[k % order.length].i] += 1;
  return result;
}

/** Thrown for arithmetic that has no defined answer, such as a percent change from zero. */
export class ArithmeticError extends Error {}

/** Percent change from `from` to `to`, in basis points (100 bps = 1%), rounded half up. */
export function percentChangeBps(from: number, to: number): number {
  if (from === 0) throw new ArithmeticError('Percent change from a zero base is undefined.');
  return roundHalfUp(((to - from) / from) * 10000);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Thrown when a string isn't a real ISO calendar date. */
export class InvalidDateError extends Error {}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseYmd(date: IsoDate): Ymd {
  const match = ISO_DATE_RE.exec(date);
  if (!match) throw new InvalidDateError(`Not an ISO date (YYYY-MM-DD): "${date}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw new InvalidDateError(`Invalid month in "${date}"`);
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) throw new InvalidDateError(`Invalid day in "${date}"`);
  return { year, month, day };
}

function formatYmd({ year, month, day }: Ymd): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toEpochDay({ year, month, day }: Ymd): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}

function fromEpochDay(epochDay: number): Ymd {
  const dt = new Date(epochDay * 86400000);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** Parses and validates an ISO date, throwing InvalidDateError on anything else. */
export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  return parseYmd(date);
}

export function isValidIsoDate(date: string): boolean {
  try {
    parseYmd(date);
    return true;
  } catch {
    return false;
  }
}

/** Days in a given 1-12 month (`new Date(y, m, 0)` trick, done in UTC). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseYmd(date);
  return formatYmd({ year, month, day: 1 });
}

export function monthEnd(date: IsoDate): IsoDate {
  const { year, month } = parseYmd(date);
  return formatYmd({ year, month, day: daysInMonth(year, month) });
}

/** Adds n months, clamping the day into the destination month (Jan 31 + 1mo = Feb 28/29). */
export function addMonths(date: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseYmd(date);
  const totalMonths = year * 12 + (month - 1) + n;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = totalMonths - newYear * 12 + 1;
  const clampedDay = Math.min(day, daysInMonth(newYear, newMonth));
  return formatYmd({ year: newYear, month: newMonth, day: clampedDay });
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return formatYmd(fromEpochDay(toEpochDay(parseYmd(date)) + n));
}

/**
 * Days from a to b. Exclusive by default (b - a); pass { inclusive: true } to
 * count both endpoints (so the same date, inclusive, is 1 day).
 */
export function daysBetween(a: IsoDate, b: IsoDate, opts: { inclusive?: boolean } = {}): number {
  const diff = toEpochDay(parseYmd(b)) - toEpochDay(parseYmd(a));
  if (!opts.inclusive) return diff;
  return diff + (diff >= 0 ? 1 : -1);
}

export function periodKey(date: IsoDate): string {
  const { year, month } = parseYmd(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function isInPeriod(date: IsoDate, period: string): boolean {
  return periodKey(date) === period;
}

/** Every 'YYYY-MM' period key from fromPeriod to toPeriod, inclusive. */
export function periodsInRange(fromPeriod: string, toPeriod: string): string[] {
  const [fy, fm] = fromPeriod.split('-').map(Number);
  const [ty, tm] = toPeriod.split('-').map(Number);
  let idx = fy * 12 + (fm - 1);
  const endIdx = ty * 12 + (tm - 1);
  const out: string[] = [];
  for (; idx <= endIdx; idx++) {
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

// -- Fiscal periods, with a configurable fiscal year start month (1 = calendar year) --

/** Labels the fiscal year by the calendar year it ends in (e.g. Oct 2026-Sep 2027 = FY2027). */
export function fiscalYear(date: IsoDate, fiscalYearStartMonth = 1): number {
  const { year, month } = parseYmd(date);
  if (fiscalYearStartMonth <= 1) return year;
  return month >= fiscalYearStartMonth ? year + 1 : year;
}

/** Which month of the fiscal year (1-12) this date falls in. */
export function fiscalPeriodNumber(date: IsoDate, fiscalYearStartMonth = 1): number {
  const { month } = parseYmd(date);
  return ((month - fiscalYearStartMonth + 12) % 12) + 1;
}

export function fiscalPeriodKey(date: IsoDate, fiscalYearStartMonth = 1): string {
  const fy = fiscalYear(date, fiscalYearStartMonth);
  const p = fiscalPeriodNumber(date, fiscalYearStartMonth);
  return `FY${fy}-P${String(p).padStart(2, '0')}`;
}

export function fiscalYearStartDate(fiscalYearLabel: number, fiscalYearStartMonth = 1): IsoDate {
  const year = fiscalYearStartMonth <= 1 ? fiscalYearLabel : fiscalYearLabel - 1;
  return formatYmd({ year, month: fiscalYearStartMonth, day: 1 });
}

export function fiscalYearEndDate(fiscalYearLabel: number, fiscalYearStartMonth = 1): IsoDate {
  return monthEnd(addMonths(fiscalYearStartDate(fiscalYearLabel, fiscalYearStartMonth), 11));
}
