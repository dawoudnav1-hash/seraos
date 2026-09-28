/**
 * In-memory spreadsheet workbook: cell storage, dependency graph, recalc,
 * table/column detection, validation, mechanical repair, and xlsx
 * import/export. This is the "sandbox execution" step of the founder's
 * spreadsheet flow described in ARCHITECTURE.md: a workpaper is built with
 * real formulas, recomputed here, and validated before hand-in.
 *
 * Deterministic; no model calls. "Assume malformed data": import tolerates
 * missing/odd cells, and recalc never throws — broken formulas resolve to an
 * Excel error value in the cell instead.
 */

import {
  a1,
  type CellCoord,
  type CellValue,
  type CellRef,
  collectDependencies,
  colLettersToIndex,
  dateToSerial,
  evaluate,
  type FormulaContext,
  type FormulaError,
  indexToColLetters,
  isFormulaError,
  parseA1,
  parseCellOrRange,
  parseFormula,
} from '@/lib/engine/formula';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface CellData {
  /** The literal value for a plain cell, or the last computed result for a
   *  formula cell. */
  value: CellValue;
  /** Raw formula text including the leading "=", when this cell is a formula. */
  formula?: string;
}

export interface SheetData {
  name: string;
  /** Keyed by "col,row" (1-based), sparse. */
  cells: Map<string, CellData>;
  rowCount: number;
  colCount: number;
}

function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

export class Workbook {
  readonly sheets = new Map<string, SheetData>();
  readonly order: string[] = [];

  addSheet(name: string): SheetData {
    if (this.sheets.has(name)) return this.sheets.get(name)!;
    const sheet: SheetData = { name, cells: new Map(), rowCount: 0, colCount: 0 };
    this.sheets.set(name, sheet);
    this.order.push(name);
    return sheet;
  }

  sheet(name: string): SheetData {
    const s = this.sheets.get(name);
    if (!s) throw new Error(`no such sheet: ${name}`);
    return s;
  }

  hasSheet(name: string): boolean {
    return this.sheets.has(name);
  }

  private touch(sheet: SheetData, col: number, row: number): void {
    if (col > sheet.colCount) sheet.colCount = col;
    if (row > sheet.rowCount) sheet.rowCount = row;
  }

  private addressOf(a1text: string): { col: number; row: number } {
    const p = parseA1(a1text);
    if (!p) throw new Error(`bad cell address: ${a1text}`);
    return p;
  }

  setCell(sheetName: string, address: string, value: string | number | boolean | null): void {
    const sheet = this.addSheet(sheetName);
    const { col, row } = this.addressOf(address);
    this.touch(sheet, col, row);
    sheet.cells.set(cellKey(col, row), { value });
  }

  setFormula(sheetName: string, address: string, formula: string): void {
    const sheet = this.addSheet(sheetName);
    const { col, row } = this.addressOf(address);
    this.touch(sheet, col, row);
    // Value is stale until recalc(); evaluated eagerly here too so reads
    // before an explicit recalc() still see something reasonable.
    const existing = sheet.cells.get(cellKey(col, row));
    sheet.cells.set(cellKey(col, row), { formula, value: existing?.value ?? null });
    this.recalcCell(sheet, col, row);
  }

  /** Appends a row of values after the current last row and returns the
   *  1-based row index it was written to. */
  appendRow(sheetName: string, values: (string | number | boolean | null)[]): number {
    const sheet = this.addSheet(sheetName);
    const row = sheet.rowCount + 1;
    values.forEach((v, i) => this.setCell(sheetName, a1(i + 1, row), v));
    return row;
  }

  /** Writes a rectangular block of literal values starting at `topLeft`. */
  setRange(sheetName: string, topLeft: string, rows: (string | number | boolean | null)[][]): void {
    const { col: startCol, row: startRow } = this.addressOf(topLeft);
    rows.forEach((r, ri) => r.forEach((v, ci) => this.setCell(sheetName, a1(startCol + ci, startRow + ri), v)));
  }

  getCellData(sheetName: string, address: string): CellData | undefined {
    const sheet = this.sheets.get(sheetName);
    if (!sheet) return undefined;
    const { col, row } = this.addressOf(address);
    return sheet.cells.get(cellKey(col, row));
  }

