/**
 * Formula language for the spreadsheet sandbox (`sheet.ts`): tokenizer, parser
 * and evaluator. Pure and deterministic — no I/O, no model calls. `sheet.ts`
 * owns cell storage and the dependency graph; this file only knows how to
 * turn formula text into an AST and an AST + a cell-lookup context into a
 * value.
 *
 * "Assume malformed data": nothing in here throws for bad *formula content*.
 * Anything unparseable or semantically invalid becomes an Excel error value
 * instead, exactly like a spreadsheet would show.
 */

/** The Excel error values this sandbox can produce, plus `#CIRC` for a
 *  circular reference (sheet.ts's cycle detector uses that one). */
export type FormulaError = '#REF!' | '#DIV/0!' | '#NAME?' | '#VALUE!' | '#N/A' | '#NUM!' | '#CIRC';

const FORMULA_ERRORS: ReadonlySet<string> = new Set([
  '#REF!',
  '#DIV/0!',
  '#NAME?',
  '#VALUE!',
  '#N/A',
  '#NUM!',
  '#CIRC',
]);

export function isFormulaError(v: unknown): v is FormulaError {
  return typeof v === 'string' && FORMULA_ERRORS.has(v);
}

/** A resolved cell value. `null` means genuinely blank (never written). */
export type CellValue = number | string | boolean | FormulaError | null;

/** A rectangular grid of resolved values, row-major, for range results. */
export type Grid = CellValue[][];

// ---------------------------------------------------------------------------
// Column letter <-> index (1-based: A = 1)
// ---------------------------------------------------------------------------

export function colLettersToIndex(letters: string): number {
  let n = 0;
  const s = letters.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n;
}

export function indexToColLetters(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function a1(col: number, row: number): string {
  return `${indexToColLetters(col)}${row}`;
}

// ---------------------------------------------------------------------------
// Address parsing (also used directly by sheet.ts for A1-notation APIs and
// by validate() to resolve assertion refs like 'Summary!D6').
// ---------------------------------------------------------------------------

export interface CellRef {
  sheet: string | null;
  col: number;
  row: number;
  absCol: boolean;
  absRow: boolean;
}

export interface RangeRef {
  sheet: string | null;
  start: { col: number; row: number };
  end: { col: number; row: number };
}

const CELL_PART = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

function parseCellPart(text: string): { col: number; row: number; absCol: boolean; absRow: boolean } | null {
  const m = CELL_PART.exec(text);
  if (!m) return null;
  const col = colLettersToIndex(m[2]);
  const row = Number(m[4]);
  if (col < 1 || row < 1) return null;
  return { col, row, absCol: m[1] === '$', absRow: m[3] === '$' };
}

/** Parses a bare cell address like "A1" or "$A$1" (no sheet prefix). */
export function parseA1(text: string): { col: number; row: number } | null {
  const p = parseCellPart(text.trim());
  return p ? { col: p.col, row: p.row } : null;
}

/** Unescapes a single-quoted sheet name ('' -> '). */
function unescapeSheetName(quoted: string): string {
  return quoted.slice(1, -1).replace(/''/g, "'");
}

const REF_REGEX =
  /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_]*))!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?$/;

/** Parses a single cell reference, optionally sheet-qualified: "A1",
 *  "$A$1", "Sheet1!A1", "'My Sheet'!A1". Returns null if it is not a
 *  well-formed single-cell reference (e.g. it is actually a range). */
export function parseCellRef(text: string): CellRef | null {
  const m = REF_REGEX.exec(text.trim());
  if (!m || m[4]) return null; // m[4] present means it's a range, not a single cell
  const sheet = m[1] !== undefined ? unescapeSheetName(`'${m[1]}'`) : m[2] !== undefined ? m[2] : null;
  const cell = parseCellPart(m[3]);
  if (!cell) return null;
  return { sheet, ...cell };
}

