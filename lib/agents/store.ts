import { asc, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { applyEvent, emptyRun, type RunEvent, type RunSeed } from '@/lib/domain/reducer';
import { APPROVALS_REQUIRED, type RunView, type SpecialistName } from '@/lib/domain/types';

export type Listener = (runId: string, event: RunEvent, run: RunView) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function createRun(seed: {
  id: string;
  title: string;
  task: string;
  client?: string;
  agent: SpecialistName;
  createdAt?: number;
}): RunView {
  const at = seed.createdAt ?? Date.now();
  const client = seed.client ?? '';
  db.insert(schema.runs)
    .values({ id: seed.id, title: seed.title, task: seed.task, client, status: 'queued', agent: seed.agent, createdAt: at, updatedAt: at })
    .run();
  return emptyRun({ ...seed, client, createdAt: at });
}

export function appendEvent(runId: string, event: RunEvent, at = Date.now()): RunView {
  const rows = db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId)).all();
  const seq = rows.length + 1;
  db.insert(schema.runEvents).values({ runId, seq, type: event.type, payload: JSON.stringify(event), at }).run();
  const run = getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  db.update(schema.runs).set({ status: run.status, agent: run.agent, updatedAt: at }).where(eq(schema.runs.id, runId)).run();
  for (const l of listeners) l(runId, event, run);
  return run;
}

/** Rebuilds a run purely from its event log — no state lives anywhere else. */
export function getRun(runId: string): RunView | null {
  const row = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!row) return null;
  const seed: RunSeed = {
    id: row.id,
    title: row.title,
    task: row.task,
    client: row.client,
    agent: row.agent as SpecialistName,
    createdAt: row.createdAt,
  };
  const events = db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(asc(schema.runEvents.seq))
    .all();
  return events.reduce(
    (run, e) => applyEvent(run, JSON.parse(e.payload) as RunEvent, e.at),
    emptyRun(seed),
  );
}

export function listRuns(): RunView[] {
  const rows = db.select().from(schema.runs).all();
  return rows
    .map((r) => getRun(r.id))
    .filter((r): r is RunView => r !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

let approvalSeq = 0;
export function recordApproval(input: {
  runId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  decidedBy: string;
}): { id: string } {
  const id = `apr_${input.runId}_${Date.now().toString(36)}_${++approvalSeq}`;
  db.insert(schema.approvals)
    .values({
      id,
      runId: input.runId,
      decision: input.decision,
      reason: input.reason ?? null,
      decidedBy: input.decidedBy,
      decidedAt: Date.now(),
    })
    .run();
  return { id };
}

/**
 * The approval that clears a run to post — which exists only once two different
 * people have approved it. One sign-off, or the same person twice, is not enough.
 */
export function findApproval(runId: string) {
  const rows = db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId)).all();
  // A rejection voids every sign-off before it; the reopened run starts from zero.
  const lastRejection = rows.map((r) => r.decision).lastIndexOf('rejected');
  const current = rows.slice(lastRejection + 1).filter((r) => r.decision === 'approved');
  const approvers = new Set(current.map((r) => r.decidedBy));
  if (approvers.size < APPROVALS_REQUIRED) return null;
  const last = current[current.length - 1];
  return { id: last.id, runId: last.runId, decision: 'approved' as const, decidedBy: [...approvers].join(' + ') };
}

export function approvalsFor(runId: string) {
  return db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId)).all();
}

export function recordPosting(input: { runId: string; approvalId: string; memo: string; amountCents: number }) {
  const id = `post_${input.runId}_${Date.now().toString(36)}`;
  db.insert(schema.ledgerPostings)
    .values({ id, runId: input.runId, approvalId: input.approvalId, memo: input.memo, amountCents: input.amountCents, postedAt: Date.now() })
    .run();
  return { id };
}

export function listPostings(runId?: string) {
  const rows = db.select().from(schema.ledgerPostings).all();
  return runId ? rows.filter((r) => r.runId === runId) : rows;
}
