import { and, asc, eq, gte, max } from 'drizzle-orm';
import { getDb, schema } from '@/lib/db';
import { applyEvent, emptyRun, type RunEvent, type RunSeed } from '@/lib/domain/reducer';
import { APPROVALS_REQUIRED, type RunView, type SpecialistName } from '@/lib/domain/types';

export type Listener = (runId: string, event: RunEvent, run: RunView) => void;

/** A run folded up to `seq`; `lastEventId` proves that event is still in the log. */
interface Projection {
  run: RunView;
  seq: number;
  lastEventId: number;
}

interface StoreState {
  listeners: Set<Listener>;
  locks: Map<string, Promise<void>>;
  projections: Map<string, Projection>;
}

declare global {
  // eslint-disable-next-line no-var
  var __vertStore: StoreState | undefined;
}

// On globalThis so Next's separate server bundles and HMR reloads share one set
// of listeners, locks and cached projections.
const state: StoreState = (globalThis.__vertStore ??= { listeners: new Set(), locks: new Map(), projections: new Map() });

/** Enough to keep every open run warm without holding the whole history in memory. */
const MAX_CACHED_PROJECTIONS = 500;

export function subscribe(fn: Listener): () => void {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export async function createRun(seed: {
  id: string;
  title: string;
  task: string;
  client?: string;
  agent: SpecialistName;
  createdAt?: number;
}): Promise<RunView> {
  const db = await getDb();
  const at = seed.createdAt ?? Date.now();
  const client = seed.client ?? '';
  await db
    .insert(schema.runs)
    .values({ id: seed.id, title: seed.title, task: seed.task, client, status: 'queued', agent: seed.agent, createdAt: at, updatedAt: at });
  return emptyRun({ ...seed, client, createdAt: at });
}

export type Append = (event: RunEvent, at?: number) => Promise<RunView>;

/**
 * Runs `fn` while holding the run's lock, with the run as it stands and an
 * `append` that writes the next event. Read-check-append sequences (state
 * machine guards, approvals) go through here so nothing interleaves with them
 * and `seq` stays gapless and ordered.
 */
export function withRunLock<T>(runId: string, fn: (run: RunView, append: Append) => Promise<T> | T): Promise<T> {
  return exclusive(runId, async () => {
    const initial = await project(runId);
    if (!initial) throw new Error(`Unknown run ${runId}`);
    let current = initial;
    let open = true;
    const append: Append = async (event, at = Date.now()) => {
      if (!open) throw new Error(`append for ${runId} was called after its lock was released.`);
      current = await write(runId, current, event, at);
      return current.run;
    };
    try {
      return await fn(current.run, append);
    } finally {
      open = false;
    }
  });
}

export function appendEvent(runId: string, event: RunEvent, at = Date.now()): Promise<RunView> {
  return withRunLock(runId, (_run, append) => append(event, at));
}

/** A run is a fold of its event log; nothing else holds its state. */
export async function getRun(runId: string): Promise<RunView | null> {
  return (await project(runId))?.run ?? null;
}

/** Folds the whole stored log from scratch, never touching the cache. Tests hold getRun to it. */
export async function replayRun(runId: string): Promise<RunView | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!row) return null;
  const events = await db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(asc(schema.runEvents.seq));
  return events.reduce((run, e) => applyEvent(run, e.payload, e.at), emptyRun(seedOf(row)));
}

export async function listRuns(): Promise<RunView[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.runs);
  const runs = await Promise.all(rows.map((r) => project(r.id, r)));
  return runs
    .filter((p): p is Projection => p !== null)
    .map((p) => p.run)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Drops every cached projection, e.g. after the tables were reset underneath us. */
export function forgetProjections(): void {
  state.projections.clear();
}

// ------------------------------------------------------------------ projection

type RunRow = typeof schema.runs.$inferSelect;

/**
 * Brings the cached fold up to date with any events after it. A cache whose last
 * event is no longer in the log (the run was reset) is thrown away and refolded.
 */
async function project(runId: string, known?: RunRow): Promise<Projection | null> {
  const db = await getDb();
  const row = known ?? (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0];
  if (!row) {
    state.projections.delete(runId);
    return null;
  }
  const cached = state.projections.get(runId);
  const events = await db
    .select({ id: schema.runEvents.id, seq: schema.runEvents.seq, payload: schema.runEvents.payload, at: schema.runEvents.at })
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gte(schema.runEvents.seq, cached?.seq ?? 0)))
    .orderBy(asc(schema.runEvents.seq));

  let base: Projection = { run: emptyRun(seedOf(row)), seq: 0, lastEventId: 0 };
  let tail = events;
  if (cached) {
    if (events[0]?.id !== cached.lastEventId) {
      state.projections.delete(runId);
      return project(runId, row);
    }
    base = cached;
    tail = events.slice(1);
  }
  const next = tail.reduce<Projection>(
    (p, e) => ({ run: applyEvent(p.run, e.payload, e.at), seq: e.seq, lastEventId: e.id }),
    base,
  );
  remember(runId, next);
  return next;
}