  getCell(sheetName: string, address: string): CellValue {
    return this.getCellData(sheetName, address)?.value ?? null;
  }

  private getCellValueRaw(sheet: string, col: number, row: number): CellValue {
    return this.sheets.get(sheet)?.cells.get(cellKey(col, row))?.value ?? null;
  }

  private makeContext(currentSheet: string): FormulaContext {
    return {
      currentSheet,
      sheetExists: (name) => this.hasSheet(name),
      getCellValue: (sheet, col, row) => this.getCellValueRaw(sheet, col, row),
    };
  }

  /** Recomputes a single formula cell against whatever is currently cached
   *  for its dependencies (no ordering guarantee — used for eager
   *  best-effort display; recalc() is what guarantees topological order). */
  private recalcCell(sheet: SheetData, col: number, row: number): void {
    const data = sheet.cells.get(cellKey(col, row));
    if (!data?.formula) return;
    const ast = parseFormula(data.formula);
    const value = evaluate(ast, this.makeContext(sheet.name));
    sheet.cells.set(cellKey(col, row), { formula: data.formula, value });
  }

  /** Recomputes every formula cell in the workbook in dependency order.
   *  Cells that participate in (or depend on) a cycle are set to `#CIRC`. */
  recalc(): void {
    type NodeId = string; // "sheet\u0000col,row"
    const nodeId = (sheet: string, col: number, row: number): NodeId => `${sheet}\u0000${col},${row}`;

    interface FormulaNode {
      sheet: string;
      col: number;
      row: number;
      ast: ReturnType<typeof parseFormula>;
      deps: CellCoord[];
    }

    const nodes = new Map<NodeId, FormulaNode>();
    for (const sheet of this.sheets.values()) {
      for (const [key, data] of sheet.cells) {
        if (!data.formula) continue;
        const [colStr, rowStr] = key.split(',');
        const col = Number(colStr);
        const row = Number(rowStr);
        const ast = parseFormula(data.formula);
        const deps = collectDependencies(ast, sheet.name);
        nodes.set(nodeId(sheet.name, col, row), { sheet: sheet.name, col, row, ast, deps });
      }
    }

    // Kahn's algorithm restricted to edges between formula cells: a formula
    // cell depends on another formula cell only if that dependency is
    // itself a formula (plain values are already resolved).
    const inDegree = new Map<NodeId, number>();
    const dependents = new Map<NodeId, NodeId[]>();
    for (const id of nodes.keys()) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }
    for (const [id, node] of nodes) {
      for (const dep of node.deps) {
        const depId = nodeId(dep.sheet, dep.col, dep.row);
        if (nodes.has(depId) && depId !== id) {
          dependents.get(depId)!.push(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }
    }

    const queue: NodeId[] = [...nodes.keys()].filter((id) => inDegree.get(id) === 0);
    const order: NodeId[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const dep of dependents.get(id) ?? []) {
        const d = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, d);
        if (d === 0) queue.push(dep);
      }
    }

    const cyclic = new Set([...nodes.keys()].filter((id) => (inDegree.get(id) ?? 0) > 0));

    for (const id of cyclic) {
      const n = nodes.get(id)!;
      const sheet = this.sheet(n.sheet);
      const existing = sheet.cells.get(cellKey(n.col, n.row));
      sheet.cells.set(cellKey(n.col, n.row), { formula: existing?.formula, value: '#CIRC' as FormulaError });
    }

