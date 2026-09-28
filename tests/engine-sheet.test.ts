import { describe, expect, it } from 'vitest';
import {
  Workbook,
  detectTables,
  exportXlsx,
  importXlsx,
  inferColumns,
  repair,
  validate,
} from '@/lib/engine/sheet';
import { colLettersToIndex, dateToSerial, indexToColLetters, parseA1, parseCellRef, parseRangeRef } from '@/lib/engine/formula';

describe('formula.ts — address parsing', () => {
  it('converts column letters to indices and back', () => {
    expect(colLettersToIndex('A')).toBe(1);
    expect(colLettersToIndex('Z')).toBe(26);
    expect(colLettersToIndex('AA')).toBe(27);
    expect(indexToColLetters(1)).toBe('A');
    expect(indexToColLetters(27)).toBe('AA');
  });

  it('parses plain and absolute cell addresses', () => {
    expect(parseA1('B12')).toEqual({ col: 2, row: 12 });
    expect(parseCellRef('$A$1')).toMatchObject({ sheet: null, col: 1, row: 1, absCol: true, absRow: true });
  });

  it('parses sheet-qualified refs, bare and quoted', () => {
    expect(parseCellRef('Sheet1!A1')).toMatchObject({ sheet: 'Sheet1', col: 1, row: 1 });
    expect(parseCellRef("'My Sheet'!A1")).toMatchObject({ sheet: 'My Sheet', col: 1, row: 1 });
  });

  it('parses ranges with and without a sheet prefix', () => {
    expect(parseRangeRef('A1:B10')).toMatchObject({ sheet: null, start: { col: 1, row: 1 }, end: { col: 2, row: 10 } });
    expect(parseRangeRef('Sheet1!A1:B10')).toMatchObject({ sheet: 'Sheet1' });
  });
});

describe('formula.ts — precedence and operators (via Workbook)', () => {
  function calc(formula: string): unknown {
    const wb = new Workbook();
    wb.setFormula('S', 'Z1', formula);
    return wb.getCell('S', 'Z1');
  }

  it('multiplication binds tighter than addition', () => {
    expect(calc('=2+3*4')).toBe(14);
  });

  it('parentheses override precedence', () => {
    expect(calc('=(2+3)*4')).toBe(20);
  });

  it('unary minus binds tighter than exponent (-2^2 = 4, Excel-style)', () => {
    expect(calc('=-2^2')).toBe(4);
  });

  it('unary minus on a parenthesized expression', () => {
    expect(calc('=-(2+2)')).toBe(-4);
  });

  it('handles a chain of subtraction (trailing/negative literal path)', () => {
    expect(calc('=10-3-2')).toBe(5);
  });

  it('concatenates with &, coercing numbers and booleans, binding tighter than comparisons', () => {
    expect(calc('="Total: "&100')).toBe('Total: 100');
    expect(calc('=1&2')).toBe('12');
    // & binds tighter than =, so this is 1 = ("1"&""), i.e. 1 = "1" -> true.
    expect(calc('=1=1&""')).toBe(true);
  });

  it('evaluates comparison operators', () => {
    expect(calc('=1<2')).toBe(true);
    expect(calc('=2=2')).toBe(true);
    expect(calc('=2<>2')).toBe(false);
    expect(calc('=3>=3')).toBe(true);
    expect(calc('=1>=2')).toBe(false);
  });

  it('divides by zero as #DIV/0!', () => {
    expect(calc('=5/0')).toBe('#DIV/0!');
  });

  it('surfaces #NAME? for an unknown function', () => {
    expect(calc('=NOPE(1,2)')).toBe('#NAME?');
  });

  it('surfaces #VALUE! for non-numeric arithmetic', () => {
    expect(calc('="abc"+1')).toBe('#VALUE!');
  });
});

