/**
 * Deterministic capture/parse: CSV and XLSX in, typed rows, normalized
 * values and a data-quality report out. No model calls.
 *
 * "No silent data dropping": every row excluded anywhere in this file
 * (`dropRows`, `toTxns`) is returned alongside a reason string, never just
 * omitted. "Assume malformed data": every parser here degrades to `null` /
 * a flagged result instead of throwing.
 */

import type { Cents, IsoDate, SourceRef, Txn } from '@/lib/engine/types';
import { type CellValue, type Workbook } from '@/lib/engine/sheet';

export type RawCell = string | number | boolean | null;
export type RawRow = RawCell[];

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 + delimiter detection)
// ---------------------------------------------------------------------------

const DELIMITER_CANDIDATES = [',', '\t', ';', '|'];

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** RFC-4180-aware tokenizer for one specific delimiter: handles quoted
 *  fields, doubled-quote escapes, and newlines inside quotes. */
function tokenizeDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  // Drop a single trailing wholly-empty row caused by a final newline.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/** Picks the most plausible delimiter among comma/tab/semicolon/pipe by
 *  tokenizing a sample with each and preferring the one that yields the
 *  most columns, consistently, across the most rows. */
export function detectDelimiter(text: string): string {
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITER_CANDIDATES) {
    const rows = tokenizeDelimited(text, d).slice(0, 20);
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const mode = counts
      .slice()
      .sort((a, b) => counts.filter((v) => v === a).length - counts.filter((v) => v === b).length)
      .pop()!;
    if (mode < 2) continue;
    const consistency = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * consistency;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export interface ParsedCsv {
  rows: string[][];
  delimiter: string;
}

export function parseCsv(input: string, opts: { delimiter?: string } = {}): ParsedCsv {
  const text = stripBom(input);
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  return { rows: tokenizeDelimited(text, delimiter), delimiter };
}

// ---------------------------------------------------------------------------
// xlsx sheet -> rows, through the sandbox (sheet.ts)
// ---------------------------------------------------------------------------

/** Materializes every sheet of an already-imported workbook as plain row
 *  matrices, the same shape CSV rows come in. */
export function workbookToRows(wb: Workbook): { sheetName: string; rows: CellValue[][] }[] {
  return wb.order.map((name) => ({ sheetName: name, rows: wb.toMatrix(name) }));
}

// ---------------------------------------------------------------------------
// Header detection (incl. multiple header rows and subtotal/total rows)
// ---------------------------------------------------------------------------

export interface HeaderDetection {
  headers: string[];
  headerRowCount: number;
  dataStartIndex: number;
}

function isBlankCell(v: RawCell | CellValue): boolean {
  return v === null || v === undefined || v === '';
}

function isBlankRow(row: (RawCell | CellValue)[]): boolean {
  return row.every(isBlankCell);
}

function cellLooksNumericOrDate(v: RawCell | CellValue): boolean {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return false;
  if (/^\(?-?\$?[\d,]+(\.\d+)?\)?-?$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return true;
  return false;
}

/** Detects one or more header rows at the top of `rows` (an ERP export
 *  often has a grouping row above the real column names, with the grouping
 *  cell merged/blank-filled across the columns it spans) and returns the
 *  combined header text per column plus where the data actually starts. */
export function detectHeaders(rows: (RawCell | CellValue)[][]): HeaderDetection {
  let i = 0;
  while (i < rows.length && isBlankRow(rows[i])) i++;
  if (i >= rows.length) return { headers: [], headerRowCount: 0, dataStartIndex: rows.length };

  const headerRows: (RawCell | CellValue)[][] = [];
  let cursor = i;
  while (cursor < rows.length && headerRows.length < 3) {
    const row = rows[cursor];
    const nonBlank = row.filter((v) => !isBlankCell(v));
    if (nonBlank.length === 0) break;
    const looksLikeHeader = nonBlank.every((v) => typeof v === 'string' && !cellLooksNumericOrDate(v));
    if (!looksLikeHeader) break;
    headerRows.push(row);
    cursor++;
  }
  if (headerRows.length === 0) {
    // No text-only row found; treat the first non-blank row as the header
    // anyway, rather than silently producing no columns at all.
    headerRows.push(rows[i]);
    cursor = i + 1;
  }

  const width = Math.max(...rows.map((r) => r.length), 0);
  // Grouping rows (everything above the last header row) are merge-header
  // style: a category label sits in the first cell of its span and the
  // rest are blank, so forward-fill each grouping row left to right.
  const groupRows = headerRows.slice(0, -1).map((hr) => {
    const filled: string[] = [];
    let last = '';
    for (let c = 0; c < width; c++) {
      const v = hr[c];
      if (!isBlankCell(v)) last = String(v).trim();
      filled.push(last);
    }
    return filled;
  });
  const leaf = headerRows[headerRows.length - 1];
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    const groupText = groupRows.map((gr) => gr[c]).filter(Boolean).pop() ?? '';
    const leafText = isBlankCell(leaf[c]) ? '' : String(leaf[c]).trim();
    headers.push([groupText, leafText].filter(Boolean).join(' ').trim());
  }

  return { headers, headerRowCount: cursor - i, dataStartIndex: cursor };
}

// ---------------------------------------------------------------------------
// Row filtering: subtotal / "Total" / "Grand Total" rows and blank rows
// ---------------------------------------------------------------------------

export interface DroppedRow {
  rowIndex: number;
  reason: string;
}

const TOTAL_ROW_RE = /^\s*(grand\s+)?(sub)?total\b/i;

/** Removes blank rows and embedded subtotal/total rows from a data block,
 *  logging why each row was excluded — never a silent drop. `rowIndex` is
 *  the row's position within `rows` (0-based), for traceability back to the
 *  source. */
export function dropNonDataRows(rows: (RawCell | CellValue)[][]): { kept: (RawCell | CellValue)[][]; keptIndices: number[]; dropped: DroppedRow[] } {
  const kept: (RawCell | CellValue)[][] = [];
  const keptIndices: number[] = [];
  const dropped: DroppedRow[] = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) {
      dropped.push({ rowIndex: i, reason: 'blank row' });
      return;
    }
    const firstText = row.find((v) => typeof v === 'string' && v.trim() !== '');
    if (typeof firstText === 'string' && TOTAL_ROW_RE.test(firstText)) {
      dropped.push({ rowIndex: i, reason: `subtotal/total row ("${firstText.trim()}")` });
      return;
    }
    kept.push(row);
    keptIndices.push(i);
  });
  return { kept, keptIndices, dropped };
}

