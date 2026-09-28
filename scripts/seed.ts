import fs from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../lib/agents/providers/mock';
import { routeTask } from '../lib/agents/specialists';
import { answerClarification, callTool, markViewed, startRun } from '../lib/agents/orchestrator';
import { appendEvent, createRun, getRun } from '../lib/agents/store';
import { db, schema } from '../lib/db';
import type { AgentEvent, RunView } from '../lib/domain/types';

const provider = new MockProvider({ tickMs: 0 });
const MIN = 60_000;

interface SeedSpec {
  id: string;
  title: string;
  task: string;
  client: string;
  ageMs: number;
  /** Stop the stream once the run reports at least this much progress. */
  stopAtPct?: number;
  /** Run to completion, then mark the run as opened by a human. */
  view?: boolean;
}

const SEEDS: SeedSpec[] = [
  { id: 'run_cash_13w', client: 'Brevard Logistics', title: 'Prepare 13-Week Cash Flow Projection', task: 'Prepare a 13-week cash flow projection and runway estimate.', ageMs: 0, stopAtPct: 5 },
  { id: 'run_asc606', client: 'Caraway Health Group', title: 'FY24 Revenue Recognition Memo (ASC 606)', task: 'Write the FY24 revenue recognition memo under ASC 606 for the Master Services Agreement.', ageMs: 0, stopAtPct: 5 },
  { id: 'run_asc842', client: 'Caraway Health Group', title: 'Lease Agreement Analysis (ASC 842)', task: 'Classify the equipment leases under ASC 842.', ageMs: 0, stopAtPct: 5 },
  { id: 'run_163j', client: 'Alder River Growth Partners', title: 'Analyze State Section 163(j) Interest Expense Add-Backs', task: 'Analyze state Section 163(j) interest expense add-backs across the three entities.', ageMs: 2 * MIN, stopAtPct: 5 },
  { id: 'run_payroll', client: 'Sable Creek Properties LLC', title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry for the period ending 1/31/2025.', ageMs: 2 * MIN, stopAtPct: 5 },
  { id: 'run_flux', client: 'Brevard Logistics', title: 'Prepare Q4 Flux Analysis Commentary', task: 'Prepare Q4 flux analysis commentary for the reporting pack.', ageMs: 25 * MIN, stopAtPct: 40 },
  { id: 'run_3way', client: 'Pinelith Construction Co.', title: 'Perform Three-Way Match', task: 'Perform a three-way match for PO 44872.', ageMs: 30 * MIN },
  { id: 'run_board_pack', client: 'Brevard Logistics', title: 'Create Monthly Reporting Pack for Board Review', task: 'Create the January 2025 monthly reporting pack for board review.', ageMs: 60 * MIN },
  { id: 'run_disclosures', client: 'Pinelith Construction Co.', title: 'Perform Audit Disclosure Checklist', task: 'Perform the FY24 audit disclosure checklist.', ageMs: 3 * 60 * MIN },
  { id: 'run_qc', client: 'Pinelith Construction Co.', title: 'Review Financial Statements for Quality Control', task: 'Review the financial statements for quality control and tie the footings.', ageMs: 6 * 60 * MIN },
  { id: 'run_1065', client: 'Alder River Growth Partners', title: 'Partnership Income Tax Return Workbook Preparation', task: 'Prepare the Form 1065 partnership income tax return workbook with K-1 allocations.', ageMs: 60 * MIN, view: true },
];

async function seedRun(spec: SeedSpec): Promise<RunView> {
  const agent = routeTask(`${spec.title} ${spec.task}`);
  const createdAt = Date.now() - spec.ageMs;
  createRun({ id: spec.id, title: spec.title, task: spec.task, client: spec.client, agent, createdAt });

  const stream = provider.runAgent({
    runId: spec.id,
    task: spec.task,
    title: spec.title,
    specialist: agent,
    callTool: (stepId, tool, args) => callTool(spec.id, agent, stepId, tool, args),
  });

  let at = createdAt;
  for await (const event of stream as AsyncIterable<AgentEvent>) {
    at += 800;
    const run = appendEvent(spec.id, event, Math.min(at, Date.now()));
    // Stop on a progress note so the card shows the agent's narration, not a tool echo.
    if (spec.stopAtPct !== undefined && event.type === 'progress' && run.progressPct >= spec.stopAtPct) break;
  }
  if (spec.view) markViewed(spec.id);
  return getRun(spec.id)!;
}

async function main() {
  db.delete(schema.runEvents).run();
  db.delete(schema.runs).run();
  db.delete(schema.approvals).run();
  db.delete(schema.ledgerPostings).run();
  const artifactDir = path.join(process.cwd(), 'public', 'artifacts');
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, '.gitkeep'), '');

  for (const spec of SEEDS) {
    const run = await seedRun(spec);
    console.log(`${run.status.padEnd(13)} ${run.title}  (${run.progressPct}%${run.artifacts.length ? `, ${run.artifacts.length} artifacts` : ''})`);
  }

  // The deck's walkthrough: Vert has asked five questions and four are answered.
  // Answering the last one from the workflow page kicks off planning live.
  const fa = await startRun(
    {
      id: 'run_fixed_assets',
      title: 'Fixed Assets – April 2026 Close',
      client: 'Brevard Logistics',
      task: 'Create a workflow to build the April 2026 fixed asset depreciation schedule, identify misclassified capital expenditures, and draft the required journal entries for QBO.',
      createdAt: Date.now() - 4 * MIN,
    },
    provider,
  );
  const answers: [string, string][] = [
    ['fa_q1', 'USD'],
    ['fa_q2', 'Include all asset classes.'],
    ['fa_q3', 'Yes, there were 3 additions and 1 disposal.'],
    ['fa_q4', 'Straight-line for all asset classes.'],
  ];
  for (const [id, answer] of answers) await answerClarification(fa.id, id, answer, provider);
  console.log(`clarifying    ${fa.title}  (4 of 5 answered)`);
}

main().then(() => process.exit(0));