describe('formula.ts — cell and range references', () => {
  it('reads a plain and an absolute reference the same way', () => {
    const wb = new Workbook();
    wb.setCell('S', 'A1', 42);
    wb.setFormula('S', 'B1', '=A1*2');
    wb.setFormula('S', 'B2', '=$A$1*3');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(84);
    expect(wb.getCell('S', 'B2')).toBe(126);
  });

  it('resolves a cross-sheet reference', () => {
    const wb = new Workbook();
    wb.setCell('Data', 'A1', 500);
    wb.setFormula('Summary', 'D6', '=Data!A1+1');
    wb.recalc();
    expect(wb.getCell('Summary', 'D6')).toBe(501);
  });

  it('resolves a quoted cross-sheet reference with a space in the name', () => {
    const wb = new Workbook();
    wb.setCell('My Sheet', 'A1', 7);
    wb.setFormula('S', 'B1', "='My Sheet'!A1*10");
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(70);
  });

  it('#REF!s when the referenced sheet does not exist', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=Ghost!A1+1');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe('#REF!');
  });

  it('propagates #REF! through downstream formulas', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=Ghost!A1');
    wb.setFormula('S', 'B1', '=A1+1');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe('#REF!');
  });

  it('sums a range', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [[1], [2], [3], [4], [5]]);
    wb.setFormula('S', 'B1', '=SUM(A1:A5)');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(15);
  });
});

describe('formula.ts — aggregate and math functions', () => {
  function withData(rows: (number | string)[][]): Workbook {
    const wb = new Workbook();
    wb.setRange('S', 'A1', rows);
    return wb;
  }

  it('SUM ignores blanks and non-numeric text', () => {
    const wb = withData([[1], ['x'], [3], [null as unknown as number]]);
    wb.setFormula('S', 'B1', '=SUM(A1:A4,10)');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(14);
  });

  it('SUMIF sums by exact match', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [
      ['East', 100],
      ['West', 200],
      ['East', 50],
    ]);
    wb.setFormula('S', 'C1', '=SUMIF(A1:A3,"East",B1:B3)');
    wb.recalc();
    expect(wb.getCell('S', 'C1')).toBe(150);
  });

  it('SUMIF sums by a comparison-operator criteria', () => {
    const wb = withData([[50], [150], [300]]);
    wb.setFormula('S', 'B1', '=SUMIF(A1:A3,">100")');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(450);
  });

  it('SUMIFS applies every criteria pair', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [
      ['East', 'Q1', 100],
      ['East', 'Q2', 200],
      ['West', 'Q1', 300],
    ]);
    wb.setFormula('S', 'D1', '=SUMIFS(C1:C3,A1:A3,"East",B1:B3,"Q1")');
    wb.recalc();
    expect(wb.getCell('S', 'D1')).toBe(100);
  });

  it('AVERAGE, MIN and MAX', () => {
    const wb = withData([[10], [20], [30]]);
    wb.setFormula('S', 'B1', '=AVERAGE(A1:A3)');
    wb.setFormula('S', 'B2', '=MIN(A1:A3)');
    wb.setFormula('S', 'B3', '=MAX(A1:A3)');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(20);
    expect(wb.getCell('S', 'B2')).toBe(10);
    expect(wb.getCell('S', 'B3')).toBe(30);
  });

  it('AVERAGE of an empty range is #DIV/0!', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'B1', '=AVERAGE(A1:A3)');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe('#DIV/0!');
  });

  it('COUNT counts numbers only; COUNTA counts anything non-blank', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [[1], ['text'], [3]]);
    wb.setFormula('S', 'B1', '=COUNT(A1:A3)');
    wb.setFormula('S', 'B2', '=COUNTA(A1:A3)');
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(2);
    expect(wb.getCell('S', 'B2')).toBe(3);
  });

  it('ROUND, ROUNDUP and ROUNDDOWN, including negative numbers', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=ROUND(2.345,2)');
    wb.setFormula('S', 'A2', '=ROUNDUP(-1.1,0)');
    wb.setFormula('S', 'A3', '=ROUNDDOWN(-1.9,0)');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBeCloseTo(2.35, 5);
    expect(wb.getCell('S', 'A2')).toBe(-2);
    expect(wb.getCell('S', 'A3')).toBe(-1);
  });

  it('ABS', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=ABS(-42)');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe(42);
  });
});

