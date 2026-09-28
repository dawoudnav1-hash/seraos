import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from './setup-db';

await useTestDb();

const { startRun, resumeRun, markViewed, approveRun, rejectRun, reopenRun, callTool, getRun, answerClarification, uploadContext } =
  await import('@/lib/agents/orchestrator');
const { listPostings, replayRun } = await import('@/lib/agents/store');
const { MockProvider } = await import('@/lib/agents/providers/mock');
const { SPECIALIST_REGISTRY } = await import('@/lib/agents/specialists');
const { ApprovalRequiredError } = await import('@/lib/agents/tools/types');

const ALEX = { name: 'Alex Morgan', role: 'Finance Manager' };
const JORDAN = { name: 'Jordan Lee', role: 'Controller' };

/** Mark for review and collect both sign-offs. */
async function doubleApprove(runId: string) {
  await markViewed(runId);
  await approveRun(runId, ALEX);
  return approveRun(runId, JORDAN);
}

const provider = new MockProvider({ tickMs: 0 });

describe('orchestrator', () => {
  it('plans, executes and lands a run in review_ready with real artifacts', async () => {
    const run = await startRun(
      { title: 'Prepare 13-Week Cash Flow Projection', task: 'Prepare a 13-week cash flow projection and runway.' },
      provider,
    );
    expect(run.status).toBe('review_ready');
    expect(run.agent).toBe('CashAgent');
    expect(run.steps).toHaveLength(3);
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true);
    expect(run.artifacts[0].filename).toBe('Cash_Flow_13_Week_Projection.xlsx');
    expect(run.artifacts[0].sizeBytes).toBeGreaterThan(1000);
  });

  it('stops on a structured blocker instead of guessing', async () => {
    const run = await startRun(
      { title: 'Perform Three-Way Match', task: 'Perform a three-way match for PO 44872.' },
      provider,
    );
    expect(run.status).toBe('blocked');
    expect(run.blocker?.reason).toBe('missing_document');
    expect(run.blocker?.resolution.kind).toBe('upload_file');
    expect(run.blocker?.resolution.secondaryLabel).toBe('Confirm goods receipt');
    expect(run.progressPct).toBeLessThan(100);
  });

  it('resumes past a resolved blocker and finishes', async () => {
    const blocked = await startRun(
      { title: 'Perform Three-Way Match', task: 'Perform a three-way match for PO 44872.' },
      provider,
    );
    const resumed = await resumeRun(blocked.id, provider);
    expect(resumed.status).toBe('review_ready');
    expect(resumed.blocker).toBeNull();
  });

  it('routes a low-confidence agent to blocked, never to review', async () => {
    const run = await startRun(
      { title: 'FY24 Revenue Recognition Memo (ASC 606)', task: 'Write an ASC 606 revenue recognition memo.' },
      provider,
    );
    expect(run.status).toBe('blocked');
    expect(run.blocker?.reason).toBe('low_confidence');
  });

  it('records provenance for every figure it reports', async () => {
    const run = await startRun(
      { title: 'Review Financial Statements for Quality Control', task: 'Quality control review, tie footings.' },
      provider,
    );
    expect(run.provenance.length).toBeGreaterThan(0);
    const footing = run.provenance.find((p) => p.label === 'Total debits');
    expect(footing?.value).toBe('$47,200,000');
    expect(footing?.tool).toBe('fetchTrialBalance');
    expect(footing?.stepId).toBeTruthy();
  });

  it('reconstructs identical state from the persisted event log', async () => {
    const run = await startRun(
      { title: 'Create Monthly Reporting Pack for Board Review', task: 'Build the board reporting pack.' },
      provider,
    );
    expect(await getRun(run.id)).toEqual(run);
    // And from a cold fold of the stored log, not the cached projection.
    expect(await replayRun(run.id)).toEqual(run);
  });

  it('runs an ad-hoc task within the routed specialist’s declared toolset', async () => {
    const run = await startRun(
      { title: 'Reconcile the operating bank account for November', task: 'Reconcile the operating bank account for November.' },
      provider,
    );
    expect(run.agent).toBe('ReconciliationAgent');
    // New ad-hoc work clarifies before it plans.
    expect(run.status).toBe('clarifying');
    let latest = run;
    for (const [id, answer] of [
      ['gen_q1', 'November 2025'],
      ['gen_q2', 'Operating checking only'],
      ['gen_q3', 'A reconciliation workbook'],
    ])
      latest = await answerClarification(run.id, id, answer, provider);
    expect(latest.status).toBe('review_ready');
    expect(latest.assumptions).toContain('Taken from your answer: November 2025');
    const declared = SPECIALIST_REGISTRY.ReconciliationAgent.tools;
    expect(latest.steps.flatMap((s) => s.tools).every((t) => declared.includes(t))).toBe(true);
  });

  it('refuses a tool the specialist has not declared', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    await expect(callTool(run.id, 'CashAgent', run.steps[0].id, 'renderPdf', { filename: 'x.pdf', title: 'x', body: [] })).rejects.toThrow(
      /may not call renderPdf/,
    );
  });
});

