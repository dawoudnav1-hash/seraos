import { beforeAll, describe, expect, it } from 'vitest';
import { useTempDb } from './setup-db';

useTempDb('orchestrator');

const { startRun, resumeRun, markViewed, approveRun, rejectRun, reopenRun, callTool, getRun } = await import(
  '@/lib/agents/orchestrator'
);
const { listPostings } = await import('@/lib/agents/store');
const { MockProvider } = await import('@/lib/agents/providers/mock');
const { SPECIALIST_REGISTRY } = await import('@/lib/agents/specialists');
const { ApprovalRequiredError } = await import('@/lib/agents/tools/types');

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
    expect(getRun(run.id)).toEqual(run);
  });

  it('runs an ad-hoc task within the routed specialist’s declared toolset', async () => {
    const run = await startRun(
      { title: 'Reconcile the operating bank account for November', task: 'Reconcile the operating bank account for November.' },
      provider,
    );
    expect(run.agent).toBe('ReconciliationAgent');
    expect(run.status).toBe('review_ready');
    const declared = SPECIALIST_REGISTRY.ReconciliationAgent.tools;
    expect(run.steps.flatMap((s) => s.tools).every((t) => declared.includes(t))).toBe(true);
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
        memo: 'Payroll 11/15/2025',
        lines: [
          { account: '6000', debitCents: 31_900_000, creditCents: 0 },
          { account: '2000', debitCents: 0, creditCents: 31_900_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(listPostings(run.id)).toHaveLength(0);
  });

  it('posts only after a human approves, and records the approval against the posting', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    markViewed(run.id);
    approveRun(run.id);
    const result = await callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
      memo: 'Payroll 11/15/2025',
      lines: [
        { account: '6000', debitCents: 31_900_000, creditCents: 0 },
        { account: '2000', debitCents: 0, creditCents: 31_900_000 },
      ],
    });
    expect(result.ok).toBe(true);
    const postings = listPostings(run.id);
    expect(postings).toHaveLength(1);
    expect(postings[0].amountCents).toBe(31_900_000);
    expect(postings[0].approvalId).toMatch(/^apr_/);
  });

  it('refuses an unbalanced entry even when approved', async () => {
    const run = await startRun({ title: 'Book Payroll Journal Entry', task: 'Book the payroll journal entry.' }, provider);
    markViewed(run.id);
    approveRun(run.id);
    const result = await callTool(run.id, 'LedgerAgent', run.steps[0].id, 'postJournalEntry', {
      memo: 'Lopsided',
      lines: [
        { account: '6000', debitCents: 100, creditCents: 0 },
        { account: '2000', debitCents: 0, creditCents: 90 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(listPostings(run.id)).toHaveLength(0);
  });

  it('cannot approve a run the human has not opened', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    expect(() => approveRun(run.id)).toThrow(/review it before approving/);
  });

  it('feeds a rejection reason back as the next instruction and reopens the run', async () => {
    const run = await startRun({ title: 'Cash forecast', task: 'Prepare a 13-week cash flow projection.' }, provider);
    markViewed(run.id);
    expect(() => rejectRun(run.id, '   ')).toThrow(/needs a reason/);
    const rejected = rejectRun(run.id, 'Use a 12-month burn average, not trailing 3.');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toMatch(/12-month burn/);
    const reopened = await reopenRun(run.id, provider);
    expect(reopened.status).toBe('review_ready');
  });
});