// ---------------------------------------------------------------------------
// Date normalization
// ---------------------------------------------------------------------------

export interface ParsedDate {
  iso: IsoDate | null;
  ambiguous: boolean;
  reason?: string;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 9999) return false;
  return d <= new Date(y, m, 0).getDate();
}

const EXCEL_EPOCH_OFFSET = 25569;

/** Parses a date cell in any of: ISO, MM/DD/YYYY, DD/MM/YYYY (flagged
 *  ambiguous when both are plausible), an Excel serial number, or
 *  "Apr 3, 2026". Returns `{iso: null}` (never throws) when unparseable. */
export function parseFlexibleDate(value: RawCell | CellValue): ParsedDate {
  if (value === null || value === undefined) return { iso: null, ambiguous: false, reason: 'blank' };

  if (typeof value === 'number') {
    if (value < 1 || value > 100000) return { iso: null, ambiguous: false, reason: 'number out of plausible date-serial range' };
    const ms = Math.round((value - EXCEL_EPOCH_OFFSET) * 86400000);
    const d = new Date(ms);
    return { iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, ambiguous: false };
  }

  if (typeof value !== 'string') return { iso: null, ambiguous: false, reason: 'not a string or number' };
  const s = value.trim();
  if (s === '') return { iso: null, ambiguous: false, reason: 'blank' };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    if (!isValidYmd(Number(y), Number(m), Number(d))) return { iso: null, ambiguous: false, reason: 'invalid calendar date' };
    return { iso: `${y}-${m}-${d}`, ambiguous: false };
  }

  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (named) {
    const month = MONTH_NAMES[named[1].toLowerCase()];
    if (!month) return { iso: null, ambiguous: false, reason: `unrecognized month name "${named[1]}"` };
    const day = Number(named[2]);
    const year = Number(named[3]);
    if (!isValidYmd(year, month, day)) return { iso: null, ambiguous: false, reason: 'invalid calendar date' };
    return { iso: `${year}-${pad(month)}-${pad(day)}`, ambiguous: false };
  }

  const slash = /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/.exec(s);
  if (slash) {
    const [, aStr, bStr, cStr] = slash;
    const a = Number(aStr);
    const b = Number(bStr);
    const c = Number(cStr);
    // Year-first form, e.g. 2026/04/03.
    if (aStr.length === 4) {
      if (!isValidYmd(a, b, c)) return { iso: null, ambiguous: false, reason: 'invalid calendar date' };
      return { iso: `${a}-${pad(b)}-${pad(c)}`, ambiguous: false };
    }
    const year = c;
    const mdValid = isValidYmd(year, a, b); // MM/DD/YYYY
    const dmValid = isValidYmd(year, b, a); // DD/MM/YYYY
    if (mdValid && dmValid && a !== b) {
      return { iso: `${year}-${pad(a)}-${pad(b)}`, ambiguous: true, reason: 'both MM/DD/YYYY and DD/MM/YYYY are plausible' };
    }
    if (mdValid) return { iso: `${year}-${pad(a)}-${pad(b)}`, ambiguous: false };
    if (dmValid) return { iso: `${year}-${pad(b)}-${pad(a)}`, ambiguous: false };
    return { iso: null, ambiguous: false, reason: 'invalid calendar date' };
  }

  return { iso: null, ambiguous: false, reason: 'unrecognized date format' };
}