describe('formula.ts — logic functions', () => {
  it('IF branches and defaults to FALSE with no else', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=IF(1>0,"yes","no")');
    wb.setFormula('S', 'A2', '=IF(1<0,"yes")');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe('yes');
    expect(wb.getCell('S', 'A2')).toBe(false);
  });

  it('IFERROR catches an error and passes through a normal value', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=IFERROR(5/0,"fallback")');
    wb.setFormula('S', 'A2', '=IFERROR(5/1,"fallback")');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe('fallback');
    expect(wb.getCell('S', 'A2')).toBe(5);
  });

  it('AND, OR and NOT', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=AND(1>0,2>1)');
    wb.setFormula('S', 'A2', '=OR(1<0,2>1)');
    wb.setFormula('S', 'A3', '=NOT(1>0)');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe(true);
    expect(wb.getCell('S', 'A2')).toBe(true);
    expect(wb.getCell('S', 'A3')).toBe(false);
  });
});

describe('formula.ts — date functions', () => {
  it('DATE/YEAR/MONTH/DAY round-trip', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=DATE(2026,4,3)');
    wb.setFormula('S', 'A2', '=YEAR(A1)');
    wb.setFormula('S', 'A3', '=MONTH(A1)');
    wb.setFormula('S', 'A4', '=DAY(A1)');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe(dateToSerial(new Date(Date.UTC(2026, 3, 3))));
    expect(wb.getCell('S', 'A2')).toBe(2026);
    expect(wb.getCell('S', 'A3')).toBe(4);
    expect(wb.getCell('S', 'A4')).toBe(3);
  });

  it('EOMONTH finds the last day of a month N months away', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=DATE(2026,4,3)');
    wb.setFormula('S', 'A2', '=EOMONTH(A1,0)');
    wb.setFormula('S', 'A3', '=EOMONTH(A1,1)');
    wb.setFormula('S', 'A4', '=DAY(A2)&"/"&MONTH(A2)');
    wb.setFormula('S', 'A5', '=MONTH(A3)');
    wb.recalc();
    expect(wb.getCell('S', 'A4')).toBe('30/4');
    expect(wb.getCell('S', 'A5')).toBe(5);
  });
});