describe('approval gate', () => {
  it('will not post a journal entry for an unapproved run', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    expect(run.status).toBe('review_ready');
    await expect(
      callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
        memo: 'Payroll 1/31/2025',
        lines: [
          { account: '6000', debitCents: 31_200_000, creditCents: 0 },
          { account: '2000', debitCents: 0, creditCents: 31_200_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(await listPostings(run.id)).toHaveLength(0);
  });

  it('posts only after a human approves, and records the approval against the posting', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    expect((await doubleApprove(run.id)).status).toBe('approved');
    const result = await callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
      memo: 'Payroll 1/31/2025',
      lines: [
        { account: '6000', debitCents: 31_200_000, creditCents: 0 },
        { account: '2000', debitCents: 0, creditCents: 31_200_000 },
      ],
    });
    expect(result.ok).toBe(true);
    const postings = await listPostings(run.id);
    expect(postings).toHaveLength(1);
    expect(postings[0].amountCents).toBe(31_200_000);
    expect(postings[0].approvalId).toMatch(/^apr_/);
  });

  it('refuses an unbalanced entry even when approved', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    expect((await doubleApprove(run.id)).status).toBe('approved');
    const result = await callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
      memo: 'Lopsided',
      lines: [
        { account: '6000', debitCents: 100, creditCents: 0 },
        { account: '2000', debitCents: 0, creditCents: 90 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(await listPostings(run.id)).toHaveLength(0);
  });

  it('will not post on a single approval, or on the same person approving twice', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    await markViewed(run.id);
    const once = await approveRun(run.id, ALEX);
    expect(once.status).toBe('viewed');
    expect(once.approvals).toHaveLength(1);
    await expect(approveRun(run.id, ALEX)).rejects.toThrow(/second, different reviewer/);
    const entry = {
      memo: 'Payroll 1/31/2025',
      lines: [
        { account: '6000', debitCents: 31_200_000, creditCents: 0 },
        { account: '2000', debitCents: 0, creditCents: 31_200_000 },
      ],
    };
    await expect(callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', entry)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect((await approveRun(run.id, JORDAN)).status).toBe('approved');
    expect((await callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', entry)).ok).toBe(true);
  });

  it('refuses approval from someone who is not an approver', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    await markViewed(run.id);
    await expect(approveRun(run.id, { name: 'Brian Torres', role: 'Staff Accountant' })).rejects.toThrow(/cannot approve/);
  });

  it('voids earlier sign-offs when a run is rejected and reopened', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    await markViewed(run.id);
    await approveRun(run.id, ALEX);
    await rejectRun(run.id, 'Split the 401(k) match onto its own line.', JORDAN.name);
    const reopened = await reopenRun(run.id, provider);
    expect(reopened.status).toBe('review_ready');
    expect(reopened.approvals).toHaveLength(0);
    await markViewed(run.id);
    await approveRun(run.id, JORDAN);
    await expect(
      callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
        memo: 'Payroll',
        lines: [
          { account: '6000', debitCents: 100, creditCents: 0 },
          { account: '2000', debitCents: 0, creditCents: 100 },
        ],
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('cannot approve a run the human has not opened', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    await expect(approveRun(run.id)).rejects.toThrow(/review it before approving/);
  });

  it('feeds a rejection reason back as the next instruction and reopens the run', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    await markViewed(run.id);
    await expect(rejectRun(run.id, '   ')).rejects.toThrow(/needs a reason/);
    const rejected = await rejectRun(run.id, 'Use a 12-month burn average, not trailing 3.');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toMatch(/12-month burn/);
    const reopened = await reopenRun(run.id, provider);
    expect(reopened.status).toBe('review_ready');
  });
});

describe('clarification before planning', () => {
  const FA = { title: 'Fixed Assets – April 2026 Close', task: 'Build the April 2026 fixed asset depreciation schedule.', client: 'Brevard Logistics' };
  const ANSWERS: [string, string][] = [
    ['fa_q1', 'USD'],
    ['fa_q2', 'Include all asset classes.'],
    ['fa_q3', 'Yes, there were 3 additions and 1 disposal.'],
    ['fa_q4', 'Straight-line for all asset classes.'],
    ['fa_q5', 'Use the standard mappings in our ERP.'],
  ];

  it('asks its questions and does nothing else until they are answered', async () => {
    const run = await startRun(FA, provider);
    expect(run.status).toBe('clarifying');
    expect(run.clarifications).toHaveLength(5);
    expect(run.steps).toHaveLength(0);
    expect(run.client).toBe('Brevard Logistics');
    for (const [id, answer] of ANSWERS.slice(0, 4)) {
      const next = await answerClarification(run.id, id, answer, provider);
      expect(next.status).toBe('clarifying');
    }
    await expect(answerClarification(run.id, 'fa_q5', '   ', provider)).rejects.toThrow(/Type an answer/);
  });

  it('plans, executes and hands in workpapers once the last answer lands', async () => {
    const run = await startRun(FA, provider);
    await uploadContext(run.id, 'FA_Register_March_2026.xlsx');
    let latest = run;
    for (const [id, answer] of ANSWERS) latest = await answerClarification(run.id, id, answer, provider);
    expect(latest.status).toBe('review_ready');
    expect(latest.contextFiles).toEqual(['FA_Register_March_2026.xlsx']);
    expect(latest.steps.map((s) => s.title)).toEqual([
      'Inputs & Parameters',
      'Identify Misclassified Capital Expenditures',
      'Build April 2026 Depreciation Schedule',
      'Draft Reclassification Journal Entries',
      'Draft Depreciation Journal Entry',
      'Review & Finalize',
    ]);
    expect(latest.artifacts.map((a) => a.kind)).toEqual(['xlsx', 'docx']);
    expect(latest.artifacts[0].sheets?.map((s) => s.name)).toEqual(['Depreciation_Schedule', 'Dispositions', 'Summary', 'Journal_Entries']);
    const state = latest.tables.find((t) => t.id === 'fa_current_state')!;
    expect(state.rows.at(-1)!.cells).toEqual(['Total Fixed Assets', '$59,299.55', '($1,848.14)', '$57,451.41']);
    expect(latest.findings.length).toBeGreaterThan(0);
    expect(latest.assumptions[0]).toMatch(/USD/);
    expect(await getRun(run.id)).toEqual(latest);
    expect(await replayRun(run.id)).toEqual(latest);
  });

  it('drafts entries but never posts them', async () => {
    const run = await startRun(FA, provider);
    for (const [id, answer] of ANSWERS) await answerClarification(run.id, id, answer, provider);
    expect(await listPostings(run.id)).toHaveLength(0);
  });
});