// ---------------------------------------------------------------------------
// Amount normalization
// ---------------------------------------------------------------------------

export interface ParsedAmount {
  cents: Cents | null;
  currencySymbol?: string;
  reason?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

/** Parses "$1,299.99", "(1,173.30)" (accounting negative), "1,234.56-"
 *  (trailing minus), "-1,234.56", and plain numbers into signed integer
 *  cents. Returns `{cents: null}` (never throws) when unparseable. */
export function parseFlexibleAmount(value: RawCell | CellValue): ParsedAmount {
  if (typeof value === 'number') return { cents: Math.round(value * 100) };
  if (value === null || value === undefined) return { cents: null, reason: 'blank' };
  if (typeof value !== 'string') return { cents: null, reason: 'not a string or number' };

  let s = value.trim();
  if (s === '') return { cents: null, reason: 'blank' };

  let currencySymbol: string | undefined;
  for (const sym of Object.keys(CURRENCY_SYMBOLS)) {
    if (s.includes(sym)) {
      currencySymbol = sym;
      s = s.split(sym).join('');
    }
  }

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.trim();
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  } else if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  s = s.trim().replace(/,/g, '');
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return { cents: null, currencySymbol, reason: `unparseable amount "${value}"` };

  const [intPart, fracPart = ''] = s.split('.');
  const frac2 = (fracPart + '00').slice(0, 2);
  const cents = Number(intPart) * 100 + Number(frac2 || '0');
  return { cents: negative ? -cents : cents, currencySymbol };
}

// ---------------------------------------------------------------------------
// Row -> Txn
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  date?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  description?: number;
  counterparty?: number;
  reference?: number;
  account?: number;
  currency?: number;
}

export interface ToTxnsResult {
  txns: Txn[];
  dropped: DroppedRow[];
  /** Rows whose date was parseable two ways ("both MM/DD and DD/MM
   *  plausible"); the txn is still produced (using the MM/DD/YYYY default),
   *  but flagged for a human to confirm. */
  ambiguousDates: { rowIndex: number; iso: IsoDate }[];
}

/** Converts normalized rows into `Txn`s per `mapping`. Debit/credit columns
 *  are combined into a single signed amount (debit positive, credit
 *  negative — the common ledger convention). Every row that cannot produce
 *  a valid date+amount is dropped with a reason, never silently. */
export function toTxns(rows: (RawCell | CellValue)[][], mapping: ColumnMapping, source: { system: string; file: string }): ToTxnsResult {
  const txns: Txn[] = [];
  const dropped: DroppedRow[] = [];
  const ambiguousDates: { rowIndex: number; iso: IsoDate }[] = [];

  rows.forEach((row, i) => {
    if (isBlankRow(row)) {
      dropped.push({ rowIndex: i, reason: 'blank row' });
      return;
    }
    const rowLabel = `row${i + 1}`;
    const dateCell = mapping.date !== undefined ? row[mapping.date] : undefined;
    const date = parseFlexibleDate(dateCell ?? null);
    if (!date.iso) {
      dropped.push({ rowIndex: i, reason: `invalid date (${date.reason ?? 'unparseable'})` });
      return;
    }
    if (date.ambiguous) ambiguousDates.push({ rowIndex: i, iso: date.iso });

    let amountCents: number | null = null;
    let currencySymbol: string | undefined;
    if (mapping.amount !== undefined) {
      const parsed = parseFlexibleAmount(row[mapping.amount]);
      amountCents = parsed.cents;
      currencySymbol = parsed.currencySymbol;
    } else if (mapping.debit !== undefined || mapping.credit !== undefined) {
      const debit = mapping.debit !== undefined ? parseFlexibleAmount(row[mapping.debit]) : { cents: null };
      const credit = mapping.credit !== undefined ? parseFlexibleAmount(row[mapping.credit]) : { cents: null };
      if (debit.cents && debit.cents !== 0) amountCents = Math.abs(debit.cents);
      else if (credit.cents && credit.cents !== 0) amountCents = -Math.abs(credit.cents);
      else if (debit.cents === 0 || credit.cents === 0) amountCents = 0;
      currencySymbol = debit.currencySymbol ?? credit.currencySymbol;
    }
    if (amountCents === null) {
      dropped.push({ rowIndex: i, reason: 'invalid or missing amount' });
      return;
    }

    const description = mapping.description !== undefined ? String(row[mapping.description] ?? '').trim() : '';
    const counterparty = mapping.counterparty !== undefined ? String(row[mapping.counterparty] ?? '').trim() || undefined : undefined;
    const reference = mapping.reference !== undefined ? String(row[mapping.reference] ?? '').trim() || undefined : undefined;
    const account = mapping.account !== undefined ? String(row[mapping.account] ?? '').trim() || undefined : undefined;
    const currency = mapping.currency !== undefined ? String(row[mapping.currency] ?? '').trim() || undefined : currencySymbol && CURRENCY_SYMBOLS[currencySymbol];

    const id = `${source.file}#${rowLabel}`;
    const sourceRef: SourceRef = { system: source.system, id, label: description || undefined };
    txns.push({ id, date: date.iso, amountCents, description, counterparty, reference, account, currency, source: sourceRef });
  });

  return { txns, dropped, ambiguousDates };
}

