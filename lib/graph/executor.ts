import type { CheckResult, SourceRef } from '@/lib/engine/types';
import type { AgentEvent, Artifact, Blocker, Clarification, SpecialistName, Step, ToolName } from '@/lib/domain/types';
import { replayKey, type ReplayCache } from './cache';
import {
  ClarificationNeeded,
  createSkillContext,
  errorMessage,
  type AnyRunnable,
  type Runnable,
  type SkillContext,
  type SkillEvent,
  type SkillServices,
} from './skill';
import { isFailing, type ApprovalRequest, type Effect, type Proposal } from './types';
import type { WorkflowOutcome } from './workflow';

/**
 * The graph executor. It walks a dependency DAG in topological layers: within a
 * layer, read nodes run concurrently (bounded), then propose/write nodes run one
 * at a time in declaration order. Each node's output is verified; failures loop
 * back to the worker with the failed checks as feedback, then escalate.
 */

// ---------------------------------------------------------------- node spec

type RunnableInput<R> = R extends Runnable<infer I, unknown> ? I : never;

/** A workflow node's output is its outcome's `output`; the executor unwraps it. */
export type NodeOutput<R> = R extends { type: 'workflow'; run: (ctx: SkillContext, input: never) => Promise<WorkflowOutcome<infer O>> }
  ? O
  : R extends Runnable<never, infer O>
    ? O
    : never;

export interface VerifyInfo {
  input: unknown;
  attempt: number;
  /** Checks that failed on the previous attempt. */
  feedback: readonly CheckResult[];
}

export interface NodeSpec<R extends AnyRunnable = AnyRunnable> {
  /** Unique within the graph; doubles as the Step id in events. */
  id: string;
  runnable: R;
  dependsOn?: string[];
  /**
   * Builds this node's input from completed dependencies. Default: the graph
   * input when there are no dependencies, else `{ [depId]: output }`.
   */
  input?: (deps: Record<string, unknown>, graphInput: unknown) => RunnableInput<R>;
  title?: string;
  agent?: SpecialistName;
  tools?: ToolName[];
  /** Checks on the output. Any failing check triggers a retry with the checks as feedback. */
  verify?: (output: NodeOutput<R>, info: VerifyInfo) => CheckResult[] | Promise<CheckResult[]>;
  /** Total attempts including the first. Default: the graph's `maxAttempts` (3). */
  maxAttempts?: number;
  /** Checks that pass below this confidence still count as failures. */
  minConfidence?: number;
  /** Blocker reason when retries are exhausted. Default 'low_confidence'. */
  escalateAs?: 'low_confidence' | 'approval_required';
  /** Proposals carried by a skill/chain output (workflows report their own). */
  proposals?: (output: NodeOutput<R>) => Proposal[];
  /** Opt out of replay caching, e.g. for a read of live data with no as-of in its input. */
  cache?: boolean;
}

export type GraphNode = NodeSpec<AnyRunnable>;

/** Identity helper that types `verify`, `input` and `proposals` against the runnable. */
export function node<R extends AnyRunnable>(spec: NodeSpec<R>): GraphNode {
  return spec as unknown as GraphNode;
}

export interface GraphSpec {
  id: string;
  title?: string;
  nodes: readonly GraphNode[];
}

// ---------------------------------------------------------------- results

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'awaiting_approval'
  | 'needs_clarification'
  | 'failed'
  | 'skipped';