/** Parses a range reference: "A1:B10", "Sheet1!A1:B10", "'My Sheet'!A1:B10". */
export function parseRangeRef(text: string): RangeRef | null {
  const m = REF_REGEX.exec(text.trim());
  if (!m || !m[4]) return null; // no second part means it's not a range
  const sheet = m[1] !== undefined ? unescapeSheetName(`'${m[1]}'`) : m[2] !== undefined ? m[2] : null;
  const start = parseCellPart(m[3]);
  const end = parseCellPart(m[4]);
  if (!start || !end) return null;
  return {
    sheet,
    start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row) },
    end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row) },
  };
}

/** Parses either a single cell or a range, with an optional sheet prefix,
 *  falling back to `defaultSheet` when the text carries no prefix. Used by
 *  validate()'s assertions. */
export function parseCellOrRange(
  text: string,
  defaultSheet: string,
): { kind: 'cell'; sheet: string; col: number; row: number } | { kind: 'range'; sheet: string; range: RangeRef } | null {
  const cell = parseCellRef(text);
  if (cell) return { kind: 'cell', sheet: cell.sheet ?? defaultSheet, col: cell.col, row: cell.row };
  const range = parseRangeRef(text);
  if (range) return { kind: 'range', sheet: range.sheet ?? defaultSheet, range };
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'number'
  | 'string'
  | 'bool'
  | 'ident'
  | 'ref'
  | 'range'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof';

interface Token {
  type: TokenType;
  text: string;
  value?: number | string | boolean;
  ref?: CellRef;
  range?: RangeRef;
}

class FormulaSyntaxError extends Error {}

const REF_LEAD = /^(?:'(?:[^']|'')+'!|[A-Za-z_][A-Za-z0-9_]*!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // Reference (cell or range), tried before plain identifiers.
    const refMatch = REF_LEAD.exec(input.slice(i));
    if (refMatch && refMatch[0].length > 0) {
      const text = refMatch[0];
      const range = parseRangeRef(text);
      if (range) {
        tokens.push({ type: 'range', text, range });
      } else {
        const ref = parseCellRef(text);
        if (ref) {
          tokens.push({ type: 'ref', text, ref });
        } else {
          throw new FormulaSyntaxError(`bad reference near "${text}"`);
        }
      }
      i += text.length;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(input[j])) j++;
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k++;
        if (/[0-9]/.test(input[k] ?? '')) {
          j = k;
          while (j < n && /[0-9]/.test(input[j])) j++;
        }
      }
      const text = input.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw new FormulaSyntaxError(`bad number "${text}"`);
      tokens.push({ type: 'number', text, value });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (input[j] === '"') {
          if (input[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        s += input[j];
        j++;
      }
      tokens.push({ type: 'string', text: input.slice(i, j), value: s });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(input[j])) j++;
      const text = input.slice(i, j);
      const upper = text.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'bool', text, value: upper === 'TRUE' });
      } else {
        tokens.push({ type: 'ident', text });
      }
      i = j;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', text: c });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', text: c });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'comma', text: c });
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '=') {
      let j = i + 1;
      if ((c === '<' && (input[j] === '=' || input[j] === '>')) || (c === '>' && input[j] === '=')) j++;
      tokens.push({ type: 'op', text: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^&'.includes(c)) {
      tokens.push({ type: 'op', text: c });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`unexpected character "${c}"`);
  }
  tokens.push({ type: 'eof', text: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser (precedence climbing). Excel precedence, high to low:
// unary minus > ^ > * / > + - > & > comparisons.
// (Yes, unary binds tighter than ^ in Excel: -2^2 evaluates to 4.)
// ---------------------------------------------------------------------------

export type Node =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'error'; value: FormulaError }
  | { type: 'ref'; ref: CellRef }
  | { type: 'range'; range: RangeRef }
  | { type: 'unary'; op: '-'; arg: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new FormulaSyntaxError(`expected ${type}, got ${t.type} "${t.text}"`);
    return t;
  }

  parse(): Node {
    const node = this.parseComparison();
    if (this.peek().type !== 'eof') throw new FormulaSyntaxError(`unexpected trailing "${this.peek().text}"`);
    return node;
  }

  private parseComparison(): Node {
    let left = this.parseConcat();
    while (this.peek().type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek().text)) {
      const op = this.next().text;
      const right = this.parseConcat();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseConcat(): Node {
    let left = this.parseAdditive();
    while (this.peek().type === 'op' && this.peek().text === '&') {
      this.next();
      const right = this.parseAdditive();
      left = { type: 'binary', op: '&', left, right };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.peek().type === 'op' && (this.peek().text === '+' || this.peek().text === '-')) {
      const op = this.next().text;
      const right = this.parseMultiplicative();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseExponent();
    while (this.peek().type === 'op' && (this.peek().text === '*' || this.peek().text === '/')) {
      const op = this.next().text;
      const right = this.parseExponent();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseExponent(): Node {
    let left = this.parseUnary();
    while (this.peek().type === 'op' && this.peek().text === '^') {
      this.next();
      const right = this.parseUnary();
      left = { type: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek().type === 'op' && this.peek().text === '-') {
      this.next();
      return { type: 'unary', op: '-', arg: this.parseUnary() };
    }
    if (this.peek().type === 'op' && this.peek().text === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (t.type === 'number') {
      this.next();
      return { type: 'num', value: t.value as number };
    }
    if (t.type === 'string') {
      this.next();
      return { type: 'str', value: t.value as string };
    }
    if (t.type === 'bool') {
      this.next();
      return { type: 'bool', value: t.value as boolean };
    }
    if (t.type === 'ref') {
      this.next();
      return { type: 'ref', ref: t.ref! };
    }
    if (t.type === 'range') {
      this.next();
      return { type: 'range', range: t.range! };
    }
    if (t.type === 'lparen') {
      this.next();
      const inner = this.parseComparison();
      this.expect('rparen');
      return inner;
    }
    if (t.type === 'ident') {
      this.next();
      if (this.peek().type === 'lparen') {
        this.next();
        const args: Node[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseComparison());
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.parseComparison());
          }
        }
        this.expect('rparen');
        return { type: 'call', name: t.text.toUpperCase(), args };
      }
      // A bare, unrecognized word used as a value: Excel would refuse this
      // formula outright with #NAME?. We surface the same error as a value
      // instead of throwing, per "assume malformed data".
      return { type: 'error', value: '#NAME?' };
    }
    throw new FormulaSyntaxError(`unexpected token "${t.text}"`);
  }
}

/** Parses formula text (with or without a leading "=") into an AST. Never
 *  throws: unparseable text becomes a `#NAME?` error node, matching how a
 *  spreadsheet would refuse malformed input at the cell that holds it. */
export function parseFormula(text: string): Node {
  const body = text.startsWith('=') ? text.slice(1) : text;
  try {
    const tokens = tokenize(body);
    return new Parser(tokens).parse();
  } catch {
    return { type: 'error', value: '#NAME?' };
  }
}

// ---------------------------------------------------------------------------
// Dependency collection (sheet.ts builds the graph from this)
// ---------------------------------------------------------------------------

export interface CellCoord {
  sheet: string;
  col: number;
  row: number;
}

/** Walks the AST and returns every individual cell it reads, with ranges
 *  expanded. `currentSheet` resolves unqualified refs. */
export function collectDependencies(node: Node, currentSheet: string): CellCoord[] {
  const out: CellCoord[] = [];
  walk(node);
  return out;

  function walk(n: Node): void {
    switch (n.type) {
      case 'ref':
        out.push({ sheet: n.ref.sheet ?? currentSheet, col: n.ref.col, row: n.ref.row });
        return;
      case 'range': {
        const sheet = n.range.sheet ?? currentSheet;
        for (let r = n.range.start.row; r <= n.range.end.row; r++) {
          for (let c = n.range.start.col; c <= n.range.end.col; c++) {
            out.push({ sheet, col: c, row: r });
          }
        }
        return;
      }
      case 'unary':
        walk(n.arg);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'call':
        for (const a of n.args) walk(a);
        return;
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface FormulaContext {
  currentSheet: string;
  sheetExists(name: string): boolean;
  /** Returns the current (already-recalculated, in topo order) value of a
   *  cell, or `null` if it has never been written. */
  getCellValue(sheet: string, col: number, row: number): CellValue;
}

type EvalResult = CellValue | Grid;

function isGrid(v: EvalResult): v is Grid {
  return Array.isArray(v);
}

/** Collapses a 1x1 grid to its scalar; anything bigger is a #VALUE! (Excel
 *  would attempt an implicit intersection we don't support). */
function toScalar(v: EvalResult): CellValue {
  if (!isGrid(v)) return v;
  if (v.length === 1 && v[0].length === 1) return v[0][0];
  return '#VALUE!';
}

function toGrid(v: EvalResult): Grid {
  return isGrid(v) ? v : [[v]];
}

function flatten(grid: Grid): CellValue[] {
  const out: CellValue[] = [];
  for (const row of grid) for (const v of row) out.push(v);
  return out;
}

function firstError(vals: CellValue[]): FormulaError | null {
  for (const v of vals) if (isFormulaError(v)) return v;
  return null;
}

/** Coerces a value to a number for arithmetic; blank -> 0, boolean -> 1/0,
 *  numeric string -> parsed. Anything else is #VALUE!. Errors propagate. */
function num(v: CellValue): number | FormulaError {
  if (isFormulaError(v)) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return 0;
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
    return '#VALUE!';
  }
  return '#VALUE!';
}

function str(v: CellValue): string {
  if (isFormulaError(v)) return v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function truthy(v: CellValue): boolean | FormulaError {
  if (isFormulaError(v)) return v;
  if (typeof v === 'boolean') return v;
  const n = num(v);
  if (isFormulaError(n)) return n;
  return n !== 0;
}

// Excel epoch, ignoring the 1900 leap-year bug (irrelevant for any date an
// accounting workpaper would ever hold, all of which post-date 1900-03-01).
const EXCEL_EPOCH_OFFSET = 25569;
const MS_PER_DAY = 86400 * 1000;

export function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY));
}

export function dateToSerial(date: Date): number {
  return Math.round(date.getTime() / MS_PER_DAY) + EXCEL_EPOCH_OFFSET;
}

/** Evaluates an AST node against a context. Never throws — every failure
 *  mode becomes a `FormulaError` value, exactly like a spreadsheet cell. */
export function evaluate(node: Node, ctx: FormulaContext): CellValue {
  return toScalar(evalNode(node, ctx));
}

function evalNode(node: Node, ctx: FormulaContext): EvalResult {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'str':
      return node.value;
    case 'bool':
      return node.value;
    case 'error':
      return node.value;
    case 'ref': {
      const sheet = node.ref.sheet ?? ctx.currentSheet;
      if (!ctx.sheetExists(sheet)) return '#REF!';
      return ctx.getCellValue(sheet, node.ref.col, node.ref.row);
    }
    case 'range': {
      const sheet = node.range.sheet ?? ctx.currentSheet;
      if (!ctx.sheetExists(sheet)) return '#REF!';
      const grid: Grid = [];
      for (let r = node.range.start.row; r <= node.range.end.row; r++) {
        const rowVals: CellValue[] = [];
        for (let c = node.range.start.col; c <= node.range.end.col; c++) {
          rowVals.push(ctx.getCellValue(sheet, c, r));
        }
        grid.push(rowVals);
      }
      return grid;
    }
    case 'unary': {
      const v = toScalar(evalNode(node.arg, ctx));
      const n = num(v);
      if (isFormulaError(n)) return n;
      return -n;
    }
    case 'binary':
      return evalBinary(node.op, toScalar(evalNode(node.left, ctx)), toScalar(evalNode(node.right, ctx)));
    case 'call':
      return evalCall(node.name, node.args, ctx);
  }
}

function evalBinary(op: string, l: CellValue, r: CellValue): CellValue {
  const err = firstError([l, r]);
  if (err) return err;
  if (op === '&') return str(l) + str(r);
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compare(op, l, r);
  const ln = num(l);
  if (isFormulaError(ln)) return ln;
  const rn = num(r);
  if (isFormulaError(rn)) return rn;
  switch (op) {
    case '+':
      return ln + rn;
    case '-':
      return ln - rn;
    case '*':
      return ln * rn;
    case '/':
      return rn === 0 ? '#DIV/0!' : ln / rn;
    case '^':
      return Math.pow(ln, rn);
    default:
      return '#NAME?';
  }
}

function compare(op: string, l: CellValue, r: CellValue): boolean {
  let cmp: number;
  if (typeof l === 'number' && typeof r === 'number') {
    cmp = l - r;
  } else if (typeof l === 'boolean' || typeof r === 'boolean') {
    const lb = typeof l === 'boolean' ? (l ? 1 : 0) : num(l);
    const rb = typeof r === 'boolean' ? (r ? 1 : 0) : num(r);
    cmp = (isFormulaError(lb) ? 0 : lb) - (isFormulaError(rb) ? 0 : rb);
  } else {
    const ls = str(l).toLowerCase();
    const rs = str(r).toLowerCase();
    cmp = ls < rs ? -1 : ls > rs ? 1 : 0;
  }
  switch (op) {
    case '=':
      return cmp === 0;
    case '<>':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '>=':
      return cmp >= 0;
    default:
      return false;
  }
}

/** Excel-style criteria match for SUMIF/SUMIFS: exact equality, or a
 *  leading comparison operator (">100", "<=0", "<>0", "=foo"). */
function matchesCriteria(value: CellValue, criteria: CellValue): boolean {
  if (isFormulaError(value) || isFormulaError(criteria)) return false;
  const c = str(criteria);
  const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c);
  if (m) {
    const op = m[1];
    const rhsText = m[2];
    const rhsNum = Number(rhsText);
    if (!Number.isNaN(rhsNum) && typeof value === 'number') {
      switch (op) {
        case '=':
          return value === rhsNum;
        case '<>':
          return value !== rhsNum;
        case '<':
          return value < rhsNum;
        case '>':
          return value > rhsNum;
        case '<=':
          return value <= rhsNum;
        case '>=':
          return value >= rhsNum;
      }
    }
    if (op === '=') return str(value).toLowerCase() === rhsText.toLowerCase();
    if (op === '<>') return str(value).toLowerCase() !== rhsText.toLowerCase();
    return false;
  }
  if (typeof value === 'number') {
    const cn = Number(c);
    if (!Number.isNaN(cn)) return value === cn;
  }
  return str(value).toLowerCase() === c.toLowerCase();
}

function evalCall(name: string, argNodes: Node[], ctx: FormulaContext): EvalResult {
  const evalScalar = (i: number): CellValue => toScalar(evalNode(argNodes[i], ctx));
  const evalGrid = (i: number): Grid => toGrid(evalNode(argNodes[i], ctx));

  switch (name) {
    case 'SUM': {
      let sum = 0;
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          if (isFormulaError(v)) return v;
          if (v === null || v === '') continue;
          const n = num(v);
          if (isFormulaError(n)) continue; // SUM ignores non-numeric text, like Excel
          sum += n;
        }
      }
      return sum;
    }
    case 'AVERAGE': {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          if (isFormulaError(v)) return v;
          if (v === null || v === '') continue;
          const n = num(v);
          if (isFormulaError(n)) continue;
          sum += n;
          count++;
        }
      }
      return count === 0 ? '#DIV/0!' : sum / count;
    }
    case 'MIN':
    case 'MAX': {
      const vals: number[] = [];
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          if (isFormulaError(v)) return v;
          if (v === null || v === '') continue;
          const n = num(v);
          if (isFormulaError(n)) continue;
          vals.push(n);
        }
      }
      if (vals.length === 0) return 0;
      return name === 'MIN' ? Math.min(...vals) : Math.max(...vals);
    }
    case 'COUNT': {
      let count = 0;
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          if (typeof v === 'number') count++;
        }
      }
      return count;
    }
    case 'COUNTA': {
      let count = 0;
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          if (v !== null) count++;
        }
      }
      return count;
    }
    case 'SUMIF': {
      if (argNodes.length < 2) return '#VALUE!';
      const range = flatten(evalGrid(0));
      const criteria = evalScalar(1);
      const sumRange = argNodes.length > 2 ? flatten(evalGrid(2)) : range;
      let sum = 0;
      for (let i = 0; i < range.length; i++) {
        if (matchesCriteria(range[i], criteria)) {
          const n = num(sumRange[i] ?? null);
          if (!isFormulaError(n)) sum += n;
        }
      }
      return sum;
    }
    case 'SUMIFS': {
      if (argNodes.length < 3 || (argNodes.length - 1) % 2 !== 0) return '#VALUE!';
      const sumRange = flatten(evalGrid(0));
      const pairs: { range: CellValue[]; criteria: CellValue }[] = [];
      for (let i = 1; i < argNodes.length; i += 2) {
        pairs.push({ range: flatten(evalGrid(i)), criteria: evalScalar(i + 1) });
      }
      let sum = 0;
      for (let i = 0; i < sumRange.length; i++) {
        const matchesAll = pairs.every((p) => matchesCriteria(p.range[i], p.criteria));
        if (matchesAll) {
          const n = num(sumRange[i] ?? null);
          if (!isFormulaError(n)) sum += n;
        }
      }
      return sum;
    }
    case 'ROUND':
    case 'ROUNDUP':
    case 'ROUNDDOWN': {
      const n = num(evalScalar(0));
      if (isFormulaError(n)) return n;
      const digitsRaw = argNodes.length > 1 ? num(evalScalar(1)) : 0;
      if (isFormulaError(digitsRaw)) return digitsRaw;
      const digits = Math.trunc(digitsRaw);
      const factor = Math.pow(10, digits);
      const scaled = n * factor;
      let rounded: number;
      if (name === 'ROUND') {
        rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
      } else if (name === 'ROUNDUP') {
        rounded = Math.sign(scaled) * Math.ceil(Math.abs(scaled) - 1e-9);
      } else {
        rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 1e-9);
      }
      return rounded / factor;
    }
    case 'ABS': {
      const n = num(evalScalar(0));
      return isFormulaError(n) ? n : Math.abs(n);
    }
    case 'IF': {
      if (argNodes.length < 2) return '#VALUE!';
      const cond = truthy(evalScalar(0));
      if (isFormulaError(cond)) return cond;
      if (cond) return toScalar(evalNode(argNodes[1], ctx));
      return argNodes.length > 2 ? toScalar(evalNode(argNodes[2], ctx)) : false;
    }
    case 'IFERROR': {
      if (argNodes.length < 2) return '#VALUE!';
      const v = evalScalar(0);
      return isFormulaError(v) ? toScalar(evalNode(argNodes[1], ctx)) : v;
    }
    case 'AND':
    case 'OR': {
      let result = name === 'AND';
      for (let i = 0; i < argNodes.length; i++) {
        for (const v of flatten(evalGrid(i))) {
          const t = truthy(v);
          if (isFormulaError(t)) return t;
          if (name === 'AND') result = result && t;
          else result = result || t;
        }
      }
      return result;
    }
    case 'NOT': {
      const t = truthy(evalScalar(0));
      return isFormulaError(t) ? t : !t;
    }
    case 'DATE': {
      if (argNodes.length < 3) return '#VALUE!';
      const y = num(evalScalar(0));
      const mo = num(evalScalar(1));
      const d = num(evalScalar(2));
      if (isFormulaError(y)) return y;
      if (isFormulaError(mo)) return mo;
      if (isFormulaError(d)) return d;
      return dateToSerial(new Date(Date.UTC(y, mo - 1, d)));
    }
    case 'YEAR':
    case 'MONTH':
    case 'DAY': {
      const s = num(evalScalar(0));
      if (isFormulaError(s)) return s;
      const dt = serialToDate(s);
      if (name === 'YEAR') return dt.getUTCFullYear();
      if (name === 'MONTH') return dt.getUTCMonth() + 1;
      return dt.getUTCDate();
    }
    case 'EOMONTH': {
      if (argNodes.length < 2) return '#VALUE!';
      const s = num(evalScalar(0));
      const months = num(evalScalar(1));
      if (isFormulaError(s)) return s;
      if (isFormulaError(months)) return months;
      const dt = serialToDate(s);
      const eom = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months + 1, 0));
      return dateToSerial(eom);
    }
    case 'VLOOKUP': {
      if (argNodes.length < 3) return '#VALUE!';
      const target = evalScalar(0);
      if (isFormulaError(target)) return target;
      const table = evalGrid(1);
      const colIdxRaw = num(evalScalar(2));
      if (isFormulaError(colIdxRaw)) return colIdxRaw;
      const colIdx = Math.trunc(colIdxRaw);
      if (colIdx < 1) return '#VALUE!';
      if (table.length === 0 || colIdx > table[0].length) return '#REF!';
      for (const row of table) {
        if (valuesEqual(row[0], target)) return row[colIdx - 1];
      }
      return '#N/A';
    }
    case 'INDEX': {
      if (argNodes.length < 2) return '#VALUE!';
      const grid = evalGrid(0);
      const rowsN = grid.length;
      const colsN = grid[0]?.length ?? 0;
      const idx1Raw = num(evalScalar(1));
      if (isFormulaError(idx1Raw)) return idx1Raw;
      const idx1 = Math.trunc(idx1Raw);
      if (argNodes.length > 2) {
        const idx2Raw = num(evalScalar(2));
        if (isFormulaError(idx2Raw)) return idx2Raw;
        const idx2 = Math.trunc(idx2Raw);
        if (idx1 < 1 || idx1 > rowsN || idx2 < 1 || idx2 > colsN) return '#REF!';
        return grid[idx1 - 1][idx2 - 1];
      }
      if (rowsN === 1) {
        if (idx1 < 1 || idx1 > colsN) return '#REF!';
        return grid[0][idx1 - 1];
      }
      if (colsN === 1) {
        if (idx1 < 1 || idx1 > rowsN) return '#REF!';
        return grid[idx1 - 1][0];
      }
      if (idx1 < 1 || idx1 > rowsN) return '#REF!';
      return [grid[idx1 - 1]]; // whole row; toScalar() will #VALUE! unless it's 1 cell
    }
    case 'MATCH': {
      if (argNodes.length < 2) return '#VALUE!';
      const target = evalScalar(0);
      if (isFormulaError(target)) return target;
      const arr = flatten(evalGrid(1));
      for (let i = 0; i < arr.length; i++) {
        if (valuesEqual(arr[i], target)) return i + 1;
      }
      return '#N/A';
    }
    default:
      return '#NAME?';
  }
}

function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (isFormulaError(a) || isFormulaError(b)) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return num(a) === num(b);
  return str(a).toLowerCase() === str(b).toLowerCase();
}