describe('formula.ts — lookup functions', () => {
  function lookupTable(): Workbook {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [
      ['A100', 'Cash', 1000],
      ['A200', 'AR', 2000],
      ['A300', 'AP', 3000],
    ]);
    return wb;
  }

  it('VLOOKUP finds an exact match and returns the right column', () => {
    const wb = lookupTable();
    wb.setFormula('S', 'E1', '=VLOOKUP("A200",A1:C3,3)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe(2000);
  });

  it('VLOOKUP returns #N/A when nothing matches', () => {
    const wb = lookupTable();
    wb.setFormula('S', 'E1', '=VLOOKUP("A999",A1:C3,3)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe('#N/A');
  });

  it('VLOOKUP returns #REF! when the column index is out of range', () => {
    const wb = lookupTable();
    wb.setFormula('S', 'E1', '=VLOOKUP("A200",A1:C3,5)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe('#REF!');
  });

  it('INDEX returns a cell from a 2-D range', () => {
    const wb = lookupTable();
    wb.setFormula('S', 'E1', '=INDEX(A1:C3,2,2)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe('AR');
  });

  it('INDEX treats a single row/column range as 1-D', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [[10, 20, 30]]);
    wb.setFormula('S', 'E1', '=INDEX(A1:C1,2)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe(20);
  });

  it('MATCH returns the 1-based position of an exact match', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [['x'], ['y'], ['z']]);
    wb.setFormula('S', 'E1', '=MATCH("y",A1:A3)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe(2);
  });

  it('MATCH returns #N/A when nothing matches', () => {
    const wb = new Workbook();
    wb.setRange('S', 'A1', [['x'], ['y']]);
    wb.setFormula('S', 'E1', '=MATCH("q",A1:A2)');
    wb.recalc();
    expect(wb.getCell('S', 'E1')).toBe('#N/A');
  });
});

describe('Workbook — cell storage API', () => {
  it('setCell / getCell round-trip and addSheet is idempotent', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    wb.addSheet('S');
    wb.setCell('S', 'A1', 'hello');
    expect(wb.getCell('S', 'A1')).toBe('hello');
    expect(wb.order).toEqual(['S']);
  });

  it('appendRow writes sequential rows and returns the row index', () => {
    const wb = new Workbook();
    const r1 = wb.appendRow('S', ['a', 1]);
    const r2 = wb.appendRow('S', ['b', 2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(wb.getCell('S', 'A2')).toBe('b');
    expect(wb.getCell('S', 'B2')).toBe(2);
  });

  it('setRange writes a rectangular block', () => {
    const wb = new Workbook();
    wb.setRange('S', 'B2', [
      [1, 2],
      [3, 4],
    ]);
    expect(wb.getCell('S', 'B2')).toBe(1);
    expect(wb.getCell('S', 'C3')).toBe(4);
  });

  it('toMatrix returns a full rectangular snapshot with blanks as null', () => {
    const wb = new Workbook();
    wb.setCell('S', 'A1', 1);
    wb.setCell('S', 'C2', 2);
    const matrix = wb.toMatrix('S');
    expect(matrix).toEqual([
      [1, null, null],
      [null, null, 2],
    ]);
  });
});

describe('Workbook — recalc order and cycle detection', () => {
  it('recalculates through a multi-hop dependency chain regardless of write order', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'C1', '=B1*2');
    wb.setFormula('S', 'B1', '=A1+1');
    wb.setCell('S', 'A1', 10);
    wb.recalc();
    expect(wb.getCell('S', 'B1')).toBe(11);
    expect(wb.getCell('S', 'C1')).toBe(22);
  });

  it('marks a two-cell cycle as #CIRC', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=B1+1');
    wb.setFormula('S', 'B1', '=A1+1');
    wb.recalc();
    expect(wb.getCell('S', 'A1')).toBe('#CIRC');
    expect(wb.getCell('S', 'B1')).toBe('#CIRC');
  });

  it('marks a cell that merely depends on a cycle as #CIRC too', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=B1+1');
    wb.setFormula('S', 'B1', '=A1+1');
    wb.setFormula('S', 'C1', '=A1+100');
    wb.recalc();
    expect(wb.getCell('S', 'C1')).toBe('#CIRC');
  });

  it('does not confuse a self-independent cell for part of a cycle elsewhere', () => {
    const wb = new Workbook();
    wb.setFormula('S', 'A1', '=B1+1');
    wb.setFormula('S', 'B1', '=A1+1');
    wb.setCell('S', 'D1', 5);
    wb.setFormula('S', 'D2', '=D1*2');
    wb.recalc();
    expect(wb.getCell('S', 'D2')).toBe(10);
  });
});