export interface NodeResult {
  id: string;
  title: string;
  status: NodeStatus;
  effect: Effect;
  output?: unknown;
  /** Checks from the final attempt. */
  checks: CheckResult[];
  attempts: number;
  /** Failing checks of each failed attempt, in order: the feedback trail. */
  failedAttempts: CheckResult[][];
  cached: boolean;
  proposals: Proposal[];
  sources: SourceRef[];
  artifacts: Artifact[];
  blocker?: Blocker;
  approval?: ApprovalRequest;
  clarification?: Clarification;
  error?: string;
  skippedBecause?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type GraphStatus = 'completed' | 'awaiting_approval' | 'needs_clarification' | 'blocked' | 'failed';

export interface GraphResult {
  graphId: string;
  status: GraphStatus;
  /** Topological layers of node ids, as executed. */
  layers: string[][];
  nodes: Record<string, NodeResult>;
  /** Outputs of completed nodes. */
  outputs: Record<string, unknown>;
  /** Everything proposed, by completed and approval-held nodes. Nothing here is committed. */
  proposals: Proposal[];
  approvals: ApprovalRequest[];
  blockers: Blocker[];
  clarifications: Clarification[];
  error?: string;
}

export interface RunGraphOptions {
  runId: string;
  client: string;
  /** Graph-level input handed to root nodes. */
  input?: unknown;
  emit?: (event: AgentEvent) => void;
  services?: Partial<SkillServices>;
  cache?: ReplayCache;
  /** Max read nodes in flight at once. Default 4. */
  concurrency?: number;
  /** Total attempts per node including the first. Default 3. */
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Emit plan_created before executing. Default true. */
  emitPlan?: boolean;
  /** Agent shown on steps whose node names none. Default LedgerAgent. */
  defaultAgent?: SpecialistName;
  now?: () => number;
}

// ---------------------------------------------------------------- planning

export class GraphDefinitionError extends Error {
  readonly code: string = 'GRAPH_DEFINITION';
  constructor(message: string) {
    super(message);
    this.name = 'GraphDefinitionError';
  }
}

export class GraphCycleError extends GraphDefinitionError {
  override readonly code = 'GRAPH_CYCLE';
  constructor(readonly cycle: string[]) {
    super(`Graph has a cycle: ${cycle.join(' → ')}`);
    this.name = 'GraphCycleError';
  }
}

export interface GraphPlan {
  /** Node ids grouped by depth; every dependency sits in an earlier layer. */
  layers: string[][];
  order: string[];
}

/**
 * Validates the DAG and groups nodes into layers by longest dependency depth.
 * Ties keep declaration order so scheduling is stable run to run.
 */
export function planGraph(nodes: readonly Pick<GraphNode, 'id' | 'dependsOn'>[]): GraphPlan {
  const index = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (index.has(n.id)) throw new GraphDefinitionError(`Duplicate node id "${n.id}".`);
    index.set(n.id, i);
  });
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) {
      if (!index.has(d)) throw new GraphDefinitionError(`Node "${n.id}" depends on unknown node "${d}".`);
    }
  }

  const depth = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visit = (id: string, path: string[]): number => {
    const s = state.get(id);
    if (s === 'done') return depth.get(id)!;
    if (s === 'visiting') throw new GraphCycleError([...path.slice(path.indexOf(id)), id]);
    state.set(id, 'visiting');
    const deps = byId.get(id)!.dependsOn ?? [];
    const d = deps.length ? 1 + Math.max(...deps.map((x) => visit(x, [...path, id]))) : 0;
    state.set(id, 'done');
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) visit(n.id, []);

  const layers: string[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.id)!;
    (layers[d] ??= []).push(n.id);
  }
  return { layers, order: layers.flat() };
}

// ---------------------------------------------------------------- execution

const SKILL_EVENT_TYPES = new Set<AgentEvent['type']>(['tool_called', 'tool_result', 'progress', 'artifact_created']);

function isWorkflowOutcome(r: AnyRunnable, v: unknown): v is WorkflowOutcome<unknown> {
  return r.type === 'workflow' && typeof v === 'object' && v !== null && 'status' in v;
}

function dedupeSources(list: SourceRef[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const s of list) seen.set(`${s.system}\u0000${s.id}`, s);
  return [...seen.values()];
}

function describeChecks(checks: readonly CheckResult[]): string {
  return checks.map((c) => `${c.id} [${c.layer}, ${Math.round(c.confidence * 100)}%]: ${c.message}`).join('; ');
}