    for (const id of order) {
      const n = nodes.get(id)!;
      const sheet = this.sheet(n.sheet);
      const value = evaluate(n.ast, this.makeContext(n.sheet));
      const formula = sheet.cells.get(cellKey(n.col, n.row))!.formula;
      sheet.cells.set(cellKey(n.col, n.row), { formula, value });
    }
  }

  /** Full rectangular snapshot of a sheet's current values, `rowCount` x
   *  `colCount`, blanks as `null`. Used by capture.ts to read an imported
   *  xlsx sheet through the sandbox. */
  toMatrix(sheetName: string): CellValue[][] {
    const sheet = this.sheet(sheetName);
    const out: CellValue[][] = [];
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row: CellValue[] = [];
      for (let c = 1; c <= sheet.colCount; c++) {
        row.push(sheet.cells.get(cellKey(c, r))?.value ?? null);
      }
      out.push(row);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Table detection + column inference
// ---------------------------------------------------------------------------

export interface DetectedTable {
  sheet: string;
  headerRow: number;
  /** Last data row (inclusive), before any trailing total row. */
  lastDataRow: number;
  startCol: number;
  endCol: number;
  headers: string[];
  /** Row index of a "Total"/"Grand Total" row immediately after the data,
   *  if one was found. */
  totalRow?: number;
  /** First few data rows, for value-pattern based column inference. */
  sample: CellValue[][];
}

function isBlankRow(sheet: SheetData, row: number, startCol: number, endCol: number): boolean {
  for (let c = startCol; c <= endCol; c++) {
    const v = sheet.cells.get(cellKey(c, row))?.value;
    if (v !== null && v !== undefined && v !== '') return false;
  }
  return true;
}

function looksLikeTotalLabel(v: CellValue): boolean {
  return typeof v === 'string' && /\b(sub)?total\b/i.test(v);
}

/** Scans a sheet top to bottom for header rows (a row of mostly text
 *  followed by at least one data row) and returns every table found. Blank
 *  rows are skipped between tables; a table stops at a blank row, a
 *  "Total"/"Grand Total" row, or the end of the sheet. */
export function detectTables(sheet: SheetData): DetectedTable[] {
  const tables: DetectedTable[] = [];
  let row = 1;
  while (row <= sheet.rowCount) {
    // Find the bounding columns of non-blank cells on this row.
    let startCol = -1;
    let endCol = -1;
    for (let c = 1; c <= sheet.colCount; c++) {
      const v = sheet.cells.get(cellKey(c, row))?.value;
      if (v !== null && v !== undefined && v !== '') {
        if (startCol === -1) startCol = c;
        endCol = c;
      }
    }
    if (startCol === -1) {
      row++;
      continue; // blank row between tables
    }
    // Candidate header row: needs a plausible data row below it.
    const nextRow = row + 1;
    const hasDataBelow =
      nextRow <= sheet.rowCount &&
      !isBlankRow(sheet, nextRow, startCol, endCol) &&
      !looksLikeTotalLabel(sheet.cells.get(cellKey(startCol, nextRow))?.value ?? null);
    if (!hasDataBelow) {
      row++;
      continue;
    }
    const headers: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const v = sheet.cells.get(cellKey(c, row))?.value;
      headers.push(v === null || v === undefined ? '' : String(v));
    }
    let dataRow = nextRow;
    let lastDataRow = nextRow - 1;
    let totalRow: number | undefined;
    const sample: CellValue[][] = [];
    while (dataRow <= sheet.rowCount) {
      if (isBlankRow(sheet, dataRow, startCol, endCol)) break;
      const label = sheet.cells.get(cellKey(startCol, dataRow))?.value ?? null;
      if (looksLikeTotalLabel(label)) {
        totalRow = dataRow;
        break;
      }
      const rowVals: CellValue[] = [];
      for (let c = startCol; c <= endCol; c++) rowVals.push(sheet.cells.get(cellKey(c, dataRow))?.value ?? null);
      if (sample.length < 5) sample.push(rowVals);
      lastDataRow = dataRow;
      dataRow++;
    }
    tables.push({ sheet: sheet.name, headerRow: row, lastDataRow, startCol, endCol, headers, totalRow, sample });
    row = (totalRow ?? lastDataRow) + 1;
  }
  return tables;
}

export type ColumnRole =
  | 'date'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'account'
  | 'description'
  | 'reference'
  | 'counterparty';