describe('Workbook — detectTables / inferColumns', () => {
  function ledgerSheet(): Workbook {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Description', 'Vendor', 'Amount'],
      ['2026-01-01', 'Rent', 'Acme Property', 1000],
      ['2026-01-05', 'Utilities', 'City Power', 200],
      ['Total', '', '', 1200],
    ]);
    wb.recalc();
    return wb;
  }

  it('finds the header row, data rows and a trailing total row', () => {
    const wb = ledgerSheet();
    const tables = detectTables(wb.sheet('Sheet1'));
    expect(tables).toHaveLength(1);
    expect(tables[0].headerRow).toBe(1);
    expect(tables[0].lastDataRow).toBe(3);
    expect(tables[0].totalRow).toBe(4);
    expect(tables[0].headers).toEqual(['Date', 'Description', 'Vendor', 'Amount']);
  });

  it('skips blank rows and detects more than one table on a sheet', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Amount'],
      ['2026-01-01', 100],
      [null as unknown as string, null as unknown as number],
      ['Ref', 'Qty'],
      ['R1', 5],
    ]);
    const tables = detectTables(wb.sheet('Sheet1'));
    expect(tables.map((t) => t.headers)).toEqual([['Date', 'Amount'], ['Ref', 'Qty']]);
  });

  it('infers column roles from header keywords', () => {
    const wb = ledgerSheet();
    const cols = inferColumns(detectTables(wb.sheet('Sheet1'))[0]);
    expect(cols).toMatchObject({ date: 1, description: 2, counterparty: 3, amount: 4 });
  });

  it('falls back to value-pattern inference when headers are unlabeled', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Col A', 'Col B'],
      ['2026-01-01', 100.5],
      ['2026-01-02', 200.25],
    ]);
    const cols = inferColumns(detectTables(wb.sheet('Sheet1'))[0]);
    expect(cols.date).toBe(1);
    expect(cols.amount).toBe(2);
  });
});

describe('Workbook — validate', () => {
  function bookWithHardcodedTotal(): Workbook {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Amount'],
      ['2026-01-01', 1000],
      ['2026-01-02', 200],
      ['Total', 1300], // wrong: should be 1200 and should be a formula
    ]);
    return wb;
  }

  it('flags a hardcoded number in a row labeled "total"', () => {
    const issues = validate(bookWithHardcodedTotal());
    const hardcoded = issues.find((i) => i.type === 'hardcoded_total');
    expect(hardcoded).toBeDefined();
    expect(hardcoded?.cell).toBe('B4');
    expect(hardcoded?.meta).toEqual({ sumStartRow: 2, sumEndRow: 3, col: 2 });
  });

  it('flags error values and broken references with their location', () => {
    const wb = new Workbook();
    wb.setFormula('Sheet1', 'A1', '=Ghost!A1');
    wb.setFormula('Sheet1', 'A2', '=5/0');
    const issues = validate(wb);
    expect(issues).toContainEqual(expect.objectContaining({ type: 'broken_ref', sheet: 'Sheet1', cell: 'A1' }));
    expect(issues).toContainEqual(expect.objectContaining({ type: 'error_value', sheet: 'Sheet1', cell: 'A2' }));
  });

  it('flags a circular reference distinctly from other error values', () => {
    const wb = new Workbook();
    wb.setFormula('Sheet1', 'A1', '=B1+1');
    wb.setFormula('Sheet1', 'B1', '=A1+1');
    const issues = validate(wb);
    expect(issues.filter((i) => i.type === 'circular_ref')).toHaveLength(2);
  });

  it('an "equal" assertion mismatch is reported with both values', () => {
    const wb = new Workbook();
    wb.setCell('Journal_Entries', 'D20', 500);
    wb.setCell('Summary', 'D6', 400);
    const issues = validate(wb, [{ equal: ['Summary!D6', 'Journal_Entries!D20'] }]);
    expect(issues).toContainEqual(expect.objectContaining({ type: 'assertion_mismatch', cell: 'D6' }));
  });

  it('an "equal" assertion passes when both sides match', () => {
    const wb = new Workbook();
    wb.setCell('Journal_Entries', 'D20', 500);
    wb.setCell('Summary', 'D6', 500);
    const issues = validate(wb, [{ equal: ['Summary!D6', 'Journal_Entries!D20'] }]);
    expect(issues.filter((i) => i.type === 'assertion_mismatch')).toHaveLength(0);
  });

  it('a "sumOf" assertion mismatch is reported', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'B2', [[1], [2], [3]]);
    wb.setCell('Sheet1', 'B11', 999);
    const issues = validate(wb, [{ sumOf: 'B2:B10', equals: 'B11' }]);
    expect(issues).toContainEqual(expect.objectContaining({ type: 'assertion_mismatch', cell: 'B11' }));
  });

  it('a "sumOf" assertion passes when the total reconciles', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'B2', [[1], [2], [3]]);
    wb.setFormula('Sheet1', 'B11', '=SUM(B2:B10)');
    const issues = validate(wb, [{ sumOf: 'B2:B10', equals: 'B11' }]);
    expect(issues.filter((i) => i.type === 'assertion_mismatch')).toHaveLength(0);
  });
});