async function pool<T>(items: readonly T[], limit: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function runGraph(graph: GraphSpec, opts: RunGraphOptions): Promise<GraphResult> {
  const plan = planGraph(graph.nodes);
  const emit = opts.emit ?? (() => {});
  const now = opts.now ?? Date.now;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const defaultAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const titleOf = (n: GraphNode) => n.title ?? n.runnable.name;
  const agentOf = (n: GraphNode) => n.agent ?? opts.defaultAgent ?? 'LedgerAgent';

  const dependents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const n of graph.nodes) for (const d of n.dependsOn ?? []) dependents.get(d)!.push(n.id);

  const results = new Map<string, NodeResult>(
    graph.nodes.map((n) => [
      n.id,
      {
        id: n.id,
        title: titleOf(n),
        status: 'pending',
        effect: n.runnable.effect,
        checks: [],
        attempts: 0,
        failedAttempts: [],
        cached: false,
        proposals: [],
        sources: [],
        artifacts: [],
      },
    ]),
  );

  const controller = new AbortController();
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) controller.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  let fatal: string | null = null;
  let settled = 0;
  const total = graph.nodes.length;
  const stopped = () => fatal !== null || controller.signal.aborted;

  if (opts.emitPlan ?? true) {
    const steps: Step[] = graph.nodes.map((n) => ({ id: n.id, title: titleOf(n), agent: agentOf(n), tools: n.tools ?? [], status: 'pending' }));
    const reasoning = plan.layers.map((layer, i) => {
      const reads = layer.filter((id) => byId.get(id)!.runnable.effect === 'read');
      const serial = layer.filter((id) => byId.get(id)!.runnable.effect !== 'read');
      const parts = [reads.length ? `in parallel: ${reads.join(', ')}` : '', serial.length ? `in order: ${serial.join(' → ')}` : ''];
      return `Layer ${i + 1} — ${parts.filter(Boolean).join('; then ')}`;
    });
    emit({ type: 'plan_created', steps, scope: graph.title, reasoning });
  }

  const settle = (r: NodeResult, status: NodeStatus) => {
    r.status = status;
    r.finishedAt = now();
    settled++;
    emit({ type: 'progress', stepId: r.id, pct: (settled / total) * 100, note: `${r.title}: ${status.replace(/_/g, ' ')}` });
  };

  const skip = (r: NodeResult, because: string) => {
    r.skippedBecause = because;
    settle(r, 'skipped');
  };

  const fail = (r: NodeResult, err: unknown) => {
    r.error = errorMessage(err);
    fatal ??= `${r.title}: ${r.error}`;
    // Stop in-flight siblings; a contract violation means the run's result can't be trusted.
    controller.abort(new Error(fatal));
    settle(r, 'failed');
  };

  const block = (r: NodeResult, blocker: Blocker, status: NodeStatus = 'blocked') => {
    r.blocker = blocker;
    settle(r, status);
  };

  const flushArtifacts = (r: NodeResult) => {
    for (const artifact of r.artifacts) emit({ type: 'artifact_created', artifact });
  };

  const tag = (proposals: Proposal[], nodeId: string) => proposals.map((p) => ({ ...p, nodeId }));

  const runNode = async (n: GraphNode): Promise<void> => {
    const r = results.get(n.id)!;
    const waiting = (n.dependsOn ?? []).filter((d) => results.get(d)!.status !== 'completed');
    if (waiting.length) return skip(r, waiting.map((d) => `${d} is ${results.get(d)!.status.replace(/_/g, ' ')}`).join('; '));
    if (stopped()) return skip(r, 'run stopped');

    r.status = 'running';
    r.startedAt = now();
    emit({ type: 'step_started', stepId: n.id, agent: agentOf(n) });

    let input: unknown;
    let key: string | undefined;
    try {
      const deps = Object.fromEntries((n.dependsOn ?? []).map((d) => [d, results.get(d)!.output]));
      input = n.input ? n.input(deps, opts.input) : (n.dependsOn?.length ?? 0) === 0 ? opts.input : deps;
      if (opts.cache && n.cache !== false) {
        key = await replayKey({ nodeId: n.id, fingerprint: n.runnable.fingerprint, client: opts.client, input });
      }
    } catch (err) {
      return fail(r, err);
    }

    if (key && opts.cache) {
      // A cache outage is a miss, not a failed close: replay is an optimization.
      const hit = await Promise.resolve(opts.cache.get(key)).catch(() => undefined);
      if (hit) {
        Object.assign(r, {
          output: hit.output,
          checks: hit.checks,
          proposals: hit.proposals,
          sources: hit.sources,
          artifacts: hit.artifacts,
          attempts: hit.attempts,
          cached: true,
        });
        flushArtifacts(r);
        emit({ type: 'step_completed', stepId: n.id });
        return settle(r, 'completed');
      }
    }

    const maxAttempts = Math.max(1, n.maxAttempts ?? defaultAttempts);
    let feedback: CheckResult[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      r.attempts = attempt;
      const artifacts: Artifact[] = [];
      const sources: SourceRef[] = [];
      const forward = (e: SkillEvent) => {
        if (!SKILL_EVENT_TYPES.has(e.type)) return;
        // Unverified artifacts never surface; they are released only if the attempt passes.
        if (e.type === 'artifact_created') return void artifacts.push(e.artifact);
        // Step-local progress is rescaled to the run, since the run view keeps a single max.
        if (e.type === 'progress') return emit({ ...e, pct: ((settled + e.pct / 100) / total) * 100 });
        emit(e);
      };
      const ctx = createSkillContext({
        runId: opts.runId,
        stepId: n.id,
        client: opts.client,
        services: opts.services,
        signal: controller.signal,
        attempt,
        feedback,
        emit: forward,
        onCite: (refs) => sources.push(...refs),
      });

      let raw: unknown;
      try {
        raw = await n.runnable.run(ctx, input);
      } catch (err) {
        if (err instanceof ClarificationNeeded) {
          const clarification = err.toClarification(`clar_${opts.runId}_${n.id}`);
          r.clarification = clarification;
          const upload = err.reason === 'missing_document';
          return block(
            r,
            {
              id: `blk_${opts.runId}_${n.id}`,
              stepId: n.id,
              reason: upload ? 'missing_document' : 'policy_decision',
              title: `${r.title} needs an answer`,
              detail: err.help ? `${err.question} ${err.help}` : err.question,
              resolution: { kind: upload ? 'upload_file' : 'answer_question', label: upload ? 'Upload the document' : 'Answer and resume' },
            },
            'needs_clarification',
          );
        }
        if (controller.signal.aborted) return skip(r, 'cancelled: run stopped');
        return fail(r, err);
      }

      let output: unknown = raw;
      let checks: CheckResult[] = [];
      let proposals: Proposal[] = [];
      if (isWorkflowOutcome(n.runnable, raw)) {
        checks = [...raw.checks];
        proposals = raw.proposals;
        if (raw.status === 'awaiting_approval') {
          Object.assign(r, { output: raw.last, checks, proposals: tag(proposals, n.id), sources: dedupeSources(sources), artifacts, approval: raw.approval });
          flushArtifacts(r);
          const held = dependents.get(n.id)!;
          // Held proposals at a leaf are ordinary review (the step's work is done);
          // only work waiting on them is blocked.
          if (held.length === 0) {
            emit({ type: 'step_completed', stepId: n.id });
            return settle(r, 'awaiting_approval');
          }
          return block(
            r,
            {
              id: `blk_${opts.runId}_${n.id}`,
              stepId: n.id,
              reason: 'approval_required',
              title: `${r.title} awaits ${raw.approval.tier} approval`,
              detail: `${raw.approval.proposalIds.length} proposal(s) need ${raw.approval.required} approval(s), ${raw.approval.have} on file. Held: ${held.join(', ')}.`,
              resolution: { kind: 'approve', label: `Approve ${raw.approval.proposalIds.length} proposal(s)` },
            },
            'awaiting_approval',
          );
        }
        if (raw.status === 'stopped') {
          const failed = checks.filter((c) => isFailing(c));
          r.checks = checks;
          if (!raw.retryable) {
            return block(r, {
              id: `blk_${opts.runId}_${n.id}`,
              stepId: n.id,
              reason: 'policy_decision',
              title: `${r.title} stopped at ${raw.stoppedAt}`,
              detail: describeChecks(failed),
              resolution: { kind: 'answer_question', label: 'Decide how to proceed' },
            });
          }
          r.failedAttempts.push(failed);
          feedback = failed;
          if (attempt < maxAttempts) {
            emit({ type: 'progress', stepId: n.id, pct: (settled / total) * 100, note: `Retrying ${r.title} (${attempt + 1}/${maxAttempts}): ${failed.map((c) => c.id).join(', ')}` });
          }
          continue;
        }
        output = raw.output;
      }

      try {
        if (n.verify) checks = [...checks, ...(await n.verify(output, { input, attempt, feedback }))];
        if (n.proposals) proposals = [...proposals, ...n.proposals(output)];
      } catch (err) {
        return fail(r, err);
      }
      r.checks = checks;
      const failed = checks.filter((c) => isFailing(c, n.minConfidence));
      if (failed.length === 0) {
        Object.assign(r, { output, proposals: tag(proposals, n.id), sources: dedupeSources(sources), artifacts });
        flushArtifacts(r);
        if (key && opts.cache) {
          const entry = { output, checks, proposals: r.proposals, sources: r.sources, artifacts, attempts: attempt, storedAt: now() };
          await Promise.resolve(opts.cache.set(key, entry)).catch(() => undefined);
        }
        emit({ type: 'step_completed', stepId: n.id });
        return settle(r, 'completed');
      }
      r.failedAttempts.push(failed);
      feedback = failed;
      if (attempt < maxAttempts) {
        emit({ type: 'progress', stepId: n.id, pct: (settled / total) * 100, note: `Retrying ${r.title} (${attempt + 1}/${maxAttempts}): ${failed.map((c) => c.id).join(', ')}` });
      }
    }

    // Retries exhausted: escalate to a human rather than guess.
    const reason = n.escalateAs ?? 'low_confidence';
    return block(r, {
      id: `blk_${opts.runId}_${n.id}`,
      stepId: n.id,
      reason,
      title: `${r.title} failed verification after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`,
      detail: describeChecks(feedback),
      resolution: reason === 'approval_required' ? { kind: 'approve', label: 'Review and approve an override' } : { kind: 'confirm', label: 'Review the failed checks' },
    });
  };

  try {
    for (const layer of plan.layers) {
      if (stopped()) break;
      const nodes = layer.map((id) => byId.get(id)!);
      // Reads first, so every write in the layer sees the same pre-write world regardless of timing.
      await pool(nodes.filter((n) => n.runnable.effect === 'read'), concurrency, stopped, runNode);
      for (const n of nodes.filter((x) => x.runnable.effect !== 'read')) {
        if (stopped()) break;
        await runNode(n);
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  for (const r of results.values()) if (r.status === 'pending') skip(r, fatal ? 'run failed' : 'run stopped');
  if (!fatal && controller.signal.aborted) fatal = 'Run was cancelled.';

  const ordered = graph.nodes.map((n) => results.get(n.id)!);
  const blockers = ordered.flatMap((r) => (r.blocker ? [r.blocker] : []));
  // The run view holds one status, so blockers are raised after independent work drains
  // (a step_started after `blocked` would read as a resume). A failed run raises only run_failed.
  if (fatal) emit({ type: 'run_failed', error: fatal });
  else for (const b of blockers) emit({ type: 'blocked', blocker: b });

  const has = (s: NodeStatus) => ordered.some((r) => r.status === s);
  const status: GraphStatus = fatal
    ? 'failed'
    : has('blocked') || ordered.some((r) => r.status === 'awaiting_approval' && r.blocker)
      ? 'blocked'
      : has('needs_clarification')
        ? 'needs_clarification'
        : has('awaiting_approval')
          ? 'awaiting_approval'
          : 'completed';

  return {
    graphId: graph.id,
    status,
    layers: plan.layers,
    nodes: Object.fromEntries(ordered.map((r) => [r.id, r])),
    outputs: Object.fromEntries(ordered.filter((r) => r.status === 'completed').map((r) => [r.id, r.output])),
    proposals: ordered.filter((r) => r.status === 'completed' || r.status === 'awaiting_approval').flatMap((r) => r.proposals),
    approvals: ordered.flatMap((r) => (r.status === 'awaiting_approval' && r.approval ? [r.approval] : [])),
    blockers,
    clarifications: ordered.flatMap((r) => (r.clarification ? [r.clarification] : [])),
    error: fatal ?? undefined,
  };
}