const HEADER_PATTERNS: [ColumnRole, RegExp][] = [
  ['date', /\b(date|posted|period)\b/i],
  ['debit', /\bdebit\b|\bdr\.?\b/i],
  ['credit', /\bcredit\b|\bcr\.?\b/i],
  ['amount', /\b(amount|total|value|net|balance)\b/i],
  ['account', /\b(account|acct|gl code|coa)\b/i],
  ['reference', /\b(reference|ref\.?|check ?#|invoice ?#|memo ?#)\b/i],
  ['counterparty', /\b(vendor|payee|customer|counterparty|payor|supplier)\b/i],
  ['description', /\b(description|memo|narrative|detail|particulars)\b/i],
];

function looksLikeDateValue(v: CellValue): boolean {
  if (typeof v === 'number') return v > 20000 && v < 90000; // plausible Excel serial date range
  if (typeof v !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v) || /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/.test(v);
}

function looksLikeAmountValue(v: CellValue): boolean {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  return /^\(?\$?-?[\d,]+(\.\d+)?\)?-?$/.test(v.trim()) && /\d/.test(v);
}

/** Infers the semantic role of each column in a detected table, by header
 *  keyword first and by the shape of the sample values as a fallback. */
export function inferColumns(table: DetectedTable): Partial<Record<ColumnRole, number>> {
  const result: Partial<Record<ColumnRole, number>> = {};
  const width = table.endCol - table.startCol + 1;

  for (let i = 0; i < width; i++) {
    const header = table.headers[i] ?? '';
    for (const [role, pattern] of HEADER_PATTERNS) {
      if (result[role] !== undefined) continue;
      if (pattern.test(header)) {
        result[role] = table.startCol + i;
        break;
      }
    }
  }

  // Fill any still-missing date/amount roles from value shape.
  if (result.date === undefined) {
    for (let i = 0; i < width; i++) {
      const col = table.startCol + i;
      if (Object.values(result).includes(col)) continue;
      const vals = table.sample.map((r) => r[i]);
      if (vals.length > 0 && vals.every(looksLikeDateValue)) {
        result.date = col;
        break;
      }
    }
  }
  if (result.amount === undefined && result.debit === undefined && result.credit === undefined) {
    for (let i = 0; i < width; i++) {
      const col = table.startCol + i;
      if (Object.values(result).includes(col)) continue;
      const vals = table.sample.map((r) => r[i]);
      if (vals.length > 0 && vals.every(looksLikeAmountValue)) {
        result.amount = col;
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  type: 'broken_ref' | 'error_value' | 'circular_ref' | 'hardcoded_total' | 'assertion_mismatch';
  sheet: string;
  cell: string;
  message: string;
  /** Machine-actionable detail for repair(); only present on fixable issues. */
  meta?: { sumStartRow: number; sumEndRow: number; col: number };
}

export type Assertion = { equal: [string, string] } | { sumOf: string; equals: string };

function errorIssueType(err: FormulaError): 'broken_ref' | 'circular_ref' | 'error_value' {
  if (err === '#CIRC') return 'circular_ref';
  if (err === '#REF!') return 'broken_ref';
  return 'error_value';
}

/** Runs the validation gate of the sandbox flow: broken refs, error values,
 *  circular refs, hardcoded totals, and caller-supplied assertions. Always
 *  recalculates first so results reflect current formulas. */
export function validate(wb: Workbook, assertions: Assertion[] = []): ValidationIssue[] {
  wb.recalc();
  const issues: ValidationIssue[] = [];

  for (const sheet of wb.sheets.values()) {
    for (const [key, data] of sheet.cells) {
      if (isFormulaError(data.value)) {
        const [colStr, rowStr] = key.split(',');
        const col = Number(colStr);
        const row = Number(rowStr);
        const type = errorIssueType(data.value);
        const label = type === 'circular_ref' ? 'part of a circular reference' : `evaluates to ${data.value}`;
        issues.push({
          type,
          sheet: sheet.name,
          cell: a1(col, row),
          message: `${sheet.name}!${a1(col, row)} ${label}${data.formula ? ` (${data.formula})` : ''}`,
        });
      }
    }

    for (const table of detectTables(sheet)) {
      if (table.totalRow === undefined) continue;
      for (let col = table.startCol; col <= table.endCol; col++) {
        const totalData = sheet.cells.get(cellKey(col, table.totalRow));
        if (!totalData || totalData.formula || typeof totalData.value !== 'number') continue;
        const hasNumericDataAbove = Array.from({ length: table.lastDataRow - table.headerRow }, (_, i) => table.headerRow + 1 + i).some(
          (r) => typeof sheet.cells.get(cellKey(col, r))?.value === 'number',
        );
        if (!hasNumericDataAbove) continue;
        issues.push({
          type: 'hardcoded_total',
          sheet: sheet.name,
          cell: a1(col, table.totalRow),
          message: `${sheet.name}!${a1(col, table.totalRow)} is a hardcoded number in a row labeled "total" — expected a SUM formula over ${a1(
            col,
            table.headerRow + 1,
          )}:${a1(col, table.lastDataRow)}`,
          meta: { sumStartRow: table.headerRow + 1, sumEndRow: table.lastDataRow, col },
        });
      }
    }
  }

  const defaultSheet = wb.order[0];
  for (const assertion of assertions) {
    if ('equal' in assertion) {
      const [aRef, bRef] = assertion.equal;
      const a = parseCellOrRange(aRef, defaultSheet);
      const b = parseCellOrRange(bRef, defaultSheet);
      if (!a || a.kind !== 'cell' || !b || b.kind !== 'cell') {
        issues.push({ type: 'assertion_mismatch', sheet: defaultSheet, cell: aRef, message: `unresolvable assertion refs: ${aRef} = ${bRef}` });
        continue;
      }
      const av = wb.getCell(a.sheet, a1(a.col, a.row));
      const bv = wb.getCell(b.sheet, a1(b.col, b.row));
      if (!valuesClose(av, bv)) {
        issues.push({
          type: 'assertion_mismatch',
          sheet: a.sheet,
          cell: a1(a.col, a.row),
          message: `${a.sheet}!${a1(a.col, a.row)} (${fmt(av)}) does not equal ${b.sheet}!${a1(b.col, b.row)} (${fmt(bv)})`,
        });
      }
    } else {
      const range = parseCellOrRange(assertion.sumOf, defaultSheet);
      const target = parseCellOrRange(assertion.equals, defaultSheet);
      if (!range || range.kind !== 'range' || !target || target.kind !== 'cell') {
        issues.push({ type: 'assertion_mismatch', sheet: defaultSheet, cell: assertion.equals, message: `unresolvable assertion: sumOf ${assertion.sumOf}` });
        continue;
      }
      let sum = 0;
      let anyError: CellValue = null;
      for (let r = range.range.start.row; r <= range.range.end.row; r++) {
        for (let c = range.range.start.col; c <= range.range.end.col; c++) {
          const v = wb.getCell(range.sheet, a1(c, r));
          if (isFormulaError(v)) anyError = v;
          else if (typeof v === 'number') sum += v;
        }
      }
      const tv = wb.getCell(target.sheet, a1(target.col, target.row));
      if (anyError !== null) {
        issues.push({
          type: 'assertion_mismatch',
          sheet: range.sheet,
          cell: assertion.sumOf,
          message: `sum of ${range.sheet}!${assertion.sumOf} contains an error value (${anyError})`,
        });
      } else if (!valuesClose(sum, tv)) {
        issues.push({
          type: 'assertion_mismatch',
          sheet: target.sheet,
          cell: a1(target.col, target.row),
          message: `sum of ${range.sheet}!${assertion.sumOf} (${fmt(sum)}) does not equal ${target.sheet}!${a1(target.col, target.row)} (${fmt(tv)})`,
        });
      }
    }
  }

  return issues;
}

function fmt(v: CellValue): string {
  return v === null ? '(blank)' : String(v);
}

function valuesClose(a: CellValue, b: CellValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

export interface RepairChange {
  sheet: string;
  cell: string;
  before: CellValue;
  after: string;
  reason: string;
}

/** Fixes the mechanical classes of validation issue (currently: hardcoded
 *  totals) by writing the formula the sandbox expected, then recalculates.
 *  Returns what it changed; issues it cannot mechanically fix are left as-is
 *  and simply not included in `changes`. */
export function repair(wb: Workbook, issues: ValidationIssue[]): { changes: RepairChange[] } {
  const changes: RepairChange[] = [];
  for (const issue of issues) {
    if (issue.type !== 'hardcoded_total' || !issue.meta) continue;
    const { sumStartRow, sumEndRow, col } = issue.meta;
    const before = wb.getCell(issue.sheet, issue.cell);
    const range = `${a1(col, sumStartRow)}:${a1(col, sumEndRow)}`;
    const formula = `=SUM(${range})`;
    wb.setFormula(issue.sheet, issue.cell, formula);
    changes.push({ sheet: issue.sheet, cell: issue.cell, before, after: formula, reason: `replaced hardcoded total with SUM(${range})` });
  }
  if (changes.length > 0) wb.recalc();
  return { changes };
}

// ---------------------------------------------------------------------------
// xlsx import / export (exceljs), keeping formulas AND cached results.
// ---------------------------------------------------------------------------

function excelJsErrorToOurs(code: string): FormulaError {
  return (isFormulaError(code) ? code : '#VALUE!') as FormulaError;
}

/** Coerces a value read from exceljs into our CellValue model. Dates become
 *  Excel serial numbers so DATE/YEAR/MONTH/DAY etc. treat them uniformly. */
function fromExcelJsValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return dateToSerial(v);
  if (typeof v === 'object' && v !== null && 'error' in (v as Record<string, unknown>)) {
    return excelJsErrorToOurs(String((v as { error: unknown }).error));
  }
  if (typeof v === 'object') return null; // rich text / hyperlink objects: not a plain cell we model
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return null;
}

export async function importXlsx(buffer: Buffer | Uint8Array): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wbx = new ExcelJS.Workbook();
  // exceljs's index.d.ts declares its own global `interface Buffer extends
  // ArrayBuffer {}` (index.d.ts:1), which merges with @types/node's real
  // Buffer and makes the merged type's `slice()` incompatible with itself.
  // No amount of re-typing our own value avoids that — it's a declaration
  // conflict in the library's shipped types, not a real runtime mismatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wbx.xlsx.load(Buffer.from(buffer) as any);
  const wb = new Workbook();
  wbx.worksheets.forEach((ws) => {
    const sheet = wb.addSheet(ws.name);
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const raw = cell.value as unknown;
        if (raw !== null && typeof raw === 'object' && 'formula' in (raw as Record<string, unknown>)) {
          const f = raw as { formula: string; result?: unknown };
          const value = fromExcelJsValue(f.result);
          sheet.cells.set(cellKey(colNumber, rowNumber), { formula: `=${f.formula}`, value });
        } else {
          const value = fromExcelJsValue(raw);
          if (value !== null || raw !== null) sheet.cells.set(cellKey(colNumber, rowNumber), { value });
        }
        if (colNumber > sheet.colCount) sheet.colCount = colNumber;
      });
      if (rowNumber > sheet.rowCount) sheet.rowCount = rowNumber;
    });
  });
  return wb;
}

