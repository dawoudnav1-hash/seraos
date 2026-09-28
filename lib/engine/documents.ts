/**
 * Document handling: PDF text/table extraction (pdfjs), merge/split
 * (pdf-lib), and workpaper PDF rendering (pdf-lib). Deterministic; no model
 * calls. OCR is explicitly out of scope here — `OcrProvider` is the seam the
 * lead wires to a vision model later, per ARCHITECTURE.md's model routing.
 */

// ---------------------------------------------------------------------------
// Reading (pdfjs-dist)
// ---------------------------------------------------------------------------

export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  items: TextItem[];
}

export interface ReadPdfResult {
  pages: PdfPage[];
  /** True when no page carries a real text layer (a scanned/image-only
   *  PDF). Callers route these to `OcrProvider` instead of the extractors
   *  below. */
  needsOcr: boolean;
}

/** The seam for OCR. This module never implements it — the lead routes
 *  scanned pages to a vision model through this interface. */
export interface OcrProvider {
  ocr(pageImagesOrPdf: Uint8Array): Promise<{ pages: { text: string }[] }>;
}

export function isScanned(pages: PdfPage[]): boolean {
  const totalText = pages.reduce((sum, p) => sum + p.items.reduce((s, it) => s + it.text.trim().length, 0), 0);
  return totalText === 0;
}

/** Reads a PDF's text layer page by page. Never throws — a corrupt or
 *  unreadable buffer ("assume malformed data") comes back as
 *  `{pages: [], needsOcr: true}` so callers can fall back to OCR rather than
 *  crash the pipeline. */
export async function readPdf(buffer: Uint8Array | Buffer): Promise<ReadPdfResult> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages: PdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = content.items
        .filter((it): it is typeof it & { str: string; transform: number[]; width: number; height: number } => 'str' in it)
        .map((it) => ({
          text: it.str,
          x: it.transform[4],
          y: it.transform[5],
          width: it.width,
          height: it.height || Math.abs(it.transform[3]) || 10,
        }));
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, items });
    }
    return { pages, needsOcr: isScanned(pages) };
  } catch {
    return { pages: [], needsOcr: true };
  }
}

// ---------------------------------------------------------------------------
// Table extraction from a page's positioned text items
// ---------------------------------------------------------------------------

export interface ExtractedTable {
  rows: string[][];
  confidence: number;
}

const ROW_Y_TOLERANCE = 3;
const CELL_GAP_MULTIPLIER = 1.6; // gap larger than this * a typical char width => new column

/** Groups a page's text items into rows by y-position and columns by
 *  x-gaps, returning a best-effort table with a confidence score. Text
 *  items with no discernible tabular structure yield an empty array rather
 *  than a garbage table. */
export function extractTables(page: PdfPage): ExtractedTable[] {
  if (page.items.length === 0) return [];

  const sorted = [...page.items].sort((a, b) => (b.y === a.y ? a.x - b.x : b.y - a.y));
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= ROW_Y_TOLERANCE);
    if (row) row.push(item);
    else rows.push([item]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  if (rows.length < 2) return [];

  // Column anchors: cluster every item's start-x across all rows.
  const xs = rows.flatMap((r) => r.map((it) => it.x)).sort((a, b) => a - b);
  const avgCharWidth = average(rows.flatMap((r) => r.map((it) => it.width / Math.max(1, it.text.length))));
  const gapThreshold = Math.max(4, avgCharWidth * CELL_GAP_MULTIPLIER);
  const anchors: number[] = [];
  for (const x of xs) {
    if (anchors.length === 0 || x - anchors[anchors.length - 1] > gapThreshold) anchors.push(x);
  }
  if (anchors.length < 2) return [];

  const grid: string[][] = rows.map((row) => {
    const cells = new Array(anchors.length).fill('');
    for (const item of row) {
      let col = 0;
      for (let a = 0; a < anchors.length; a++) {
        if (item.x >= anchors[a] - gapThreshold / 2) col = a;
      }
      cells[col] = cells[col] ? `${cells[col]} ${item.text}` : item.text;
    }
    return cells.map((c) => c.trim());
  });

  const filledCounts = grid.map((r) => r.filter((c) => c !== '').length);
  const fullRows = filledCounts.filter((n) => n === anchors.length).length;
  const confidence = Math.max(0, Math.min(1, fullRows / grid.length));

  return [{ rows: grid, confidence }];
}