// ---------------------------------------------------------------------------
// Data-quality profile
// ---------------------------------------------------------------------------

export interface ColumnProfile {
  index: number;
  nullPercent: number;
  typeMismatchPercent: number;
  inferredType: 'number' | 'date' | 'text' | 'mixed' | 'empty';
}

export interface DataQualityReport {
  score: number;
  rowCountBefore: number;
  rowCountAfter: number;
  droppedRows: DroppedRow[];
  duplicateRowCount: number;
  columns: ColumnProfile[];
}

function inferColumnType(values: (RawCell | CellValue)[]): 'number' | 'date' | 'text' | 'mixed' | 'empty' {
  const nonBlank = values.filter((v) => !isBlankCell(v));
  if (nonBlank.length === 0) return 'empty';
  const numeric = nonBlank.filter((v) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]+(\.\d+)?$/.test(v.trim()))).length;
  const dateLike = nonBlank.filter((v) => parseFlexibleDate(v).iso !== null).length;
  if (numeric === nonBlank.length) return 'number';
  if (dateLike === nonBlank.length) return 'date';
  if (numeric === 0 && dateLike === 0) return 'text';
  return 'mixed';
}

/** Produces a 0-100 data-quality score and per-column stats for a raw row
 *  block (already header-stripped). Rows dropped upstream (blank / subtotal
 *  rows via `dropNonDataRows`) should be passed in `preDropped` so the
 *  before/after counts and score account for them. */
export function profile(rows: (RawCell | CellValue)[][], preDropped: DroppedRow[] = []): DataQualityReport {
  const rowCountBefore = rows.length + preDropped.length;
  const { kept, dropped: blankDropped } = dropNonDataRows(rows);
  const droppedRows = [...preDropped, ...blankDropped];
  const rowCountAfter = kept.length;

  const seen = new Map<string, number>();
  let duplicateRowCount = 0;
  for (const row of kept) {
    const key = JSON.stringify(row);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) duplicateRowCount++;
  }

  const width = Math.max(0, ...kept.map((r) => r.length));
  const columns: ColumnProfile[] = [];
  for (let c = 0; c < width; c++) {
    const values = kept.map((r) => r[c] ?? null);
    const nullCount = values.filter(isBlankCell).length;
    const inferredType = inferColumnType(values);
    const nonBlank = values.filter((v) => !isBlankCell(v));
    let mismatches = 0;
    if (inferredType === 'number') mismatches = nonBlank.filter((v) => !(typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]+(\.\d+)?$/.test(v.trim())))).length;
    else if (inferredType === 'date') mismatches = nonBlank.filter((v) => parseFlexibleDate(v).iso === null).length;
    columns.push({
      index: c,
      nullPercent: values.length === 0 ? 0 : (nullCount / values.length) * 100,
      typeMismatchPercent: nonBlank.length === 0 ? 0 : (mismatches / nonBlank.length) * 100,
      inferredType,
    });
  }

  const avgNull = columns.length === 0 ? 0 : columns.reduce((s, c) => s + c.nullPercent, 0) / columns.length;
  const avgMismatch = columns.length === 0 ? 0 : columns.reduce((s, c) => s + c.typeMismatchPercent, 0) / columns.length;
  const droppedPercent = rowCountBefore === 0 ? 0 : (droppedRows.length / rowCountBefore) * 100;
  const dupPercent = rowCountAfter === 0 ? 0 : (duplicateRowCount / rowCountAfter) * 100;

  const score = Math.max(0, Math.min(100, 100 - avgNull * 0.3 - avgMismatch * 0.4 - droppedPercent * 0.2 - dupPercent * 0.1));

  return { score: Math.round(score * 10) / 10, rowCountBefore, rowCountAfter, droppedRows, duplicateRowCount, columns };
}