function toExcelJsErrorLiteral(err: FormulaError): { error: string } | string {
  // '#CIRC' isn't a real Excel error code; write it as visible text instead
  // of forcing it through ExcelJS's typed error enum.
  if (err === '#CIRC') return '#CIRC';
  return { error: err };
}

export async function exportXlsx(wb: Workbook): Promise<Buffer> {
  wb.recalc();
  const ExcelJS = (await import('exceljs')).default;
  const wbx = new ExcelJS.Workbook();
  wbx.creator = 'Vert';
  for (const name of wb.order) {
    const sheet = wb.sheet(name);
    const ws = wbx.addWorksheet(name.slice(0, 31));
    for (let r = 1; r <= sheet.rowCount; r++) {
      for (let c = 1; c <= sheet.colCount; c++) {
        const data = sheet.cells.get(cellKey(c, r));
        if (!data) continue;
        const cell = ws.getCell(r, c);
        if (data.formula) {
          const result = isFormulaError(data.value) ? toExcelJsErrorLiteral(data.value) : (data.value as number | string | boolean | null) ?? undefined;
          cell.value = { formula: data.formula.slice(1), result: result as never };
        } else if (isFormulaError(data.value)) {
          cell.value = toExcelJsErrorLiteral(data.value) as never;
        } else {
          cell.value = data.value;
        }
      }
    }
  }
  const buf = await wbx.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export { a1, indexToColLetters, colLettersToIndex };
export type { CellValue, FormulaError, CellRef };