function seedOf(row: RunRow): RunSeed {
  return {
    id: row.id,
    title: row.title,
    task: row.task,
    client: row.client,
    agent: row.agent as SpecialistName,
    createdAt: row.createdAt,
  };
}

function remember(runId: string, p: Projection): void {
  // An empty log has no event to validate against, and is free to refold.
  if (p.seq === 0) return;
  const cached = state.projections.get(runId);
  // A slower reader must not replace a newer fold with an older one.
  if (cached && cached.seq > p.seq) return;
  state.projections.delete(runId);
  state.projections.set(runId, p);
  if (state.projections.size > MAX_CACHED_PROJECTIONS) {
    state.projections.delete(state.projections.keys().next().value!);
  }
}

/** Persists one event after `before` and returns the new fold. Caller holds the run lock. */
async function write(runId: string, before: Projection, event: RunEvent, at: number): Promise<Projection> {
  const db = await getDb();
  let written: { projection: Projection; event: RunEvent };
  try {
    written = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.runEvents)
        .values({ runId, seq: before.seq + 1, type: event.type, payload: event, at })
        .returning();
      // Fold the event as stored, so the cache is exactly what a replay would produce.
      const run = applyEvent(before.run, row.payload, row.at);
      await tx
        .update(schema.runs)
        .set({ status: run.status, agent: run.agent, updatedAt: row.at })
        .where(eq(schema.runs.id, runId));
      return { projection: { run, seq: row.seq, lastEventId: row.id }, event: row.payload };
    });
  } catch (err) {
    // Another process appended to this run (seq taken); our fold is stale.
    state.projections.delete(runId);
    throw err;
  }
  remember(runId, written.projection);
  for (const l of state.listeners) l(runId, written.event, written.projection.run);
  return written.projection;
}

/** A per-run async mutex: callers for one run queue in arrival order. */
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = state.locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => done);
  state.locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (state.locks.get(key) === tail) state.locks.delete(key);
  }
}

// ------------------------------------------------------------------ approvals and postings

let approvalSeq = 0;
export async function recordApproval(input: {
  runId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  decidedBy: string;
}): Promise<{ id: string }> {
  const db = await getDb();
  const id = `apr_${input.runId}_${Date.now().toString(36)}_${++approvalSeq}`;
  // findApproval reads decisions in time order, so two in the same millisecond
  // (a sign-off then a rejection) must still get distinct, ordered timestamps.
  const [{ last }] = await db
    .select({ last: max(schema.approvals.decidedAt) })
    .from(schema.approvals)
    .where(eq(schema.approvals.runId, input.runId));
  await db.insert(schema.approvals).values({
    id,
    runId: input.runId,
    decision: input.decision,
    reason: input.reason ?? null,
    decidedBy: input.decidedBy,
    decidedAt: Math.max(Date.now(), (last ?? 0) + 1),
  });
  return { id };
}

/**
 * The approval that clears a run to post — which exists only once two different
 * people have approved it. One sign-off, or the same person twice, is not enough.
 */
export async function findApproval(runId: string) {
  const rows = await approvalsFor(runId);
  // A rejection voids every sign-off before it; the reopened run starts from zero.
  const lastRejection = rows.map((r) => r.decision).lastIndexOf('rejected');
  const current = rows.slice(lastRejection + 1).filter((r) => r.decision === 'approved');
  const approvers = new Set(current.map((r) => r.decidedBy));
  if (approvers.size < APPROVALS_REQUIRED) return null;
  const last = current[current.length - 1];
  return { id: last.id, runId: last.runId, decision: 'approved' as const, decidedBy: [...approvers].join(' + ') };
}

export async function approvalsFor(runId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.runId, runId))
    .orderBy(asc(schema.approvals.decidedAt), asc(schema.approvals.id));
}

let postingSeq = 0;
/** Records a post against its approval. A repeated `idempotencyKey` returns the original posting. */
export async function recordPosting(input: {
  runId: string;
  approvalId: string;
  memo: string;
  amountCents: number;
  provider?: string;
  externalId?: string;
  idempotencyKey?: string;
}): Promise<{ id: string }> {
  const db = await getDb();
  const id = `post_${input.runId}_${Date.now().toString(36)}_${++postingSeq}`;
  const inserted = await db
    .insert(schema.ledgerPostings)
    .values({
      id,
      runId: input.runId,
      approvalId: input.approvalId,
      memo: input.memo,
      amountCents: input.amountCents,
      postedAt: Date.now(),
      provider: input.provider ?? null,
      externalId: input.externalId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing({ target: schema.ledgerPostings.idempotencyKey })
    .returning({ id: schema.ledgerPostings.id });
  if (inserted.length) return inserted[0];
  const [existing] = await db
    .select({ id: schema.ledgerPostings.id })
    .from(schema.ledgerPostings)
    .where(eq(schema.ledgerPostings.idempotencyKey, input.idempotencyKey!));
  return existing;
}

export async function listPostings(runId?: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.ledgerPostings)
    .where(runId ? eq(schema.ledgerPostings.runId, runId) : undefined)
    .orderBy(asc(schema.ledgerPostings.postedAt), asc(schema.ledgerPostings.id));
}