function average(nums: number[]): number {
  const filtered = nums.filter((n) => Number.isFinite(n) && n > 0);
  return filtered.length === 0 ? 6 : filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

// ---------------------------------------------------------------------------
// Merge / split (pdf-lib)
// ---------------------------------------------------------------------------

export async function mergePdfs(buffers: (Uint8Array | Buffer)[]): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Splits a PDF into several PDFs, one per `[startPage, endPage]` range
 *  (1-based, inclusive). Throws only on a genuinely invalid range — page
 *  selection is a caller-programming concern, not "data" to be dropped. */
export async function splitPdf(buffer: Uint8Array | Buffer, ranges: [number, number][]): Promise<Uint8Array[]> {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(buffer);
  const total = src.getPageCount();
  const out: Uint8Array[] = [];
  for (const [start, end] of ranges) {
    if (start < 1 || end > total || start > end) {
      throw new Error(`splitPdf: range [${start}, ${end}] is out of bounds for a ${total}-page document`);
    }
    const doc = await PDFDocument.create();
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((p) => doc.addPage(p));
    out.push(await doc.save());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workpaper PDF rendering (pdf-lib)
// ---------------------------------------------------------------------------

export interface WorkpaperTable {
  columns: string[];
  rows: (string | number)[][];
}

export interface WorkpaperSection {
  heading: string;
  paragraphs?: string[];
  table?: WorkpaperTable;
}

export interface WorkpaperSpec {
  title: string;
  meta?: Record<string, string>;
  sections: WorkpaperSection[];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const BOTTOM_MARGIN = 60;

function isNumericLike(v: string | number): boolean {
  if (typeof v === 'number') return true;
  return /^\(?-?\$?[\d,]+(\.\d+)?%?\)?$/.test(v.trim());
}

function wrapLine(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/** Renders a titled, multi-page PDF workpaper: a heading, optional meta
 *  line, and per-section paragraphs and/or a table with right-aligned
 *  numeric columns. Pages break automatically as content overflows, and a
 *  table's header row repeats at the top of a continuation page. */
export async function renderWorkpaperPdf(spec: WorkpaperSpec): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  const contentWidth = PAGE_WIDTH - MARGIN * 2;

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };
  const ensureRoom = (needed: number) => {
    if (y - needed < BOTTOM_MARGIN) newPage();
  };
  const drawText = (text: string, opts: { size: number; f?: typeof font; color?: [number, number, number]; x?: number }) => {
    page.drawText(text, {
      x: opts.x ?? MARGIN,
      y,
      size: opts.size,
      font: opts.f ?? font,
      color: rgb(...(opts.color ?? [0.15, 0.15, 0.15])),
    });
  };

  drawText(spec.title, { size: 18, f: bold, color: [0.05, 0.05, 0.05] });
  y -= 22;
  if (spec.meta) {
    const metaLine = Object.entries(spec.meta).map(([k, v]) => `${k}: ${v}`).join('   ·   ');
    if (metaLine) {
      drawText(metaLine, { size: 9.5, color: [0.4, 0.4, 0.4] });
      y -= 16;
    }
  }
  y -= 10;

  for (const section of spec.sections) {
    ensureRoom(30);
    drawText(section.heading, { size: 13, f: bold, color: [0.05, 0.05, 0.05] });
    y -= 18;

    for (const para of section.paragraphs ?? []) {
      for (const line of wrapLine(para, font, 10.5, contentWidth)) {
        ensureRoom(15);
        drawText(line, { size: 10.5 });
        y -= 15;
      }
      y -= 6;
    }

    if (section.table) {
      const { columns, rows } = section.table;
      const colWidth = contentWidth / Math.max(1, columns.length);
      const size = 9.5;

      const drawHeaderRow = () => {
        ensureRoom(18);
        columns.forEach((col, i) => {
          const x = MARGIN + i * colWidth;
          if (isNumericLike(col)) {
            const w = bold.widthOfTextAtSize(col, size);
            drawText(col, { size, f: bold, x: x + colWidth - w });
          } else {
            drawText(col, { size, f: bold, x });
          }
        });
        y -= 8;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + contentWidth, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
        y -= 12;
      };

      drawHeaderRow();
      for (const row of rows) {
        if (y - 14 < BOTTOM_MARGIN) {
          newPage();
          drawHeaderRow();
        }
        columns.forEach((_, i) => {
          const cell = row[i] ?? '';
          const text = String(cell);
          const x = MARGIN + i * colWidth;
          if (isNumericLike(cell)) {
            const w = font.widthOfTextAtSize(text, size);
            drawText(text, { size, x: x + colWidth - w });
          } else {
            drawText(text, { size, x });
          }
        });
        y -= 14;
      }
      y -= 10;
    }
  }

  return Buffer.from(await doc.save());
}
