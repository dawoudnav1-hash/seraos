import { routeTask, SPECIALIST_REGISTRY } from './specialists';
import { getProvider, type AgentProvider } from './provider';
import { TOOLS } from './tools';
import { ApprovalRequiredError, type ApprovalRecord, type ToolContext, type ToolResult } from './tools/types';
import { createRun, findApproval, getRun, recordApproval, recordPosting, withRunLock } from './store';
import { assertTransition } from '@/lib/domain/state-machine';
import type { AgentEvent, RunView, SpecialistName, ToolName } from '@/lib/domain/types';
import { CURRENT_USER, person } from '@/lib/domain/people';

export interface StartRunInput {
  title: string;
  task: string;
  client?: string;
  specialist?: SpecialistName;
  id?: string;
  createdAt?: number;
  /** Fed back from a rejection so the agent knows what to redo. */
  instruction?: string;
}

let runSeq = 0;
export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${++runSeq}`;
}

/**
 * Tools see the approval as it stood when the call began: the gate stays
 * synchronous for tools, and the lookup happens here once per call.
 */
function toolContext(runId: string, stepId: string, approval: ApprovalRecord | null): ToolContext {
  return { runId, stepId, approvals: { find: (id) => (id === runId ? approval : null) } };
}

/**
 * Executes one tool on behalf of an agent. Two rules hold regardless of provider:
 * the specialist must declare the tool, and mutating tools need a human approval.
 */
export async function callTool(
  runId: string,
  specialist: SpecialistName,
  stepId: string,
  tool: ToolName,
  args: unknown,
): Promise<ToolResult> {
  const spec = SPECIALIST_REGISTRY[specialist];
  if (!spec.tools.includes(tool)) {
    throw new Error(`${specialist} may not call ${tool}.`);
  }
  const impl = TOOLS[tool] as { mutating: boolean; run(a: never, c: ToolContext): Promise<ToolResult> };
  const approval = await findApproval(runId);
  if (impl.mutating && !approval) throw new ApprovalRequiredError(tool, runId);
  const result = await impl.run(args as never, toolContext(runId, stepId, approval));
  if (tool === 'postJournalEntry' && result.ok) {
    const data = result.data as { amountCents: number };
    await recordPosting({ runId, approvalId: approval!.id, memo: (args as { memo: string }).memo, amountCents: data.amountCents });
  }
  return result;
}

/** A run that exists (or has resumed) and keeps driving in the background until `done`. */
export interface Driving {
  run: RunView;
  done: Promise<RunView>;
}

/** Kicks off a run and drives its event stream to completion or a blocker. */
export async function startRun(input: StartRunInput, provider?: AgentProvider): Promise<RunView> {
  return (await beginRun(input, provider)).done;
}

/** Creates the run and returns as soon as it exists; the agent keeps working in `done`. */
export async function beginRun(input: StartRunInput, provider?: AgentProvider): Promise<Driving> {
  const specialist = input.specialist ?? routeTask(`${input.title} ${input.task}`);
  const id = input.id ?? newRunId();
  const run = await createRun({ id, title: input.title, task: input.task, client: input.client, agent: specialist, createdAt: input.createdAt });
  return { run, done: background(drive(id, specialist, input.task, input.title, provider, input.instruction)) };
}

/** Resumes a run whose blocker a human has cleared. */
export async function resumeRun(runId: string, provider?: AgentProvider): Promise<RunView> {
  return (await beginResume(runId, provider)).done;
}

/** Records the unblock and returns; the agent picks the work back up in `done`. */
export async function beginResume(runId: string, provider?: AgentProvider): Promise<Driving> {
  const { run, resolved } = await withRunLock(runId, async (before, append) => {
    const resolved = before.blocker ? [before.blocker.id] : [];
    assertTransition(before.status, 'executing', 'orchestrator');
    return { run: await append({ type: 'unblocked' }), resolved };
  });
  const done = drive(runId, run.agent, run.task, run.title, provider, run.rejectionReason ?? undefined, resolved);
  return { run, done: background(done) };
}

/** Marks a drive as handled so a caller that never awaits it does not crash the process. */
function background(done: Promise<RunView>): Promise<RunView> {
  // Failures inside a drive are already on the event log as run_failed.
  done.catch(() => undefined);
  return done;
}

async function drive(
  runId: string,
  specialist: SpecialistName,
  task: string,
  title: string,
  provider?: AgentProvider,
  instruction?: string,
  resolvedBlockerIds: string[] = [],
): Promise<RunView> {
  const p = provider ?? (await getProvider());
  let latest = await requireRun(runId);
  const answers = Object.fromEntries(
    latest.clarifications.filter((q) => q.answer !== null).map((q) => [q.id, q.answer as string]),
  );
  try {
    const stream = p.runAgent({
      runId,
      task,
      title,
      specialist,
      instruction,
      resolvedBlockerIds,
      answers,
      contextFiles: latest.contextFiles,
      callTool: (stepId, tool, args) => callTool(runId, specialist, stepId, tool, args),
    });
    for await (const event of stream) {
      latest = await persist(runId, event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    latest = await persist(runId, { type: 'run_failed', error: message });
  }
  return latest;
}

/** Applies an agent event after checking the state machine allows it. */
function persist(runId: string, event: AgentEvent): Promise<RunView> {
  // Check and append under one lock, so a human action cannot land in between.
  return withRunLock(runId, (before, append) => {
    const target = targetStatus(event);
    if (target && target !== before.status) {
      assertTransition(before.status, target, 'orchestrator');
    }
    return append(event);
  });
}

function targetStatus(event: AgentEvent) {
  switch (event.type) {
    case 'clarification_requested':
      return 'clarifying' as const;
    case 'plan_created':
      return 'planning' as const;
    case 'step_started':
    case 'unblocked':
      return 'executing' as const;
    case 'blocked':
      return 'blocked' as const;
    case 'run_completed':
      return 'review_ready' as const;
    case 'run_failed':
      return 'failed' as const;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- human gates

export function markViewed(runId: string): Promise<RunView> {
  return withRunLock(runId, (run, append) => {
    if (run.status !== 'review_ready') return run;
    assertTransition(run.status, 'viewed', 'human');
    return append({ type: 'human_viewed' });
  });
}

/**
 * One sign-off. The run finalizes only when a second, different approver signs
 * too — the same person approving twice is refused.
 */
export function approveRun(runId: string, approver: { name: string; role: string } = CURRENT_USER): Promise<RunView> {
  // Under the run lock, so a double click cannot pass the same-person check twice.
  return withRunLock(runId, async (run, append) => {
    assertTransition(run.status, 'approved', 'human');
    const who = person(approver.name);
    if (who && !who.canApprove) throw new Error(`${who.name} is a ${who.role} and cannot approve workpapers.`);
    if (run.approvals.some((a) => a.by === approver.name)) {
      throw new Error(`${approver.name} has already approved this. A second, different reviewer must sign off.`);
    }
    await recordApproval({ runId, decision: 'approved', decidedBy: approver.name });
    return append({ type: 'human_approved', by: approver.name, role: approver.role });
  });
}

/** Records a human answer; once every question is answered the run plans and executes. */
export async function answerClarification(
  runId: string,
  questionId: string,
  answer: string,
  provider?: AgentProvider,
): Promise<RunView> {
  if (!answer.trim()) throw new Error('Type an answer before sending.');
  const next = await withRunLock(runId, (run, append) => {
    if (run.status !== 'clarifying') throw new Error('This workflow is not waiting on clarifications.');
    const q = run.clarifications.find((c) => c.id === questionId);
    if (!q) throw new Error(`Unknown question ${questionId}.`);
    if (q.answer !== null) throw new Error('That question is already answered.');
    return append({ type: 'clarification_answered', questionId, answer: answer.trim() });
  });
  // Drive outside the lock: driving appends events of its own.
  if (next.clarifications.every((c) => c.answer !== null)) {
    return drive(runId, next.agent, next.task, next.title, provider);
  }
  return next;
}

export function uploadContext(runId: string, filename: string): Promise<RunView> {
  return withRunLock(runId, (_run, append) => append({ type: 'context_uploaded', filename }));
}

export async function rejectRun(runId: string, reason: string, decidedBy = CURRENT_USER.name): Promise<RunView> {
  if (!reason.trim()) throw new Error('A rejection needs a reason — it becomes the agent’s next instruction.');
  return withRunLock(runId, async (run, append) => {
    assertTransition(run.status, 'rejected', 'human');
    await recordApproval({ runId, decision: 'rejected', reason, decidedBy });
    return append({ type: 'human_rejected', reason, by: decidedBy });
  });
}

/** Rejecting reopens the run with the reason as a fresh instruction. */
export async function reopenRun(runId: string, provider?: AgentProvider): Promise<RunView> {
  const run = await requireRun(runId);
  assertTransition(run.status, 'planning', 'orchestrator');
  return drive(runId, run.agent, `${run.task}\n\nReviewer feedback: ${run.rejectionReason ?? ''}`, run.title, provider, run.rejectionReason ?? undefined);
}

export function sendBack(runId: string, note: string): Promise<RunView> {
  return withRunLock(runId, (run, append) => {
    assertTransition(run.status, 'blocked', 'human');
    return append({ type: 'human_blocked', note });
  });
}

export function archiveRun(runId: string): Promise<RunView> {
  return withRunLock(runId, (run, append) => {
    assertTransition(run.status, 'archived', 'human');
    return append({ type: 'human_archived' });
  });
}

async function requireRun(runId: string): Promise<RunView> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  return run;
}

export { getRun, listRuns, subscribe } from './store';
