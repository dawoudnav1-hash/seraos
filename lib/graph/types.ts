import type { CheckResult, SourceRef } from '@/lib/engine/types';

/**
 * Shared vocabulary for the Graph → Workflows → Chains → Skills runtime. Kept
 * free of runtime imports so the catalog can be used from client code.
 */

/** Deterministic skills are plain code; agentic skills call a model. */
export const SKILL_KINDS = ['deterministic', 'agentic'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

/**
 * What running a unit does to the world. The executor schedules on this:
 * `read` runs concurrently, `propose` and `write` run one at a time.
 */
export const EFFECTS = ['read', 'propose', 'write'] as const;
export type Effect = (typeof EFFECTS)[number];

/** Model routing tier. `none` means no model is ever called. */
export const MODEL_TIERS = ['none', 'small', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const EFFECT_RANK: Record<Effect, number> = { read: 0, propose: 1, write: 2 };
const MODEL_RANK: Record<ModelTier, number> = { none: 0, small: 1, frontier: 2 };

/** A composite is as side-effecting as its most side-effecting part. */
export function maxEffect(effects: readonly Effect[]): Effect {
  return effects.reduce<Effect>((a, b) => (EFFECT_RANK[b] > EFFECT_RANK[a] ? b : a), 'read');
}

export function maxModel(models: readonly ModelTier[]): ModelTier {
  return models.reduce<ModelTier>((a, b) => (MODEL_RANK[b] > MODEL_RANK[a] ? b : a), 'none');
}

/** 'single' = one approver; 'dual' = two distinct approvers (the materiality gate). */
export const APPROVAL_TIERS = ['single', 'dual'] as const;
export type ApprovalTier = (typeof APPROVAL_TIERS)[number];
export const APPROVALS_FOR_TIER: Record<ApprovalTier, number> = { single: 1, dual: 2 };

export const PROPOSAL_KINDS = [
  'journal_entry',
  'transaction',
  'reconciliation',
  'schedule',
  'analysis',
  'document',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * A typed artifact a sub-agent proposes. Proposals are never committed by the
 * runtime; only a deterministic posting node acts on approved ones.
 */
export interface Proposal<T = unknown> {
  id: string;
  kind: ProposalKind;
  title: string;
  payload: T;
  sources: SourceRef[];
  confidence?: number;
  /** Graph node that produced it; filled in by the executor. */
  nodeId?: string;
}

/** What a human must sign off before held work can continue. */
export interface ApprovalRequest {
  /** Stable key approvals are recorded against: workflow id + hash of the proposals. */
  subject: string;
  tier: ApprovalTier;
  required: number;
  have: number;
  proposalIds: string[];
}

/** A check a gate produced; a CheckResult that may carry an approval request. */
export interface GateCheck extends CheckResult {
  approval?: ApprovalRequest;
}

/** A failing check: not passed, or passed below the confidence floor. */
export function isFailing(check: CheckResult, minConfidence = 0): boolean {
  return !check.pass || check.confidence < minConfidence;
}