describe('Workbook — repair', () => {
  it('replaces a hardcoded total with a SUM formula and recalculates it correctly', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Amount'],
      ['2026-01-01', 1000],
      ['2026-01-02', 200],
      ['Total', 1300],
    ]);
    const issues = validate(wb);
    const { changes } = repair(wb, issues);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ sheet: 'Sheet1', cell: 'B4', before: 1300, after: '=SUM(B2:B3)' });
    expect(wb.getCell('Sheet1', 'B4')).toBe(1200);
    expect(wb.getCellData('Sheet1', 'B4')?.formula).toBe('=SUM(B2:B3)');
  });

  it('a repaired workbook no longer trips the same hardcoded_total validation', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Amount'],
      ['2026-01-01', 1000],
      ['2026-01-02', 200],
      ['Total', 1300],
    ]);
    repair(wb, validate(wb));
    const after = validate(wb);
    expect(after.filter((i) => i.type === 'hardcoded_total')).toHaveLength(0);
  });

  it('leaves issues it cannot mechanically fix out of changes', () => {
    const wb = new Workbook();
    wb.setFormula('Sheet1', 'A1', '=Ghost!A1');
    const { changes } = repair(wb, validate(wb));
    expect(changes).toHaveLength(0);
  });
});

describe('Workbook — xlsx import/export round-trip', () => {
  it('keeps both formulas and cached results through export then import', async () => {
    const wb = new Workbook();
    wb.setCell('Sheet1', 'A1', 10);
    wb.setCell('Sheet1', 'A2', 20);
    wb.setFormula('Sheet1', 'A3', '=SUM(A1:A2)');
    wb.setCell('Sheet1', 'B1', 'a label');

    const buf = await exportXlsx(wb);
    const roundtripped = await importXlsx(buf);

    expect(roundtripped.getCell('Sheet1', 'A1')).toBe(10);
    expect(roundtripped.getCell('Sheet1', 'B1')).toBe('a label');
    const a3 = roundtripped.getCellData('Sheet1', 'A3');
    expect(a3?.formula).toBe('=SUM(A1:A2)');
    expect(a3?.value).toBe(30); // the cached result, present without calling recalc()

    roundtripped.recalc();
    expect(roundtripped.getCell('Sheet1', 'A3')).toBe(30);
  });

  it('round-trips an error-valued formula cell', async () => {
    const wb = new Workbook();
    wb.setFormula('Sheet1', 'A1', '=5/0');
    wb.recalc();
    const buf = await exportXlsx(wb);
    const roundtripped = await importXlsx(buf);
    expect(roundtripped.getCell('Sheet1', 'A1')).toBe('#DIV/0!');
  });

  it('imports a workbook built directly with exceljs, formulas and values intact', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wbx = new ExcelJS.Workbook();
    const ws = wbx.addWorksheet('Data');
    ws.getCell('A1').value = 5;
    ws.getCell('A2').value = 7;
    ws.getCell('A3').value = { formula: 'A1+A2', result: 12 };
    const buf = Buffer.from(await wbx.xlsx.writeBuffer());

    const wb = await importXlsx(buf);
    expect(wb.getCell('Data', 'A1')).toBe(5);
    expect(wb.getCellData('Data', 'A3')?.formula).toBe('=A1+A2');
    wb.recalc();
    expect(wb.getCell('Data', 'A3')).toBe(12);
  });
});
