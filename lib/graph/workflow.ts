import { z } from 'zod';
import type { CheckResult } from '@/lib/engine/types';
import { sha256Hex, stableStringify } from './cache';
import { assertIdentity, errorMessage, ServiceUnavailableError, type AnyRunnable, type Runnable, type SkillContext } from './skill';
import {
  APPROVALS_FOR_TIER,
  isFailing,
  maxEffect,
  maxModel,
  type ApprovalRequest,
  type ApprovalTier,
  type GateCheck,
  type Proposal,
} from './types';

/**
 * A workflow is business logic: chains in order with compliance gates between
 * them. Workflows PROPOSE; they never commit. A write-effect step is refused at
 * definition time, and requireApproval stops the workflow with its proposals.
 */

export interface WorkflowMeta {
  id: string;
  version: string;
  name: string;
  description?: string;
}

export interface WorkflowState<I = unknown> {
  readonly workflowId: string;
  readonly input: I;
  /** Output of each chain step, keyed by its id. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Output of the most recent chain step (the input when none has run). */
  readonly last: unknown;
  /** Every verification and gate check so far, in order. */
  readonly checks: readonly GateCheck[];
  readonly proposals: readonly Proposal[];
}

export interface Gate {
  id: string;
  /** What a failing check means: stop the workflow, or hold its proposals for approval. */
  onFail: 'stop' | 'await_approval';
  /** Whether re-running the worker could make a stopped gate pass (failed verification yes, closed period no). */
  retryable: boolean;
  evaluate(state: WorkflowState, ctx: SkillContext): GateCheck | Promise<GateCheck>;
}

export interface WorkflowStepOptions<O2, I> {
  /** Checks on this step's output; they feed `verificationPassed`. */
  verify?: (output: O2, state: WorkflowState<I>) => CheckResult[] | Promise<CheckResult[]>;
  /** Typed artifacts this step proposes for review. */
  propose?: (output: O2, state: WorkflowState<I>) => Proposal[];
}

export interface WorkflowStepOptionsWithMap<Prev, N, O2, I> extends WorkflowStepOptions<O2, I> {
  map: (prev: Prev, state: WorkflowState<I>) => N;
}

export type WorkflowStep =
  | {
      readonly kind: 'run';
      readonly runnable: AnyRunnable;
      readonly map?: (prev: unknown, state: WorkflowState) => unknown;
      readonly verify?: (output: unknown, state: WorkflowState) => CheckResult[] | Promise<CheckResult[]>;
      readonly propose?: (output: unknown, state: WorkflowState) => Proposal[];
    }
  | { readonly kind: 'gate'; readonly gate: Gate };

/** The erased shape step options are stored in; typing happens at the `then` call site. */
type StepHooks = Omit<Extract<WorkflowStep, { kind: 'run' }>, 'kind' | 'runnable'>;

interface OutcomeBase {
  workflowId: string;
  outputs: Record<string, unknown>;
  /** Output of the last chain that ran. */
  last: unknown;
  proposals: Proposal[];
  checks: GateCheck[];
}

export type WorkflowOutcome<O> =
  | (OutcomeBase & { status: 'completed'; output: O })
  | (OutcomeBase & { status: 'awaiting_approval'; stoppedAt: string; approval: ApprovalRequest })
  | (OutcomeBase & { status: 'stopped'; stoppedAt: string; retryable: boolean });

export interface Workflow<I = unknown, O = unknown> extends Runnable<I, WorkflowOutcome<O>> {
  readonly type: 'workflow';
  readonly steps: readonly WorkflowStep[];
  then<O2>(next: Runnable<O, O2>, opts?: WorkflowStepOptions<O2, I>): Workflow<I, O2>;
  then<N, O2>(next: Runnable<N, O2>, opts: WorkflowStepOptionsWithMap<O, N, O2, I>): Workflow<I, O2>;
  gate(gate: Gate): Workflow<I, O>;
}

