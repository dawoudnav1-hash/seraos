import { finalizeEvent } from '../confidence';
import { SPECIALIST_REGISTRY } from '../specialists';
import type { AgentInput, AgentProvider } from '../provider';
import type { AgentEvent, Artifact, Blocker, SpecialistName, Step, ToolName } from '@/lib/domain/types';
import { MockERP, usd } from '../tools/mock-erp';

interface ScriptedCall {
  tool: ToolName;
  args: unknown;
  /** When the tool produced a file, publish it as an artifact under this name. */
  artifact?: { filename: string; kind: Artifact['kind'] };
}

interface ScriptedStep {
  title: string;
  agent: SpecialistName;
  notes: string[];
  calls: ScriptedCall[];
  /** Raised after this step's tool calls; the run stops until a human resolves it. */
  blocker?: Omit<Blocker, 'id' | 'stepId'>;
}

interface Script {
  steps: ScriptedStep[];
  confidence: number;
  openQuestions: string[];
  summary: string;
}

const tb = MockERP.trialBalance;
const payroll = MockERP.payroll;
const j163 = MockERP.section163j;
const cash = MockERP.cashForecast;

function scriptFor(input: AgentInput): Script {
  const t = input.task.toLowerCase();

  if (/three-way/.test(t)) {
    // Once the receiving report is in hand the match is unambiguous.
    const resolved = (input.resolvedBlockerIds?.length ?? 0) > 0;
    return {
      confidence: resolved ? 0.93 : 0.55,
      openQuestions: resolved ? [] : ['Was the goods receipt for PO 44872 ever recorded?'],
      summary: resolved
        ? `Three-way match complete for PO 44872 at ${usd(MockERP.threeWayMatch.invoice.amountCents)}; no exceptions.`
        : 'Three-way match halted pending the receiving report.',
      steps: [
        {
          title: 'Load AP subledger and documents',
          agent: 'ReconciliationAgent',
          notes: ['Loading AP subledger for PO 44872…'],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
        {
          title: 'Match invoice to PO and receiving report',
          agent: 'ReconciliationAgent',
          notes: [`Invoice and purchase order agree at ${usd(MockERP.threeWayMatch.invoice.amountCents)}.`],
          calls: [
            { tool: 'parseDocument', args: { document: MockERP.threeWayMatch.purchaseOrder.document } },
            { tool: 'parseDocument', args: { document: MockERP.threeWayMatch.invoice.document } },
            { tool: 'requestHumanInput', args: { question: 'Upload the receiving report for PO 44872, or confirm goods receipt.' } },
          ],
          blocker: {
            reason: 'missing_document',
            title: 'Receiving report missing for PO 44872',
            detail:
              'Missing receiving report for PO 44872, invoice and purchase order uploaded, but the receiving report is required to complete the three-way match. Please upload or confirm good receipt.',
            resolution: { kind: 'upload_file', label: 'Upload receiving report', secondaryLabel: 'Confirm goods receipt' },
          },
        },
      ],
    };
  }

  if (/cash flow|13-week|runway/.test(t)) {
    return {
      confidence: 0.86,
      openQuestions: [],
      summary: `13-week projection complete: ${cash.runwayMonths}-month runway at current burn.`,
      steps: [
        {
          title: 'Pull opening cash and AR/AP aging',
          agent: 'CashAgent',
          notes: [`Opening cash ${usd(cash.openingCashCents)} pulled from the trial balance.`],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Project 13 weeks of receipts and disbursements',
          agent: 'CashAgent',
          notes: [
            `Modelling ${usd(cash.weeklyCollectionsCents)} weekly collections against ${usd(cash.weeklyBurnCents)} weekly burn.`,
          ],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
        {
          title: 'Build projection workbook',
          agent: 'CashAgent',
          notes: ['Writing the 13-week projection workbook.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Cash_Flow_13_Week_Projection.xlsx',
                sheets: [
                  {
                    name: 'Projection',
                    rows: [
                      ['Week', 'Opening', 'Collections', 'Disbursements', 'Closing'],
                      ...Array.from({ length: 13 }, (_, i) => {
                        const open = cash.openingCashCents + i * (cash.weeklyCollectionsCents - cash.weeklyBurnCents);
                        return [
                          `W${i + 1}`,
                          open / 100,
                          cash.weeklyCollectionsCents / 100,
                          cash.weeklyBurnCents / 100,
                          (open + cash.weeklyCollectionsCents - cash.weeklyBurnCents) / 100,
                        ];
                      }),
                    ],
                  },
                ],
              },
              artifact: { filename: 'Cash_Flow_13_Week_Projection.xlsx', kind: 'xlsx' },
            },
          ],
        },
      ],
    };
  }

  if (/payroll/.test(t)) {
    const w = payroll.withholdings;
    return {
      confidence: 0.91,
      openQuestions: [],
      summary: `Payroll entry drafted for ${payroll.employeeCount} employees, gross ${usd(payroll.grossCents)}, awaiting approval to post.`,
      steps: [
        {
          title: 'Pull source subledger',
          agent: 'LedgerAgent',
          notes: [
            `Importing payroll register from AOR… ${payroll.employeeCount} employees, gross payroll ${usd(payroll.grossCents)} for period ending 11/15/2025`,
          ],
          calls: [{ tool: 'fetchSubledger', args: { name: 'payroll' } }],
        },
        {
          title: 'Draft journal entry',
          agent: 'LedgerAgent',
          notes: [`Entry balances: debit ${usd(payroll.grossCents)} to salaries and wages.`],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Prepare entry package for approval',
          agent: 'LedgerAgent',
          notes: ['Building the payroll entry package for review.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Payroll_Journal_Entry_2025-11-15.xlsx',
                sheets: [
                  {
                    name: 'Entry',
                    rows: [
                      ['Account', 'Description', 'Debit', 'Credit'],
                      ['6000', 'Salaries and wages', payroll.grossCents / 100, 0],
                      ['2100', 'FICA payable', 0, w.ficaCents / 100],
                      ['2100', 'Federal withholding payable', 0, w.federalCents / 100],
                      ['2100', 'State withholding payable', 0, w.stateCents / 100],
                      ['2100', '401(k) payable', 0, w.retirement401kCents / 100],
                      ['2000', 'Net payroll clearing', 0, payroll.netCents / 100],
                    ],
                  },
                ],
              },
              artifact: { filename: 'Payroll_Journal_Entry_2025-11-15.xlsx', kind: 'xlsx' },
            },
          ],
        },
      ],
    };
  }

  if (/163\(j\)/.test(t)) {
    const f = j163.form8990;
    return {
      confidence: 0.88,
      openQuestions: [],
      summary: `163(j) add-backs computed across ${j163.entities.length} entities; ${usd(f.disallowedCarryforwardCents)} carried forward.`,
      steps: [
        {
          title: 'Pull federal form data',
          agent: 'TaxAgent',
          notes: [
            `Pulling federal Form 8990 data… total business interest expense of ${usd(f.totalBusinessInterestExpenseCents)} across ${j163.entities.length} entities, ${f.atiLimitationPct}% ATI limitation applied`,
          ],
          calls: [{ tool: 'parseDocument', args: { document: 'Form_8990_FY24.pdf' } }],
        },
        {
          title: 'Compute limitation and add-backs',
          agent: 'TaxAgent',
          notes: [`Allowed interest ${usd(f.allowedInterestCents)}; disallowed ${usd(f.disallowedCarryforwardCents)}.`],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Build workpaper',
          agent: 'TaxAgent',
          notes: ['Assembling the state add-back workpaper.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Section_163j_State_Addbacks.xlsx',
                sheets: [
                  {
                    name: '163(j)',
                    rows: [
                      ['Entity', 'Business interest expense', 'ATI', 'Allowed', 'Disallowed'],
                      ...j163.entities.map((e, i) => [
                        e,
                        f.totalBusinessInterestExpenseCents / 100 / 3,
                        f.adjustedTaxableIncomeCents / 100 / 3,
                        f.allowedInterestCents / 100 / 3,
                        f.disallowedCarryforwardCents / 100 / 3,
                      ]),
                    ],
                  },
                ],
              },
              artifact: { filename: 'Section_163j_State_Addbacks.xlsx', kind: 'xlsx' },
            },
          ],
        },
      ],
    };
  }

  if (/asc 842|lease/.test(t)) {
    const finance = MockERP.leases.leases.filter((l) => l.classification === 'finance');
    return {
      confidence: 0.84,
      openQuestions: [],
      summary: `3 equipment leases classified; ${finance.length} finance leases recognised under ASC 842.`,
      steps: [
        {
          title: 'Parse the underlying agreement',
          agent: 'TechnicalAccountingAgent',
          notes: [
            `Classifying 3 equipment leases… ${finance.length} finance leases based on present value test exceeding 90% threshold`,
          ],
          calls: [{ tool: 'parseDocument', args: { document: 'Equipment_Lease_Schedule.pdf' } }],
        },
        {
          title: 'Apply the standard and document judgments',
          agent: 'TechnicalAccountingAgent',
          notes: [`Right-of-use asset ${usd(tb.accounts.find((a) => a.account === '1600')!.debit * 100)} recognised.`],
          calls: [{ tool: 'fetchSubledger', args: { name: 'leases' } }],
        },
        {
          title: 'Draft memo with citations',
          agent: 'TechnicalAccountingAgent',
          notes: ['Drafting the ASC 842 classification memo.'],
          calls: [
            {
              tool: 'renderPdf',
              args: {
                filename: 'Lease_Classification_Memo_ASC842.pdf',
                title: 'Lease Classification Memo — ASC 842',
                body: [
                  'Scope: three equipment leases held by Alder River Ops, Inc.',
                  `Conclusion: ${finance.length} of 3 leases are finance leases under ASC 842-10-25-2(d), the present value of lease payments exceeding 90% of fair value.`,
                  'The office copier schedule remains an operating lease at a 61.4% present value ratio.',
                ],
              },
              artifact: { filename: 'Lease_Classification_Memo_ASC842.pdf', kind: 'pdf' },
            },
          ],
        },
      ],
    };
  }

  if (/asc 606|revenue recognition/.test(t)) {
    return {
      confidence: 0.62,
      openQuestions: [
        'Are the implementation services in the MSA distinct from the platform licence, or a combined performance obligation?',
      ],
      summary: 'ASC 606 analysis paused on a performance obligation judgment.',
      steps: [
        {
          title: 'Parse the underlying agreement',
          agent: 'TechnicalAccountingAgent',
          notes: [
            'Identifying performance obligations in Master Services Agreement… 4 distinct deliverables requiring allocation',
          ],
          calls: [{ tool: 'parseDocument', args: { document: 'Master_Services_Agreement.pdf' } }],
        },
        {
          title: 'Apply the standard and document judgments',
          agent: 'TechnicalAccountingAgent',
          notes: ['Allocating transaction price on relative standalone selling price.'],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
      ],
    };
  }

  if (/quality control|footing/.test(t)) {
    return {
      confidence: 0.9,
      openQuestions: [],
      summary: `Balance sheet footings tie to ${usd(tb.totals.debits * 100)}. 3 contracts missing from the deferral schedule, exceptions documented.`,
      steps: [
        {
          title: 'Tie statement footings to trial balance',
          agent: 'QualityControlAgent',
          notes: [`Balance sheet footings tie to ${usd(tb.totals.debits * 100)}.`],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Test revenue completeness against CRM',
          agent: 'QualityControlAgent',
          notes: ['Revenue completeness tested against CRM — 3 contracts missing from deferral schedule.'],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
        {
          title: 'Document exceptions',
          agent: 'QualityControlAgent',
          notes: ['Exceptions documented.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'QC_Review_Workbook.xlsx',
                sheets: [
                  {
                    name: 'Footings',
                    rows: [
                      ['Account', 'Name', 'Debit', 'Credit'],
                      ...tb.accounts.map((a) => [a.account, a.name, a.debit, a.credit]),
                      ['', 'Total', tb.totals.debits, tb.totals.credits],
                    ],
                  },
                ],
              },
              artifact: { filename: 'QC_Review_Workbook.xlsx', kind: 'xlsx' },
            },
            {
              tool: 'renderPdf',
              args: {
                filename: 'Exceptions_Report.pdf',
                title: 'Quality Control Exceptions',
                body: [
                  `Balance sheet footings tie to ${usd(tb.totals.debits * 100)} against the trial balance.`,
                  'Three customer contracts are absent from the deferral schedule and are listed in the workbook.',
                ],
              },
              artifact: { filename: 'Exceptions_Report.pdf', kind: 'pdf' },
            },
          ],
        },
      ],
    };
  }

  if (/disclosure checklist|audit disclosure/.test(t)) {
    return {
      confidence: 0.89,
      openQuestions: [],
      summary:
        '23 disclosures reviewed, 2 contingent liabilities flagged (ASC 450), 1 subsequent event requiring footnote disclosure (ASC 855).',
      steps: [
        {
          title: 'Walk the disclosure checklist against FY24 financials',
          agent: 'TechnicalAccountingAgent',
          notes: ['Completed audit disclosure checklist against FY24 financials. 23 disclosures reviewed.'],
          calls: [{ tool: 'parseDocument', args: { document: 'FY24_Financial_Statements.pdf' } }],
        },
        {
          title: 'Assess contingencies and subsequent events',
          agent: 'TechnicalAccountingAgent',
          notes: [
            '2 contingent liabilities flagged (ASC 450), 1 subsequent event requiring footnote disclosure (ASC 855).',
          ],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
        {
          title: 'Publish checklist and summary',
          agent: 'TechnicalAccountingAgent',
          notes: ['Writing the disclosure checklist and summary.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Disclosure_Checklist_FY24.xlsx',
                sheets: [
                  {
                    name: 'Checklist',
                    rows: [
                      ['#', 'Disclosure', 'Standard', 'Status'],
                      ...Array.from({ length: 23 }, (_, i) => [
                        i + 1,
                        `Disclosure ${i + 1}`,
                        i === 20 || i === 21 ? 'ASC 450' : i === 22 ? 'ASC 855' : 'ASC 235',
                        i >= 20 ? 'Flagged' : 'Complete',
                      ]),
                    ],
                  },
                ],
              },
              artifact: { filename: 'Disclosure_Checklist_FY24.xlsx', kind: 'xlsx' },
            },
            {
              tool: 'renderPdf',
              args: {
                filename: 'Disclosures_Summary.pdf',
                title: 'FY24 Disclosure Summary',
                body: [
                  '23 disclosures were reviewed against the FY24 financial statements.',
                  'Two loss contingencies meet the ASC 450-20 reasonably possible threshold and require disclosure.',
                  'One subsequent event requires a footnote under ASC 855-10-50-2.',
                ],
              },
              artifact: { filename: 'Disclosures_Summary.pdf', kind: 'pdf' },
            },
          ],
        },
      ],
    };
  }

  if (/1065|partnership income tax|k-1/.test(t)) {
    const partners = [
      ['Alder River GP, LLC', 2],
      ['Meridian Family Trust', 38],
      ['J. Okafor', 31],
      ['R. Lindqvist', 29],
    ] as const;
    return {
      confidence: 0.88,
      openQuestions: [],
      summary: 'Form 1065 workbook prepared with K-1 allocations by partner.',
      steps: [
        {
          title: 'Pull federal form data',
          agent: 'TaxAgent',
          notes: ['Comprehensive 1065 Excel workbook prepared with K-1 allocations by partner'],
          calls: [{ tool: 'parseDocument', args: { document: 'Form_1065_FY24_Draft.pdf' } }],
        },
        {
          title: 'Allocate income to partners',
          agent: 'TaxAgent',
          notes: ['Allocating ordinary business income across 4 partners by capital percentage.'],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Build workpaper',
          agent: 'TaxAgent',
          notes: ['Building the 1065 workbook and preparation notes.'],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Form_1065_Preparation_Alder_River_Growth_Partners_LP.xlsx',
                sheets: [
                  {
                    name: 'K-1 Allocations',
                    rows: [
                      ['Partner', 'Capital %', 'Ordinary income', 'Guaranteed payments'],
                      ...partners.map(([name, pct]) => [name, pct / 100, (tb.totals.credits * 0.04 * pct) / 100, 0]),
                    ],
                  },
                ],
              },
              artifact: { filename: 'Form_1065_Preparation_Alder_River_Growth_Partners_LP.xlsx', kind: 'xlsx' },
            },
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Form_1065_Preparation_Notes_Alder_River_Growth_Partners_LP.xlsx',
                sheets: [
                  {
                    name: 'Notes',
                    rows: [
                      ['Topic', 'Note'],
                      ['Capital accounts', 'Maintained on the tax basis per the 2024 instructions.'],
                      ['Section 704(b)', 'Allocations follow the partnership agreement; no special allocations.'],
                      ['Section 163(j)', 'Excess business interest expense pushed out on K-1 line 13K.'],
                    ],
                  },
                ],
              },
              artifact: { filename: 'Form_1065_Preparation_Notes_Alder_River_Growth_Partners_LP.xlsx', kind: 'xlsx' },
            },
          ],
        },
      ],
    };
  }

  if (/board|reporting pack/.test(t)) {
    return {
      confidence: 0.87,
      openQuestions: [],
      summary: `Created January 2025 monthly reporting pack across 4 entities. Consolidated P&L, balance sheet, and cash flow with intercompany eliminations. ${cash.runwayMonths}-month runway at current burn.`,
      steps: [
        {
          title: 'Consolidate entity trial balances',
          agent: 'ReportingAgent',
          notes: ['Consolidating 4 entity trial balances for January 2025.'],
          calls: [{ tool: 'fetchTrialBalance', args: {} }],
        },
        {
          title: 'Eliminate intercompany activity',
          agent: 'ReportingAgent',
          notes: ['Intercompany eliminations shown in their own column.'],
          calls: [{ tool: 'fetchSubledger', args: { name: 'ap' } }],
        },
        {
          title: 'Build pack and board memo',
          agent: 'ReportingAgent',
          notes: [`Assembling the board pack; ${cash.runwayMonths}-month runway at current burn.`],
          calls: [
            {
              tool: 'buildWorkbook',
              args: {
                filename: 'Monthly_Reporting_Pack_Jan2025.xlsx',
                sheets: [
                  {
                    name: 'Consolidated BS',
                    rows: [
                      ['Account', 'Name', 'Debit', 'Credit'],
                      ...tb.accounts.map((a) => [a.account, a.name, a.debit, a.credit]),
                      ['', 'Total', tb.totals.debits, tb.totals.credits],
                    ],
                  },
                  {
                    name: 'Cash Flow',
                    rows: [
                      ['Week', 'Closing cash'],
                      ...Array.from({ length: 13 }, (_, i) => [
                        `W${i + 1}`,
                        (cash.openingCashCents + (i + 1) * (cash.weeklyCollectionsCents - cash.weeklyBurnCents)) / 100,
                      ]),
                    ],
                  },
                ],
              },
              artifact: { filename: 'Monthly_Reporting_Pack_Jan2025.xlsx', kind: 'xlsx' },
            },
            {
              tool: 'renderPdf',
              args: {
                filename: 'Board_Memo_Jan2025.pdf',
                title: 'Board Memo — January 2025',
                body: [
                  'Consolidated results cover four entities with intercompany activity eliminated in a dedicated column.',
                  `Balance sheet foots to ${usd(tb.totals.debits * 100)}.`,
                  `At the current weekly burn of ${usd(cash.weeklyBurnCents)}, runway is ${cash.runwayMonths} months.`,
                ],
              },
              artifact: { filename: 'Board_Memo_Jan2025.pdf', kind: 'pdf' },
            },
          ],
        },
      ],
    };
  }

  // Anything else: drive the routed specialist's own declared plan.
  return genericScript(input);
}

