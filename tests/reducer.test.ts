import { describe, expect, it } from 'vitest';
import { applyEvent, emptyRun, replay, columnFor, type RunEvent } from '@/lib/domain/reducer';
import type { Step } from '@/lib/domain/types';

const seed = { id: 'run_1', title: 'Book Payroll Journal Entry', task: 'book payroll', agent: 'LedgerAgent' as const, createdAt: 1000 };
const steps: Step[] = [
  { id: 's1', title: 'Pull register', agent: 'LedgerAgent', tools: ['fetchSubledger'], status: 'pending' },
  { id: 's2', title: 'Draft entry', agent: 'LedgerAgent', tools: ['fetchTrialBalance'], status: 'pending' },
];

const log: { event: RunEvent; at: number }[] = [
  { event: { type: 'plan_created', steps }, at: 1001 },
  { event: { type: 'step_started', stepId: 's1', agent: 'LedgerAgent' }, at: 1002 },
  { event: { type: 'progress', stepId: 's1', pct: 20, note: 'Importing payroll register…' }, at: 1003 },
  { event: { type: 'step_completed', stepId: 's1' }, at: 1004 },
  { event: { type: 'step_started', stepId: 's2', agent: 'LedgerAgent' }, at: 1005 },
  { event: { type: 'step_completed', stepId: 's2' }, at: 1006 },
  { event: { type: 'run_completed', summary: 'Entry drafted.' }, at: 1007 },
];

describe('run projection', () => {
  it('replays an event log into the same state every time', () => {
    const a = replay(seed, log);
    const b = replay(seed, log);
    expect(a).toEqual(b);
    expect(a.status).toBe('review_ready');
    expect(a.progressPct).toBe(100);
    expect(a.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('is incremental: replaying a prefix then the tail matches a full replay', () => {
    const prefix = replay(seed, log.slice(0, 4));
    const tail = log.slice(4).reduce((r, e) => applyEvent(r, e.event, e.at), prefix);
    expect(tail).toEqual(replay(seed, log));
  });

  it('never lets progress run backwards', () => {
    let run = emptyRun(seed);
    run = applyEvent(run, { type: 'progress', stepId: 's1', pct: 60, note: 'a' });
    run = applyEvent(run, { type: 'progress', stepId: 's1', pct: 10, note: 'b' });
    expect(run.progressPct).toBe(60);
  });

  it('shows the live agent note as the card description', () => {
    const run = replay(seed, log.slice(0, 3));
    expect(run.description).toBe('Importing payroll register…');
  });

  it('clears the blocker when a run is unblocked', () => {
    let run = replay(seed, log.slice(0, 2));
    run = applyEvent(run, {
      type: 'blocked',
      blocker: {
        id: 'b1',
        stepId: 's1',
        reason: 'missing_document',
        title: 'Missing receiving report',
        detail: 'Upload it.',
        resolution: { kind: 'upload_file', label: 'Upload' },
      },
    });
    expect(run.status).toBe('blocked');
    expect(run.steps[0].status).toBe('blocked');
    run = applyEvent(run, { type: 'unblocked' });
    expect(run.status).toBe('executing');
    expect(run.blocker).toBeNull();
  });

  it('maps statuses onto the four board columns', () => {
    expect(columnFor('executing')).toBe('in_progress');
    expect(columnFor('blocked')).toBe('needs_attention');
    expect(columnFor('review_ready')).toBe('ready_for_review');
    expect(columnFor('viewed')).toBe('viewed');
  });
});