function assertStep(owner: string, r: AnyRunnable): void {
  if (r.type === 'workflow') throw new Error(`Workflow ${owner} cannot nest workflow ${r.id}; compose workflows in the graph.`);
  // The architectural rule, enforced structurally: posting is a separate, approved graph node.
  if (r.effect === 'write') throw new Error(`Workflow ${owner} cannot run write-effect step ${r.id}: workflows propose, never commit.`);
}

function build<I, O>(meta: WorkflowMeta, steps: readonly WorkflowStep[]): Workflow<I, O> {
  const runnables = steps.flatMap((s) => (s.kind === 'run' ? [s.runnable] : []));
  const first = runnables[0];

  const run = async (ctx: SkillContext, input: I): Promise<WorkflowOutcome<O>> => {
    const outputs: Record<string, unknown> = {};
    const checks: GateCheck[] = [];
    const proposals: Proposal[] = [];
    let last: unknown = input;
    const state = (): WorkflowState<I> => ({
      workflowId: meta.id,
      input,
      outputs: Object.freeze({ ...outputs }),
      last,
      checks: [...checks],
      proposals: [...proposals],
    });
    const base = (): OutcomeBase => ({ workflowId: meta.id, outputs: { ...outputs }, last, proposals: [...proposals], checks: [...checks] });

    for (const step of steps) {
      ctx.signal.throwIfAborted();
      if (step.kind === 'gate') {
        const check = await step.gate.evaluate(state() as WorkflowState, ctx);
        checks.push(check);
        if (check.pass) continue;
        if (step.gate.onFail === 'await_approval' && check.approval) {
          return { ...base(), status: 'awaiting_approval', stoppedAt: step.gate.id, approval: check.approval };
        }
        return { ...base(), status: 'stopped', stoppedAt: step.gate.id, retryable: step.gate.retryable };
      }
      const s = state() as WorkflowState;
      const stepInput = step.map ? step.map(last, s) : last;
      const out = await step.runnable.run(ctx, stepInput);
      outputs[step.runnable.id] = out;
      last = out;
      if (step.verify) checks.push(...(await step.verify(out, state() as WorkflowState)));
      if (step.propose) proposals.push(...step.propose(out, state() as WorkflowState));
    }
    return { ...base(), status: 'completed', output: last as O };
  };

  const self = {
    type: 'workflow' as const,
    id: meta.id,
    version: meta.version,
    name: meta.name,
    description: meta.description ?? '',
    kind: runnables.some((r) => r.kind === 'agentic') ? ('agentic' as const) : ('deterministic' as const),
    effect: maxEffect(runnables.map((r) => r.effect)),
    model: maxModel(runnables.map((r) => r.model)),
    input: first.input,
    // The outcome is assembled from already-validated chain outputs.
    output: z.custom<WorkflowOutcome<O>>((v) => typeof v === 'object' && v !== null && 'status' in v),
    fingerprint: `${meta.id}@${meta.version}[${steps
      .map((s) => (s.kind === 'run' ? s.runnable.fingerprint : `gate:${s.gate.id}`))
      .join(',')}]`,
    steps,
    run,
    then(next: AnyRunnable, opts: StepHooks = {}) {
      assertStep(meta.id, next);
      return build(meta, [...steps, { kind: 'run', runnable: next, ...opts }]);
    },
    gate(gate: Gate) {
      return build(meta, [...steps, { kind: 'gate', gate }]);
    },
  };
  return Object.freeze(self) as unknown as Workflow<I, O>;
}

export function workflow<I, O>(meta: WorkflowMeta, first: Runnable<I, O>, opts: WorkflowStepOptions<O, I> = {}): Workflow<I, O> {
  assertIdentity('Workflow', meta.id, meta.version);
  assertStep(meta.id, first);
  const hooks = opts as StepHooks;
  return build<I, O>(meta, [{ kind: 'run', runnable: first, verify: hooks.verify, propose: hooks.propose }]);
}