function slug(title: string): string {
  return title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'Vert_Output';
}

/**
 * Fallback for tasks Ask Vert invents: every call comes from the specialist's
 * own plan, so a specialist can never be handed a tool it has not declared.
 */
function genericScript(input: AgentInput): Script {
  const spec = SPECIALIST_REGISTRY[input.specialist];
  const planned = spec.plan(input.task);
  const name = slug(input.title);
  const steps: ScriptedStep[] = planned.map((step, i) => {
    const calls: ScriptedCall[] = [];
    for (const tool of step.tools) {
      if (tool === 'fetchTrialBalance') calls.push({ tool, args: {} });
      if (tool === 'fetchSubledger') calls.push({ tool, args: { name: 'ap' } });
      if (tool === 'parseDocument') calls.push({ tool, args: { document: `${name}_Source.pdf` } });
      if (tool === 'buildWorkbook')
        calls.push({
          tool,
          args: {
            filename: `${name}.xlsx`,
            sheets: [
              {
                name: 'Workpaper',
                rows: [
                  ['Account', 'Name', 'Debit', 'Credit'],
                  ...tb.accounts.map((a) => [a.account, a.name, a.debit, a.credit]),
                  ['', 'Total', tb.totals.debits, tb.totals.credits],
                ],
              },
            ],
          },
          artifact: { filename: `${name}.xlsx`, kind: 'xlsx' },
        });
      if (tool === 'renderPdf')
        calls.push({
          tool,
          args: {
            filename: `${name}.pdf`,
            title: input.title,
            body: [
              input.task,
              `Prepared by ${input.specialist} against the ${tb.period} trial balance, which foots to ${usd(tb.totals.debits * 100)}.`,
            ],
          },
          artifact: { filename: `${name}.pdf`, kind: 'pdf' },
        });
      // requestHumanInput and postJournalEntry are never called speculatively.
    }
    return {
      title: step.title,
      agent: input.specialist,
      notes: [`${step.title}…`],
      calls,
    };
  });

  return {
    steps,
    confidence: 0.82,
    openQuestions: [],
    summary: `${input.title} complete. ${steps.length} steps executed by ${input.specialist}.`,
  };
}

