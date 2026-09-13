import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MockERP, usd } from './mock-erp';
import { ApprovalRequiredError, provenance, type Tool, type ToolContext, type ToolResult } from './types';

const ARTIFACT_DIR = path.join(process.cwd(), 'public', 'artifacts');

let callSeq = 0;
export function nextToolCallId(): string {
  return `tc_${Date.now().toString(36)}_${++callSeq}`;
}

export const fetchTrialBalance: Tool<{ period?: string }, typeof MockERP.trialBalance> = {
  name: 'fetchTrialBalance',
  mutating: false,
  async run(_args, ctx) {
    const tb = MockERP.trialBalance;
    const id = nextToolCallId();
    return {
      ok: true,
      summary: `Trial balance pulled for ${tb.period}: debits ${usd(tb.totals.debits * 100)} tie to credits.`,
      data: tb,
      provenance: [
        provenance(ctx, 'fetchTrialBalance', id, 'Total debits', usd(tb.totals.debits * 100), `${tb.accounts.length} accounts`),
        provenance(ctx, 'fetchTrialBalance', id, 'Total credits', usd(tb.totals.credits * 100), 'Balance sheet foots'),
      ],
    };
  },
};

export const fetchSubledger: Tool<{ name: string }, unknown> = {
  name: 'fetchSubledger',
  mutating: false,
  async run(args, ctx) {
    const data = MockERP.subledgers[args.name];
    const id = nextToolCallId();
    if (!data) {
      return { ok: false, summary: `No subledger named ${args.name}.`, data: null, provenance: [] };
    }
    return {
      ok: true,
      summary: `${args.name} subledger loaded.`,
      data,
      provenance: [provenance(ctx, 'fetchSubledger', id, `${args.name} subledger`, 'loaded')],
    };
  },
};

export const parseDocument: Tool<{ document: string }, { document: string; pages: number; found: boolean }> = {
  name: 'parseDocument',
  mutating: false,
  async run(args, ctx) {
    const id = nextToolCallId();
    const found = Boolean(args.document);
    return {
      ok: found,
      summary: found ? `Parsed ${args.document}.` : 'Document missing.',
      data: { document: args.document, pages: 3, found },
      provenance: found ? [provenance(ctx, 'parseDocument', id, 'Source document', args.document)] : [],
    };
  },
};

export const journalEntrySchema = z.object({
  memo: z.string(),
  lines: z.array(z.object({ account: z.string(), debitCents: z.number().default(0), creditCents: z.number().default(0) })),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/**
 * The one tool that writes to the ledger. It refuses to run unless the approval
 * gate has a human decision on file for this run.
 */
export const postJournalEntry: Tool<JournalEntry, { postingId: string; amountCents: number }> = {
  name: 'postJournalEntry',
  mutating: true,
  async run(args, ctx) {
    const entry = journalEntrySchema.parse(args);
    const approval = ctx.approvals.find(ctx.runId);
    if (!approval || approval.decision !== 'approved') {
      throw new ApprovalRequiredError('postJournalEntry', ctx.runId);
    }
    const debits = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    const credits = entry.lines.reduce((s, l) => s + l.creditCents, 0);
    if (debits !== credits) {
      return { ok: false, summary: `Entry does not balance: ${usd(debits)} vs ${usd(credits)}.`, data: { postingId: '', amountCents: 0 }, provenance: [] };
    }
    const id = nextToolCallId();
    const postingId = `je_${ctx.runId}_${id}`;
    return {
      ok: true,
      summary: `Posted ${entry.memo} for ${usd(debits)} (approval ${approval.id}).`,
      data: { postingId, amountCents: debits },
      provenance: [provenance(ctx, 'postJournalEntry', id, 'Posted amount', usd(debits), entry.memo)],
    };
  },
};

export const buildWorkbook: Tool<
  { filename: string; sheets: { name: string; rows: (string | number)[][] }[] },
  { url: string; sizeBytes: number }
> = {
  name: 'buildWorkbook',
  mutating: false,
  async run(args, ctx) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vert';
    for (const sheet of args.sheets) {
      const ws = wb.addWorksheet(sheet.name.slice(0, 30));
      sheet.rows.forEach((row) => ws.addRow(row));
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((c) => (c.width = 28));
    }
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const out = path.join(ARTIFACT_DIR, args.filename);
    await wb.xlsx.writeFile(out);
    const { size } = await fs.stat(out);
    const id = nextToolCallId();
    return {
      ok: true,
      summary: `Built ${args.filename} (${args.sheets.length} sheets).`,
      data: { url: `/artifacts/${args.filename}`, sizeBytes: size },
      provenance: [provenance(ctx, 'buildWorkbook', id, 'Workbook', args.filename)],
    };
  },
};

export const renderPdf: Tool<{ filename: string; title: string; body: string[] }, { url: string; sizeBytes: number }> = {
  name: 'renderPdf',
  mutating: false,
  async run(args, ctx) {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let page = doc.addPage([612, 792]);
    let y = 730;
    page.drawText(args.title, { x: 56, y, size: 18, font: bold, color: rgb(0.05, 0.05, 0.05) });
    y -= 34;
    for (const para of args.body) {
      for (const line of wrap(para, 92)) {
        if (y < 64) {
          page = doc.addPage([612, 792]);
          y = 730;
        }
        page.drawText(line, { x: 56, y, size: 10.5, font, color: rgb(0.15, 0.15, 0.15) });
        y -= 15;
      }
      y -= 10;
    }
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const out = path.join(ARTIFACT_DIR, args.filename);
    await fs.writeFile(out, await doc.save());
    const { size } = await fs.stat(out);
    const id = nextToolCallId();
    return {
      ok: true,
      summary: `Rendered ${args.filename}.`,
      data: { url: `/artifacts/${args.filename}`, sizeBytes: size },
      provenance: [provenance(ctx, 'renderPdf', id, 'Document', args.filename)],
    };
  },
};

export const requestHumanInput: Tool<{ question: string }, { question: string }> = {
  name: 'requestHumanInput',
  mutating: false,
  async run(args, ctx) {
    const id = nextToolCallId();
    return {
      ok: true,
      summary: `Waiting on Alex: ${args.question}`,
      data: { question: args.question },
      provenance: [provenance(ctx, 'requestHumanInput', id, 'Open question', args.question)],
    };
  },
};

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export const TOOLS = {
  fetchTrialBalance,
  fetchSubledger,
  parseDocument,
  postJournalEntry,
  buildWorkbook,
  renderPdf,
  requestHumanInput,
} as const;

export type ToolRegistry = typeof TOOLS;
export { ApprovalRequiredError } from './types';
export type { ToolContext, ToolResult } from './types';