// ---------------------------------------------------------------- built-in gates

/** Default period lookup: `input.period` as `YYYY-MM`. */
function periodFromInput(state: WorkflowState): string | undefined {
  const input = state.input as { period?: unknown } | null | undefined;
  return typeof input?.period === 'string' ? input.period : undefined;
}

/** Stops the workflow when the period is closed. Fails closed when status cannot be confirmed. */
export function periodOpen(period: (state: WorkflowState) => string | undefined = periodFromInput): Gate {
  return {
    id: 'gate:periodOpen',
    onFail: 'stop',
    retryable: false,
    async evaluate(state, ctx) {
      const p = period(state);
      const check = (pass: boolean, message: string): GateCheck => ({ id: 'gate:periodOpen', layer: 'structural', pass, confidence: 1, message });
      if (!p) return check(false, 'No period on the workflow input; cannot confirm it is open.');
      try {
        const open = await ctx.services.periods.isOpen(ctx.client, p);
        return check(open, open ? `Period ${p} is open.` : `Period ${p} is closed; nothing may be proposed into it.`);
      } catch (err) {
        return check(false, `Could not confirm period ${p} is open: ${errorMessage(err)}`);
      }
    },
  };
}

/**
 * Passes when every check so far passes (and meets `minConfidence`). With no
 * checks at all it fails: an unverified artifact has not passed verification.
 */
export function verificationPassed(opts: { minConfidence?: number } = {}): Gate {
  const min = opts.minConfidence ?? 0;
  return {
    id: 'gate:verificationPassed',
    onFail: 'stop',
    retryable: true,
    evaluate(state) {
      const failing = state.checks.filter((c) => isFailing(c, min));
      const pass = state.checks.length > 0 && failing.length === 0;
      const message = state.checks.length === 0
        ? 'No verification checks ran.'
        : pass
          ? `All ${state.checks.length} checks passed.`
          : `Failed: ${failing.map((c) => `${c.id} (${c.message})`).join('; ')}`;
      const confidence = state.checks.length ? Math.min(...state.checks.map((c) => c.confidence)) : 0;
      return { id: 'gate:verificationPassed', layer: 'verifier', pass, confidence, message };
    },
  };
}

/**
 * Holds the workflow's proposals for human sign-off. Approvals are counted
 * against a subject that includes a hash of the proposals, so an approval never
 * carries over to proposals that changed after it was given.
 */
export function requireApproval(tier: ApprovalTier | ((state: WorkflowState) => ApprovalTier)): Gate {
  return {
    id: 'gate:requireApproval',
    onFail: 'await_approval',
    retryable: false,
    async evaluate(state, ctx) {
      const t = typeof tier === 'function' ? tier(state) : tier;
      const required = APPROVALS_FOR_TIER[t];
      if (state.proposals.length === 0) {
        return { id: 'gate:requireApproval', layer: 'structural', pass: true, confidence: 1, message: 'Nothing proposed; no approval needed.' };
      }
      const subject = `${state.workflowId}:${(await sha256Hex(stableStringify(state.proposals))).slice(0, 16)}`;
      let have = 0;
      try {
        have = await ctx.services.approvals.count(ctx.runId, subject);
      } catch (err) {
        // No approval service means no approvals on file; anything else is a real failure.
        if (!(err instanceof ServiceUnavailableError)) throw err;
      }
      const approval: ApprovalRequest = { subject, tier: t, required, have, proposalIds: state.proposals.map((p) => p.id) };
      const pass = have >= required;
      const message = pass
        ? `${have} of ${required} approvals on file.`
        : `Awaiting ${required - have} more approval${required - have === 1 ? '' : 's'} (${t}) for ${state.proposals.length} proposal${state.proposals.length === 1 ? '' : 's'}.`;
      return { id: 'gate:requireApproval', layer: 'structural', pass, confidence: 1, message, approval };
    },
  };
}