export interface MockProviderOptions {
  /** Delay between emitted events. Zero in tests, ~600ms in the app. */
  tickMs?: number;
}

/** Deterministic, fixture-backed provider. Default everywhere but production. */
export class MockProvider implements AgentProvider {
  readonly id = 'mock';
  constructor(private readonly opts: MockProviderOptions = {}) {}

  async *runAgent(input: AgentInput): AsyncIterable<AgentEvent> {
    const tick = this.opts.tickMs ?? 0;
    const script = scriptFor(input);
    const spec = SPECIALIST_REGISTRY[input.specialist];
    const steps: Step[] = script.steps.map((s, i) => ({
      id: `${input.runId}_s${i + 1}`,
      title: s.title,
      agent: s.agent,
      tools: [...new Set(s.calls.map((c) => c.tool))],
      status: 'pending',
    }));

    yield { type: 'plan_created', steps };
    await wait(tick);

    const total = steps.length;
    for (let i = 0; i < script.steps.length; i++) {
      const scripted = script.steps[i];
      const step = steps[i];
      yield { type: 'step_started', stepId: step.id, agent: scripted.agent };
      await wait(tick);

      for (const note of scripted.notes) {
        yield { type: 'progress', stepId: step.id, pct: Math.round(((i + 0.3) / total) * 100), note };
        await wait(tick);
      }

      for (const call of scripted.calls) {
        if (!spec.tools.includes(call.tool)) {
          yield { type: 'run_failed', error: `${input.specialist} is not allowed to call ${call.tool}.` };
          return;
        }
        yield { type: 'tool_called', stepId: step.id, tool: call.tool, args: call.args };
        const result = await input.callTool(step.id, call.tool, call.args);
        yield {
          type: 'tool_result',
          stepId: step.id,
          ok: result.ok,
          summary: result.summary,
          provenance: result.provenance,
        };
        if (result.ok && call.artifact) {
          const data = result.data as { url: string; sizeBytes: number };
          yield {
            type: 'artifact_created',
            artifact: {
              id: `art_${input.runId}_${call.artifact.filename}`,
              filename: call.artifact.filename,
              kind: call.artifact.kind,
              sizeBytes: data.sizeBytes,
              url: data.url,
              generatedBy: scripted.agent,
            },
          };
        }
        await wait(tick);
      }

      if (scripted.blocker && !input.resolvedBlockerIds?.includes(`blk_${input.runId}_s${i + 1}`)) {
        yield {
          type: 'blocked',
          blocker: { ...scripted.blocker, id: `blk_${input.runId}_s${i + 1}`, stepId: step.id },
        };
        return;
      }

      yield { type: 'step_completed', stepId: step.id };
      await wait(tick);
    }

    yield finalizeEvent({
      runId: input.runId,
      stepId: steps[steps.length - 1]?.id ?? '',
      summary: script.summary,
      confidence: script.confidence,
      openQuestions: script.openQuestions,
    });
  }
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
