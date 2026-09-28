import { routeTask, SPECIALIST_REGISTRY } from './specialists';
import { getProvider, type AgentProvider } from './provider';
import { TOOLS } from './tools';
import { ApprovalRequiredError, type ToolContext, type ToolResult } from './tools/types';
import { appendEvent, createRun, findApproval, getRun, recordApproval, recordPosting } from './store';
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

const approvalGate = { find: findApproval };

function toolContext(runId: string, stepId: string): ToolContext {
  return { runId, stepId, approvals: approvalGate };
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
  if (impl.mutating) {
    const approval = findApproval(runId);
    if (!approval) throw new ApprovalRequiredError(tool, runId);
  }
  const result = await impl.run(args as never, toolContext(runId, stepId));
  if (tool === 'postJournalEntry' && result.ok) {
    const approval = findApproval(runId)!;
    const data = result.data as { amountCents: number };
    recordPosting({ runId, approvalId: approval.id, memo: (args as { memo: string }).memo, amountCents: data.amountCents });
  }
  return result;
}

/** Kicks off a run and drives its event stream to completion or a blocker. */
export async function startRun(input: StartRunInput, provider?: AgentProvider): Promise<RunView> {
  const specialist = input.specialist ?? routeTask(`${input.title} ${input.task}`);
  const id = input.id ?? newRunId();
  createRun({ id, title: input.title, task: input.task, client: input.client, agent: specialist, createdAt: input.createdAt });
  return drive(id, specialist, input.task, input.title, provider, input.instruction);
}

/** Resumes a run whose blocker a human has cleared. */
export async function resumeRun(runId: string, provider?: AgentProvider): Promise<RunView> {
  const run = getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const resolved = run.blocker ? [run.blocker.id] : [];
  assertTransition(run.status, 'executing', 'orchestrator');
  appendEvent(runId, { type: 'unblocked' });
  return drive(runId, run.agent, run.task, run.title, provider, run.rejectionReason ?? undefined, resolved);
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
  let latest = getRun(runId)!;
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
      latest = persist(runId, event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    latest = persist(runId, { type: 'run_failed', error: message });
  }
  return latest;
}

/** Applies an agent event after checking the state machine allows it. */
function persist(runId: string, event: AgentEvent): RunView {
  const before = getRun(runId)!;
  const target = targetStatus(event);
  if (target && target !== before.status) {
    assertTransition(before.status, target, 'orchestrator');
  }
  return appendEvent(runId, event);
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

export function markViewed(runId: string): RunView {
  const run = requireRun(runId);
  if (run.status !== 'review_ready') return run;
  assertTransition(run.status, 'viewed', 'human');
  return appendEvent(runId, { type: 'human_viewed' });
}

/**
 * One sign-off. The run finalizes only when a second, different approver signs
 * too — the same person approving twice is refused.
 */
export function approveRun(runId: string, approver: { name: string; role: string } = CURRENT_USER): RunView {
  const run = requireRun(runId);
  assertTransition(run.status, 'approved', 'human');
  const who = person(approver.name);
  if (who && !who.canApprove) throw new Error(`${who.name} is a ${who.role} and cannot approve workpapers.`);
  if (run.approvals.some((a) => a.by === approver.name)) {
    throw new Error(`${approver.name} has already approved this. A second, different reviewer must sign off.`);
  }
  recordApproval({ runId, decision: 'approved', decidedBy: approver.name });
  return appendEvent(runId, { type: 'human_approved', by: approver.name, role: approver.role });
}

/** Records a human answer; once every question is answered the run plans and executes. */
export async function answerClarification(
  runId: string,
  questionId: string,
  answer: string,
  provider?: AgentProvider,
): Promise<RunView> {
  if (!answer.trim()) throw new Error('Type an answer before sending.');
  const run = requireRun(runId);
  if (run.status !== 'clarifying') throw new Error('This workflow is not waiting on clarifications.');
  const q = run.clarifications.find((c) => c.id === questionId);
  if (!q) throw new Error(`Unknown question ${questionId}.`);
  if (q.answer !== null) throw new Error('That question is already answered.');
  const next = appendEvent(runId, { type: 'clarification_answered', questionId, answer: answer.trim() });
  if (next.clarifications.every((c) => c.answer !== null)) {
    return drive(runId, next.agent, next.task, next.title, provider);
  }
  return next;
}

export function uploadContext(runId: string, filename: string): RunView {
  requireRun(runId);
  return appendEvent(runId, { type: 'context_uploaded', filename });
}

export function rejectRun(runId: string, reason: string, decidedBy = CURRENT_USER.name): RunView {
  if (!reason.trim()) throw new Error('A rejection needs a reason — it becomes the agent’s next instruction.');
  const run = requireRun(runId);
  assertTransition(run.status, 'rejected', 'human');
  recordApproval({ runId, decision: 'rejected', reason, decidedBy });
  return appendEvent(runId, { type: 'human_rejected', reason, by: decidedBy });
}

/** Rejecting reopens the run with the reason as a fresh instruction. */
export async function reopenRun(runId: string, provider?: AgentProvider): Promise<RunView> {
  const run = requireRun(runId);
  assertTransition(run.status, 'planning', 'orchestrator');
  return drive(runId, run.agent, `${run.task}\n\nReviewer feedback: ${run.rejectionReason ?? ''}`, run.title, provider, run.rejectionReason ?? undefined);
}

export function sendBack(runId: string, note: string): RunView {
  const run = requireRun(runId);
  assertTransition(run.status, 'blocked', 'human');
  return appendEvent(runId, { type: 'human_blocked', note });
}

export function archiveRun(runId: string): RunView {
  const run = requireRun(runId);
  assertTransition(run.status, 'archived', 'human');
  return appendEvent(runId, { type: 'human_archived' });
}

function requireRun(runId: string): RunView {
  const run = getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  return run;
}

export { getRun, listRuns, subscribe } from './store';
