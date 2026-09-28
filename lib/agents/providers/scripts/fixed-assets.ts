import {
  FIXED_ASSETS as fa,
  afterClose,
  aprilDepreciation,
  currentState,
  depreciationEntry,
  disposalEntry,
  disposals,
  misclassified,
  money,
  reclassEntry,
  reviewedButKept,
  type JournalEntry,
} from '@/lib/accounting/fixed-assets';
import type { AgentInput } from '../../provider';
import type { Script } from '../script-types';

const d = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function jeRows(je: JournalEntry) {
  return je.lines.map((l) => ({
    cells: [l.account, l.description, l.debitCents ? money(l.debitCents) : '', l.creditCents ? money(l.creditCents) : ''],
    source: l.source,
  }));
}

function jeSheetRows(je: JournalEntry): (string | number)[][] {
  return je.lines.map((l) => [je.id, l.account, l.description, l.debitCents / 100, l.creditCents / 100, l.source]);
}

/**
 * Fixed Assets — April 2026 Close. Mirrors how a preparer works: ask first,
 * then scan, compute, draft entries, and hand in workpapers. Every figure is
 * computed from the register and GL detail in fixtures/fixed-assets.json.
 */
export function fixedAssetsScript(input: AgentInput): Script {
  const state = currentState();
  const capex = misclassified();
  const kept = reviewedButKept();
  const dep = aprilDepreciation();
  const disposal = disposals()[0];
  const reclass = reclassEntry();
  const depJe = depreciationEntry();
  const dispJe = disposalEntry()!;
  const after = afterClose();
  const answers = input.answers ?? {};
  const capexTotal = capex.reduce((s, l) => s + l.amountCents, 0);

  const stateTable = {
    id: 'fa_current_state',
    title: `Current State (Balance Sheet as of ${longDate(fa.balanceSheetDate)})`,
    columns: ['Account', 'Original Cost', 'Accum. Depr.', 'NBV'],
    rows: [
      ...state.rows.map((r) => ({
        cells: [r.class, money(r.costCents), money(r.accumCents, { parens: true }), money(r.nbvCents)],
        source: r.ids.join(', '),
      })),
      {
        cells: ['Total Fixed Assets', money(state.total.costCents), money(state.total.accumCents, { parens: true }), money(state.total.nbvCents)],
        source: 'Sum of register',
        emphasis: true,
      },
    ],
  };

  const capexTable = {
    id: 'fa_misclassified',
    section: 'Findings from GL Cross-Reference Scan',
    title: 'Misclassified Capital Expenditures (Office Expenses & Automobile)',
    caption: `${capex.length} of ${fa.aprilExpenses.length} April expense lines meet the ${money(fa.capitalizationThresholdCents)} capitalization policy.`,
    columns: ['Date', 'Vendor / Description', 'GL Account', 'Amount', 'Asset Type'],
    rows: capex.map((l) => ({ cells: [d(l.date), l.vendor, l.account, money(l.amountCents), l.assetType ?? ''], source: l.je })),
  };

  const keptTable = {
    id: 'fa_reviewed',
    section: 'Findings from GL Cross-Reference Scan',
    title: 'Reviewed and left in expense',
    columns: ['Date', 'Vendor', 'GL Account', 'Amount', 'Why it stays'],
    rows: kept.map((l) => ({ cells: [d(l.date), l.vendor, l.account, money(l.amountCents), l.reason ?? ''], source: l.je })),
  };

  const depTable = {
    id: 'fa_april_depreciation',
    title: 'April 2026 Depreciation Schedule',
    columns: ['Asset', 'Description', 'Cost', 'Opening Accum.', 'April', 'Closing Accum.'],
    rows: [
      ...dep.map((r) => ({
        cells: [
          r.asset.id,
          r.disposed ? `${r.asset.description} (disposed)` : r.asset.description,
          money(r.asset.costCents),
          money(r.openingAccumCents),
          money(r.aprilCents),
          money(r.closingAccumCents),
        ],
        source: r.asset.id,
      })),
      {
        cells: ['', 'Total', '', '', money(after.aprilDepreciationCents), ''],
        source: 'Sum of schedule',
        emphasis: true,
      },
    ],
  };

  const workbookSheets = [
    {
      name: 'Depreciation_Schedule',
      rows: [
        ['Asset ID', 'Asset Description', 'Class', 'Placed in Service', 'Cost Basis', 'Salvage', 'Life (mo)', 'Method', 'Opening Accum.', 'April Depr.', 'Closing Accum.', 'NBV'],
        ...dep.map((r) => [
          r.asset.id,
          r.asset.description,
          r.asset.class,
          r.asset.placedInService,
          r.asset.costCents / 100,
          r.asset.salvageCents / 100,
          r.asset.lifeMonths,
          'Straight-line',
          r.openingAccumCents / 100,
          r.aprilCents / 100,
          r.closingAccumCents / 100,
          (r.asset.costCents - r.closingAccumCents) / 100,
        ]),
        ...capex.map((l) => [
          `NEW-${l.je.slice(-4)}`,
          l.memo,
          l.assetClass ?? '',
          l.date,
          l.amountCents / 100,
          0,
          l.lifeMonths ?? 0,
          'Straight-line',
          0,
          0,
          0,
          l.amountCents / 100,
        ]),
      ],
    },
    {
      name: 'Dispositions',
      rows: [
        ['Asset ID', 'Description', 'Date', 'Cost', 'Accum. Depr.', 'NBV', 'Proceeds', 'Gain / (Loss)', 'Note'],
        [
          disposal.asset.id,
          disposal.asset.description,
          disposal.date,
          disposal.asset.costCents / 100,
          disposal.accumCents / 100,
          disposal.nbvCents / 100,
          disposal.proceedsCents / 100,
          disposal.gainLossCents / 100,
          disposal.note,
        ],
      ],
    },
    {
      name: 'Summary',
      rows: [
        ['Line', 'Cost', 'Accum. Depr.', 'NBV'],
        ['Opening (Apr 30, pre-close)', state.total.costCents / 100, state.total.accumCents / 100, state.total.nbvCents / 100],
        ['Additions (reclassified from expense)', after.additionsCents / 100, 0, after.additionsCents / 100],
        ['Disposals', -disposal.asset.costCents / 100, -disposal.accumCents / 100, -disposal.nbvCents / 100],
        ['April depreciation', 0, after.aprilDepreciationCents / 100, -after.aprilDepreciationCents / 100],
        ['Closing', after.costCents / 100, after.accumCents / 100, after.nbvCents / 100],
      ],
    },
    {
      name: 'Journal_Entries',
      rows: [['Entry', 'Account', 'Description', 'Debit', 'Credit', 'Source'], ...jeSheetRows(reclass), ...jeSheetRows(depJe), ...jeSheetRows(dispJe)],
    },
  ];

  const currency = answers.fa_q1 ?? 'USD';

  return {
    confidence: 0.9,
    openQuestions: [],
    clarificationIntro:
      'Before I build your fixed asset depreciation schedule and journal entries, I’d like to understand your requirements in more detail. I’ll ask a few questions to ensure the outputs are accurate and tailored to your needs.',
    clarificationWhy:
      'These details help me generate accurate depreciation schedules, identify misclassified capital expenditures, and draft the required journal entries.',
    clarifications: [
      {
        id: 'fa_q1',
        phase: 'Understanding',
        question: 'What is the reporting currency for this close?',
        help: 'This helps ensure all values are calculated and reported correctly.',
        known: 'Reporting currency: {answer}',
      },
      {
        id: 'fa_q2',
        phase: 'Scope',
        question: 'Which asset classes should be included in the depreciation schedule?',
        help: 'For example, should we include Computer Equipment, Furniture, Vehicles, etc.?',
        known: 'Asset classes: {answer}',
      },
      {
        id: 'fa_q3',
        phase: 'Data',
        question: 'Do you have any additions, disposals, or impairments in April 2026?',
        help: 'This helps ensure we account for any changes impacting depreciation.',
        known: 'April activity: {answer}',
      },
      {
        id: 'fa_q4',
        phase: 'Outputs',
        question: 'Do you have a preferred depreciation method for each asset class?',
        help: 'For example, Straight-line for all, or specific methods per category?',
        known: 'Depreciation method: {answer}',
      },
      {
        id: 'fa_q5',
        phase: 'Review',
        question: 'Are there any specific GL accounts or mappings you want me to use?',
        help: 'This ensures journal entries are posted to the correct accounts.',
        known: 'Account mappings: {answer}',
      },
    ],
    scope: `Build the fixed asset depreciation schedule from scratch, calculate April depreciation, identify misclassified capital expenditures, and draft journal entries for posting to ${fa.erp === 'QuickBooks Online' ? 'QBO' : fa.erp}.`,
    reasoning: [
      `Capitalization policy is ${money(fa.capitalizationThresholdCents)}; purchases above it with a useful life beyond the period are capital, consumables and repairs stay in expense.`,
      fa.convention,
      `Straight-line over cost less salvage; accumulated depreciation is rounded once per asset at the total so the schedule ties to the ledger.`,
      `Journal entries are drafted only. Nothing posts to ${fa.erp} until the workpapers have two approvals.`,
    ],
    summary: `Depreciation schedule and ${3} draft journal entries prepared for ${fa.entity}. April depreciation ${money(after.aprilDepreciationCents)}; ${capex.length} purchases (${money(capexTotal)}) reclassified to fixed assets; 1 disposal recorded.`,
    findings: [
      `${capex.length} April purchases totalling ${money(capexTotal)} were booked to expense but meet the capitalization policy (${capex.map((c) => c.je).join(', ')}).`,
      `April depreciation is ${money(after.aprilDepreciationCents)} across ${dep.filter((r) => r.aprilCents > 0).length} assets in service.`,
      `${disposal.asset.id} (${disposal.asset.description}) was disposed of on ${d(disposal.date)} — ${disposal.gainLossCents < 0 ? 'loss' : 'gain'} of ${money(Math.abs(disposal.gainLossCents))}.`,
      `Fixed assets roll from ${money(state.total.nbvCents)} to ${money(after.nbvCents)} NBV once the drafted entries post.`,
    ],
    assumptions: [
      `Reporting currency is ${currency}; all amounts are ${currency}.`,
      `New additions start depreciating in May 2026 under the month-after-in-service convention, so they carry no April expense.`,
      `The Dell server credit of ${money(disposal.proceedsCents)} is recorded as a vendor credit receivable until it is applied to an invoice.`,
    ],
    steps: [
      {
        title: 'Inputs & Parameters',
        agent: 'LedgerAgent',
        notes: [`Loading the ${fa.entity} fixed asset register from ${fa.erp}…`],
        calls: [
          {
            tool: 'fetchSubledger',
            args: { name: 'fixed_assets' },
            table: stateTable,
            provenance: [
              { label: 'Original cost', value: money(state.total.costCents), note: `${fa.register.length} assets in the register` },
              { label: 'Accumulated depreciation', value: money(state.total.accumCents, { parens: true }), note: 'Through March 2026' },
              { label: 'Net book value', value: money(state.total.nbvCents), note: `As of ${d(fa.balanceSheetDate)}` },
            ],
          },
        ],
      },
      {
        title: 'Identify Misclassified Capital Expenditures',
        agent: 'LedgerAgent',
        notes: [`Scanning ${fa.aprilExpenses.length} April lines in Office Expenses and Automobile Expenses against the ${money(fa.capitalizationThresholdCents)} policy…`],
        calls: [
          {
            tool: 'fetchSubledger',
            args: { name: 'gl_april_expenses' },
            table: capexTable,
            provenance: capex.map((l) => ({ label: `${l.vendor.split(' –')[0]} (${l.je})`, value: money(l.amountCents), note: `${l.account} → ${l.assetType}` })),
          },
          { tool: 'fetchSubledger', args: { name: 'gl_april_expenses', view: 'kept' }, table: keptTable },
        ],
      },
      {
        title: 'Build April 2026 Depreciation Schedule',
        agent: 'LedgerAgent',
        notes: [`April depreciation comes to ${money(after.aprilDepreciationCents)}; ${disposal.asset.id} is excluded as disposed.`],
        calls: [
          {
            tool: 'fetchTrialBalance',
            args: { period: '2026-04' },
            table: depTable,
            provenance: [{ label: 'April depreciation', value: money(after.aprilDepreciationCents), note: 'Straight-line, month-after-in-service' }],
          },
        ],
      },
      {
        title: 'Draft Reclassification Journal Entries',
        agent: 'LedgerAgent',
        notes: [`Drafting the reclass of ${money(capexTotal)} from expense to fixed assets.`],
        calls: [
          {
            tool: 'fetchTrialBalance',
            args: { period: '2026-04', purpose: 'reclass' },
            table: { id: 'fa_je_reclass', section: 'Draft Journal Entries', title: `${reclass.id} — ${reclass.memo}`, columns: ['Account', 'Description', 'Debit', 'Credit'], rows: jeRows(reclass) },
          },
        ],
      },
      {
        title: 'Draft Depreciation Journal Entry',
        agent: 'LedgerAgent',
        notes: ['Drafting April depreciation and the server disposal.'],
        calls: [
          {
            tool: 'fetchTrialBalance',
            args: { period: '2026-04', purpose: 'depreciation' },
            table: { id: 'fa_je_dep', section: 'Draft Journal Entries', title: `${depJe.id} — ${depJe.memo}`, columns: ['Account', 'Description', 'Debit', 'Credit'], rows: jeRows(depJe) },
          },
          {
            tool: 'fetchTrialBalance',
            args: { period: '2026-04', purpose: 'disposal' },
            table: { id: 'fa_je_disposal', section: 'Draft Journal Entries', title: `${dispJe.id} — ${dispJe.memo}`, columns: ['Account', 'Description', 'Debit', 'Credit'], rows: jeRows(dispJe) },
          },
        ],
      },
      {
        title: 'Review & Finalize',
        agent: 'LedgerAgent',
        notes: ['Writing the workbook and the close memo.'],
        calls: [
          {
            tool: 'buildWorkbook',
            args: { filename: 'Fixed_Assets_April_2026_Close_Brevard_Logistics.xlsx', sheets: workbookSheets },
            artifact: { filename: 'Fixed_Assets_April_2026_Close_Brevard_Logistics.xlsx', kind: 'xlsx' },
          },
          {
            tool: 'renderDocx',
            args: {
              filename: 'Fixed_Assets_April_2026_Close_Memo_Brevard_Logistics.docx',
              title: `Fixed Assets — April 2026 Close (${fa.entity})`,
              sections: [
                { heading: 'Scope', paragraphs: [`Depreciation schedule, April depreciation, capital expenditure review and draft entries for ${fa.erp}.`] },
                { heading: 'Current state', paragraphs: [`Before close: cost ${money(state.total.costCents)}, accumulated depreciation ${money(state.total.accumCents)}, NBV ${money(state.total.nbvCents)}.`] },
                { heading: 'Findings', paragraphs: capex.map((l) => `${l.je} ${l.vendor} — ${money(l.amountCents)} booked to ${l.account}; reclassify to ${l.assetType}.`) },
                { heading: 'Draft entries', paragraphs: [reclass, depJe, dispJe].map((je) => `${je.id}: ${je.memo} — ${money(je.lines.reduce((s, l) => s + l.debitCents, 0))}.`) },
                { heading: 'After close', paragraphs: [`Cost ${money(after.costCents)}, accumulated depreciation ${money(after.accumCents)}, NBV ${money(after.nbvCents)}.`] },
              ],
            },
            artifact: { filename: 'Fixed_Assets_April_2026_Close_Memo_Brevard_Logistics.docx', kind: 'docx' },
          },
        ],
      },
    ],
  };
}
