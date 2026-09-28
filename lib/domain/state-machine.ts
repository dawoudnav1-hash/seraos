import type { RunStatus } from './types';

/** Who is allowed to make a given transition. */
export type Actor = 'orchestrator' | 'human';

const ORCHESTRATOR_EDGES: Record<RunStatus, RunStatus[]> = {
  queued: ['clarifying', 'planning', 'failed'],
  clarifying: ['planning', 'failed'],
  planning: ['executing', 'blocked', 'failed'],
  executing: ['planning', 'blocked', 'review_ready', 'failed'],
  blocked: ['executing', 'failed'],
  review_ready: [],
  viewed: [],
  approved: ['archived'],
  rejected: ['planning', 'executing'],
  archived: [],
  failed: ['queued'],
};

const HUMAN_EDGES: Record<RunStatus, RunStatus[]> = {
  queued: ['archived'],
  clarifying: ['archived'],
  planning: ['archived'],
  executing: ['blocked', 'archived'],
  blocked: ['archived'],
  review_ready: ['viewed', 'blocked', 'archived'],
  viewed: ['approved', 'rejected', 'blocked', 'archived'],
  approved: ['archived'],
  rejected: ['archived'],
  archived: [],
  failed: ['archived'],
};

export function allowedTransitions(from: RunStatus, actor: Actor): RunStatus[] {
  return actor === 'human' ? HUMAN_EDGES[from] : ORCHESTRATOR_EDGES[from];
}

export function canTransition(from: RunStatus, to: RunStatus, actor: Actor): boolean {
  return allowedTransitions(from, actor).includes(to);
}

export class TransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
    readonly actor: Actor,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Human-readable reason a drag was refused, for the toast. */
export function explainRefusal(from: RunStatus, to: RunStatus, actor: Actor): string {
  if (canTransition(from, to, actor)) return '';
  if (actor === 'human' && (to === 'executing' || to === 'planning' || to === 'queued' || to === 'clarifying')) {
    return 'Only the orchestrator moves work forward — you can’t drag a run into In Progress.';
  }
  if (actor === 'human' && to === 'approved' && from === 'review_ready') {
    return 'Open the run and review it before approving.';
  }
  if (from === 'approved' || from === 'archived') {
    return `A ${from} run is final; it can only be archived.`;
  }
  return `Can’t move a run from ${from} to ${to}.`;
}

export function assertTransition(from: RunStatus, to: RunStatus, actor: Actor): void {
  if (!canTransition(from, to, actor)) {
    throw new TransitionError(from, to, actor, explainRefusal(from, to, actor));
  }
}
