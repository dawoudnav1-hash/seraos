import {
  APPROVALS_REQUIRED,
  type AgentEvent,
  type Artifact,
  type EvidenceTable,
  type Provenance,
  type RunStatus,
  type RunView,
  type SpecialistName,
  type Step,
} from './types';

export interface RunSeed {
  id: string;
  title: string;
  task: string;
  client: string;
  agent: SpecialistName;
  createdAt: number;
}

/** Human decisions are events too, so the projection stays total. */
export type HumanEvent =
  | { type: 'human_viewed' }
  | { type: 'human_approved'; by: string; role: string }
  | { type: 'human_rejected'; reason: string; by?: string }
  | { type: 'human_blocked'; note: string }
  | { type: 'human_archived' }
  | { type: 'clarification_answered'; questionId: string; answer: string }
  | { type: 'context_uploaded'; filename: string };

export type RunEvent = AgentEvent | HumanEvent;

export function emptyRun(seed: RunSeed): RunView {
  return {
    id: seed.id,
    title: seed.title,
    task: seed.task,
    client: seed.client,
    status: 'queued',
    agent: seed.agent,
    description: '',
    progressPct: 0,
    steps: [],
    blocker: null,
    artifacts: [],
    provenance: [],
    confidence: null,
    openQuestions: [],
    rejectionReason: null,
    clarificationIntro: '',
    clarificationWhy: '',
    clarifications: [],
    contextFiles: [],
    scope: '',
    reasoning: [],
    tables: [],
    findings: [],
    assumptions: [],
    approvals: [],
    completedAt: null,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
  };
}

