import { describe, expect, it } from 'vitest';
import {
  detectHeaders,
  dropNonDataRows,
  parseCsv,
  parseFlexibleAmount,
  parseFlexibleDate,
  profile,
  toTxns,
  workbookToRows,
} from '@/lib/engine/capture';
import { Workbook } from '@/lib/engine/sheet';
import {
  extractTables,
  isScanned,
  mergePdfs,
  readPdf,
  renderWorkpaperPdf,
  splitPdf,
} from '@/lib/engine/documents';

describe('capture.ts — CSV parsing (RFC 4180)', () => {
  it('parses a quoted field containing the delimiter', () => {
    const { rows } = parseCsv('a,"b,c",d\n1,2,3\n');
    expect(rows[0]).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const { rows } = parseCsv('name,note\nAcme,"Says ""hi"""\n');
    expect(rows[1]).toEqual(['Acme', 'Says "hi"']);
  });

  it('keeps a newline that appears inside a quoted field as one field', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2",2\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['line1\nline2', '2']);
  });

  it('strips a leading BOM', () => {
    const { rows } = parseCsv('﻿a,b\n1,2\n');
    expect(rows[0]).toEqual(['a', 'b']);
  });

  it('detects a comma delimiter', () => {
    expect(parseCsv('a,b,c\n1,2,3\n').delimiter).toBe(',');
  });

  it('detects a tab delimiter', () => {
    expect(parseCsv('a\tb\tc\n1\t2\t3\n').delimiter).toBe('\t');
  });

  it('detects a semicolon delimiter', () => {
    expect(parseCsv('a;b;c\n1;2;3\n').delimiter).toBe(';');
  });

  it('detects a pipe delimiter', () => {
    expect(parseCsv('a|b|c\n1|2|3\n').delimiter).toBe('|');
  });

  it('handles \\r\\n line endings', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('capture.ts — header detection', () => {
  it('detects a single header row', () => {
    const detection = detectHeaders([
      ['Date', 'Amount'],
      ['2026-01-01', 100],
    ]);
    expect(detection.headers).toEqual(['Date', 'Amount']);
    expect(detection.dataStartIndex).toBe(1);
  });

  it('merges a grouping row with the leaf header row', () => {
    const detection = detectHeaders([
      ['Revenue', '', 'Expense', ''],
      ['Amount', 'Account', 'Amount', 'Account'],
      [100, '4000', 50, '6000'],
    ]);
    expect(detection.headers).toEqual(['Revenue Amount', 'Revenue Account', 'Expense Amount', 'Expense Account']);
    expect(detection.dataStartIndex).toBe(2);
  });

  it('excludes an embedded "Total" / "Grand Total" ERP export row, logging why', () => {
    const rows = [
      ['2026-01-01', 'East', 100],
      ['2026-01-02', 'West', 200],
      ['Subtotal', '', 300],
      ['2026-01-03', 'East', 50],
      ['Grand Total', '', 350],
    ];
    const { kept, dropped } = dropNonDataRows(rows);
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(2);
    expect(dropped[0].reason).toMatch(/subtotal/i);
    expect(dropped[1].reason).toMatch(/grand total/i);
  });

  it('drops a blank row with a reason', () => {
    const { dropped } = dropNonDataRows([['a', 1], [null, null], ['b', 2]]);
    expect(dropped).toEqual([{ rowIndex: 1, reason: 'blank row' }]);
  });
});

describe('capture.ts — date normalization', () => {
  it('parses an ISO date', () => {
    expect(parseFlexibleDate('2026-04-03')).toEqual({ iso: '2026-04-03', ambiguous: false });
  });

  it('parses an unambiguous MM/DD/YYYY date (day > 12)', () => {
    const r = parseFlexibleDate('04/25/2026');
    expect(r).toEqual({ iso: '2026-04-25', ambiguous: false });
  });

  it('parses an unambiguous DD/MM/YYYY date (first number > 12)', () => {
    const r = parseFlexibleDate('25/04/2026');
    expect(r).toEqual({ iso: '2026-04-25', ambiguous: false });
  });

  it('flags a date as ambiguous when both MM/DD and DD/MM are plausible', () => {
    const r = parseFlexibleDate('03/04/2026');
    expect(r.ambiguous).toBe(true);
    expect(r.iso).toBe('2026-03-04'); // defaults to MM/DD/YYYY
  });

  it('parses an Excel serial date number', () => {
    // 46115 is 2026-04-03 under the standard (post-1900) Excel epoch.
    expect(parseFlexibleDate(46115)).toEqual({ iso: '2026-04-03', ambiguous: false });
  });

  it('parses a named-month date like "Apr 3, 2026"', () => {
    expect(parseFlexibleDate('Apr 3, 2026')).toEqual({ iso: '2026-04-03', ambiguous: false });
    expect(parseFlexibleDate('April 3, 2026')).toEqual({ iso: '2026-04-03', ambiguous: false });
  });

  it('returns null (not a throw) with a reason for unparseable text', () => {
    const r = parseFlexibleDate('not a date');
    expect(r.iso).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it('rejects an impossible calendar date', () => {
    expect(parseFlexibleDate('2026-02-30').iso).toBeNull();
  });
});

describe('capture.ts — amount normalization', () => {
  it('parses a dollar amount with thousands separators', () => {
    expect(parseFlexibleAmount('$1,299.99')).toEqual({ cents: 129999, currencySymbol: '$' });
  });

  it('parses accounting-negative parentheses', () => {
    expect(parseFlexibleAmount('(1,173.30)').cents).toBe(-117330);
  });

  it('parses a trailing minus sign', () => {
    expect(parseFlexibleAmount('1234.56-').cents).toBe(-123456);
  });

  it('parses a leading minus sign', () => {
    expect(parseFlexibleAmount('-1234.56').cents).toBe(-123456);
  });

  it('parses a plain numeric cell', () => {
    expect(parseFlexibleAmount(42.5).cents).toBe(4250);
  });

  it('detects a non-dollar currency symbol', () => {
    expect(parseFlexibleAmount('€500.00').currencySymbol).toBe('€');
  });

  it('returns null with a reason for unparseable text', () => {
    const r = parseFlexibleAmount('not a number');
    expect(r.cents).toBeNull();
    expect(r.reason).toBeTruthy();
  });
});

describe('capture.ts — toTxns', () => {
  it('combines separate Debit/Credit columns into a signed amount', () => {
    const rows = [
      ['2026-01-01', 'Rent', 100, 0],
      ['2026-01-02', 'Refund', 0, 50],
    ];
    const { txns } = toTxns(rows, { date: 0, description: 1, debit: 2, credit: 3 }, { system: 'bank', file: 'stmt.csv' });
    expect(txns).toHaveLength(2);
    expect(txns[0].amountCents).toBe(10000);
    expect(txns[1].amountCents).toBe(-5000);
  });

  it('builds a SourceRef id as "<file>#row<n>"', () => {
    const rows = [['2026-01-01', 100]];
    const { txns } = toTxns(rows, { date: 0, amount: 1 }, { system: 'bank', file: 'stmt.csv' });
    expect(txns[0].id).toBe('stmt.csv#row1');
    expect(txns[0].source).toEqual({ system: 'bank', id: 'stmt.csv#row1', label: undefined });
  });

  it('drops a row with an invalid date, logging the reason, without dropping the rest', () => {
    const rows = [
      ['2026-01-01', 100],
      ['not-a-date', 200],
      ['2026-01-03', 300],
    ];
    const { txns, dropped } = toTxns(rows, { date: 0, amount: 1 }, { system: 'bank', file: 'stmt.csv' });
    expect(txns).toHaveLength(2);
    expect(dropped).toEqual([{ rowIndex: 1, reason: expect.stringContaining('invalid date') }]);
  });

  it('drops a row with an invalid amount, logging the reason', () => {
    const rows = [['2026-01-01', 'garbage']];
    const { txns, dropped } = toTxns(rows, { date: 0, amount: 1 }, { system: 'bank', file: 'stmt.csv' });
    expect(txns).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/amount/);
  });

  it('flags an ambiguous date but still produces the txn', () => {
    const rows = [['03/04/2026', 100]];
    const { txns, ambiguousDates } = toTxns(rows, { date: 0, amount: 1 }, { system: 'bank', file: 'stmt.csv' });
    expect(txns).toHaveLength(1);
    expect(ambiguousDates).toEqual([{ rowIndex: 0, iso: '2026-03-04' }]);
  });

  it('carries account, reference and counterparty through when mapped', () => {
    const rows = [['2026-01-01', 100, '6410', 'INV-1', 'Acme Corp']];
    const { txns } = toTxns(
      rows,
      { date: 0, amount: 1, account: 2, reference: 3, counterparty: 4 },
      { system: 'gl', file: 'gl.csv' },
    );
    expect(txns[0]).toMatchObject({ account: '6410', reference: 'INV-1', counterparty: 'Acme Corp' });
  });
});

describe('capture.ts — profile (data-quality report)', () => {
  it('scores clean data near 100 and dirty data lower', () => {
    const clean = profile([
      ['2026-01-01', 100],
      ['2026-01-02', 200],
    ]);
    const dirty = profile([
      ['2026-01-01', 100],
      [null, null],
      ['2026-01-01', 100], // duplicate
      ['bad-date', 'not-a-number'],
    ]);
    expect(clean.score).toBeGreaterThan(dirty.score);
    expect(clean.score).toBeGreaterThan(90);
  });

  it('reports duplicate row count', () => {
    const p = profile([
      ['a', 1],
      ['a', 1],
      ['b', 2],
    ]);
    expect(p.duplicateRowCount).toBe(1);
  });

  it('reports row counts before and after, and dropped rows with reasons', () => {
    const p = profile([
      ['2026-01-01', 100],
      ['Total', 100],
      [null, null],
    ]);
    expect(p.rowCountBefore).toBe(3);
    expect(p.rowCountAfter).toBe(1);
    expect(p.droppedRows).toHaveLength(2);
    expect(p.droppedRows.every((d) => d.reason)).toBe(true);
  });

  it('reports per-column null percentage', () => {
    const p = profile([
      ['x', 1],
      ['y', null],
      ['z', null],
    ]);
    const col1 = p.columns[1];
    expect(col1.nullPercent).toBeCloseTo((2 / 3) * 100, 5);
  });
});

describe('capture.ts — xlsx sheet through the sandbox', () => {
  it('workbookToRows materializes every sheet as a plain row matrix', () => {
    const wb = new Workbook();
    wb.setRange('Sheet1', 'A1', [
      ['Date', 'Amount'],
      ['2026-01-01', 100],
    ]);
    wb.setFormula('Sheet1', 'C2', '=B2*2');
    wb.recalc();
    const result = workbookToRows(wb);
    expect(result).toHaveLength(1);
    expect(result[0].sheetName).toBe('Sheet1');
    expect(result[0].rows).toEqual([
      ['Date', 'Amount', null],
      ['2026-01-01', 100, 200],
    ]);
  });
});

describe('documents.ts — readPdf', () => {
  async function buildTextPdf(): Promise<Buffer> {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Bank Reconciliation', { x: 40, y: 260, size: 14, font });
    page.drawText('April 2026', { x: 40, y: 240, size: 10, font });
    return Buffer.from(await doc.save());
  }

  it('extracts the text layer from a generated PDF', async () => {
    const buf = await buildTextPdf();
    const result = await readPdf(buf);
    expect(result.pages).toHaveLength(1);
    expect(result.needsOcr).toBe(false);
    const text = result.pages[0].items.map((i) => i.text).join(' ');
    expect(text).toContain('Bank Reconciliation');
  });

  it('flags needsOcr for a page with no text layer', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const buf = Buffer.from(await doc.save());
    const result = await readPdf(buf);
    expect(result.needsOcr).toBe(true);
    expect(isScanned(result.pages)).toBe(true);
  });

  it('degrades gracefully (never throws) on a malformed buffer', async () => {
    const result = await readPdf(Buffer.from('not a real pdf'));
    expect(result.needsOcr).toBe(true);
    expect(result.pages).toEqual([]);
  });
});

describe('documents.ts — extractTables', () => {
  it('groups positioned text into rows and columns with a confidence score', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    const rows = [
      ['Account', 'Balance'],
      ['Cash', '100.00'],
      ['AR', '50.00'],
    ];
    let y = 170;
    for (const row of rows) {
      page.drawText(row[0], { x: 40, y, size: 10, font });
      page.drawText(row[1], { x: 180, y, size: 10, font });
      y -= 20;
    }
    const buf = Buffer.from(await doc.save());
    const { pages } = await readPdf(buf);
    const tables = extractTables(pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([
      ['Account', 'Balance'],
      ['Cash', '100.00'],
      ['AR', '50.00'],
    ]);
    expect(tables[0].confidence).toBeGreaterThan(0.9);
  });

  it('returns no tables for a page with no tabular structure', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText('Just one line of prose.', { x: 40, y: 170, size: 10, font });
    const buf = Buffer.from(await doc.save());
    const { pages } = await readPdf(buf);
    expect(extractTables(pages[0])).toEqual([]);
  });
});

describe('documents.ts — merge / split', () => {
  it('round-trips page counts through merge then split', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const docA = await PDFDocument.create();
    docA.addPage([100, 100]);
    docA.addPage([100, 100]);
    const docB = await PDFDocument.create();
    docB.addPage([100, 100]);

    const merged = await mergePdfs([await docA.save(), await docB.save()]);
    const mergedDoc = await PDFDocument.load(merged);
    expect(mergedDoc.getPageCount()).toBe(3);

    const [partA, partB] = await splitPdf(merged, [
      [1, 2],
      [3, 3],
    ]);
    expect((await PDFDocument.load(partA)).getPageCount()).toBe(2);
    expect((await PDFDocument.load(partB)).getPageCount()).toBe(1);
  });

  it('throws a clear error for an out-of-bounds split range', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const buf = await doc.save();
    await expect(splitPdf(buf, [[1, 5]])).rejects.toThrow();
  });
});

describe('documents.ts — renderWorkpaperPdf', () => {
  it('renders a multi-page PDF with a right-aligned numeric table', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`Line item ${i + 1}`, (i + 1) * 10.5]);
    const buf = await renderWorkpaperPdf({
      title: 'Bank Reconciliation',
      meta: { Period: 'April 2026', Prepared: 'Vert' },
      sections: [
        { heading: 'Summary', paragraphs: ['This workpaper reconciles the bank statement to the general ledger for April 2026.'] },
        { heading: 'Detail', table: { columns: ['Item', 'Amount'], rows } },
      ],
    });
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('renders a single-page PDF for a short workpaper', async () => {
    const buf = await renderWorkpaperPdf({
      title: 'Short Memo',
      sections: [{ heading: 'Note', paragraphs: ['Just one short paragraph.'] }],
    });
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
  });
});