function setStep(steps: Step[], id: string, patch: Partial<Step>): Step[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

function recomputeProgress(steps: Step[], fallback: number): number {
  if (steps.length === 0) return fallback;
  const done = steps.filter((s) => s.status === 'completed').length;
  return Math.max(fallback, Math.round((done / steps.length) * 100));
}

/** Distinct people who have signed off; the same person twice counts once. */
export function distinctApprovers(run: Pick<RunView, 'approvals'>): number {
  return new Set(run.approvals.map((a) => a.by)).size;
}

/**
 * The single source of truth for run state: everything the UI shows is derived
 * from the event log, so a run can be replayed with no hidden client state.
 */
export function applyEvent(run: RunView, event: RunEvent, at = run.updatedAt): RunView {
  const next: RunView = { ...run, updatedAt: at };
  switch (event.type) {
    case 'clarification_requested':
      next.status = 'clarifying';
      next.clarificationIntro = event.intro;
      next.clarificationWhy = event.why ?? '';
      next.clarifications = event.questions.map((q) => ({ ...q, askedAt: at, answer: null, answeredAt: null }));
      next.description = `Waiting on ${event.questions.length} clarifying questions before planning.`;
      return next;
    case 'clarification_answered': {
      next.clarifications = next.clarifications.map((q) =>
        q.id === event.questionId ? { ...q, answer: event.answer, answeredAt: at } : q,
      );
      const open = next.clarifications.filter((q) => q.answer === null).length;
      next.description = open
        ? `${open} clarifying question${open === 1 ? '' : 's'} still open.`
        : 'All questions answered — building the plan.';
      return next;
    }
    case 'context_uploaded':
      next.contextFiles = [...next.contextFiles, event.filename];
      return next;
    case 'plan_created':
      next.steps = event.steps;
      next.status = 'planning';
      if (event.scope) next.scope = event.scope;
      if (event.reasoning) next.reasoning = event.reasoning;
      next.description = `Planned ${event.steps.length} steps: ${event.steps.map((s) => s.title).join(' → ')}`;
      return next;
    case 'step_started':
      next.status = 'executing';
      next.steps = setStep(next.steps, event.stepId, { status: 'running' });
      next.agent = event.agent;
      return next;
    case 'tool_called':
      next.description = `Calling ${event.tool}…`;
      return next;
    case 'tool_result':
      next.description = event.summary;
      if (event.provenance?.length) {
        next.provenance = dedupeProvenance([...next.provenance, ...event.provenance]);
      }
      if (event.table) next.tables = upsertTable(next.tables, event.table);
      return next;
    case 'progress':
      next.progressPct = Math.max(next.progressPct, Math.min(100, Math.round(event.pct)));
      next.description = event.note;
      return next;
    case 'blocked':
      next.status = 'blocked';
      next.blocker = event.blocker;
      next.description = event.blocker.detail;
      if (event.blocker.stepId) next.steps = setStep(next.steps, event.blocker.stepId, { status: 'blocked' });
      return next;
    case 'unblocked':
      next.status = 'executing';
      if (next.blocker?.stepId) next.steps = setStep(next.steps, next.blocker.stepId, { status: 'running' });
      next.blocker = null;
      return next;
    case 'artifact_created':
      next.artifacts = upsertArtifact(next.artifacts, event.artifact);
      return next;
    case 'step_completed':
      next.steps = setStep(next.steps, event.stepId, { status: 'completed' });
      next.progressPct = recomputeProgress(next.steps, next.progressPct);
      return next;
    case 'run_completed':
      next.status = 'review_ready';
      next.progressPct = 100;
      next.description = event.summary;
      next.blocker = null;
      next.completedAt = at;
      if (event.findings) next.findings = event.findings;
      if (event.assumptions) next.assumptions = event.assumptions;
      return next;
    case 'run_failed':
      next.status = 'failed';
      next.description = event.error;
      return next;
    case 'human_viewed':
      next.status = next.status === 'review_ready' ? 'viewed' : next.status;
      return next;
    case 'human_approved':
      next.approvals = [...next.approvals, { by: event.by, role: event.role, at }];
      // One sign-off leaves the run in review; the second distinct one finalizes it.
      if (distinctApprovers(next) >= APPROVALS_REQUIRED) next.status = 'approved';
      return next;
    case 'human_rejected':
      next.status = 'rejected';
      next.rejectionReason = event.reason;
      next.approvals = [];
      next.description = `Returned by ${event.by ?? 'Alex'}: ${event.reason}`;
      return next;
    case 'human_blocked':
      next.status = 'blocked';
      next.blocker = {
        id: `blk_${run.id}_human`,
        reason: 'policy_decision',
        title: 'Sent back by reviewer',
        detail: event.note,
        resolution: { kind: 'answer_question', label: 'Respond and resume' },
      };
      next.description = event.note;
      return next;
    case 'human_archived':
      next.status = 'archived';
      return next;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function upsertArtifact(list: Artifact[], a: Artifact): Artifact[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i === -1) return [...list, a];
  const copy = [...list];
  copy[i] = a;
  return copy;
}

function upsertTable(list: EvidenceTable[], t: EvidenceTable): EvidenceTable[] {
  const i = list.findIndex((x) => x.id === t.id);
  if (i === -1) return [...list, t];
  const copy = [...list];
  copy[i] = t;
  return copy;
}

function dedupeProvenance(list: Provenance[]): Provenance[] {
  const seen = new Map<string, Provenance>();
  for (const p of list) seen.set(p.id, p);
  return [...seen.values()];
}

export function replay(seed: RunSeed, events: { event: RunEvent; at: number }[]): RunView {
  return events.reduce((run, e) => applyEvent(run, e.event, e.at), emptyRun(seed));
}

export const BOARD_COLUMNS: { id: string; label: string; statuses: RunStatus[]; dot: 'none' | 'red' | 'green' | 'gray' }[] = [
  { id: 'in_progress', label: 'In Progress', statuses: ['queued', 'planning', 'executing', 'rejected'], dot: 'none' },
  { id: 'needs_attention', label: 'Needs Attention', statuses: ['clarifying', 'blocked', 'failed'], dot: 'red' },
  { id: 'ready_for_review', label: 'Ready for Review', statuses: ['review_ready'], dot: 'green' },
  { id: 'viewed', label: 'Viewed', statuses: ['viewed', 'approved'], dot: 'gray' },
];

export function columnFor(status: RunStatus): string | null {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.id ?? null;
}

/** The label the workflow header pill shows for a status. */
export function statusLabel(run: Pick<RunView, 'status' | 'approvals'>): string {
  switch (run.status) {
    case 'queued':
      return 'Queued';
    case 'clarifying':
      return 'Clarification';
    case 'planning':
    case 'executing':
      return 'In Progress';
    case 'blocked':
      return 'Needs Attention';
    case 'review_ready':
      return 'Completed';
    case 'viewed':
      return run.approvals.length ? `Approved ${distinctApprovers(run)} of ${APPROVALS_REQUIRED}` : 'In Review';
    case 'approved':
      return 'Final';
    case 'rejected':
      return 'Changes Requested';
    case 'archived':
      return 'Archived';
    case 'failed':
      return 'Failed';
  }
}
