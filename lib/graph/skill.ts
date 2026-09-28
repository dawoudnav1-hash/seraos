import type { z } from 'zod';
import type { CheckResult, SourceRef } from '@/lib/engine/types';
import type { AgentEvent, Clarification, EvidenceTable, Provenance, ToolName } from '@/lib/domain/types';
import type { Playbook } from './playbook';
import type { Effect, ModelTier, SkillKind } from './types';

/**
 * Skills are the atomic, typed unit of work. Everything above them (chains,
 * workflows, graph nodes) is a `Runnable` with the same `run(ctx, input)` shape,
 * so any level can be scheduled, cached and verified the same way.
 */

// ---------------------------------------------------------------- ports
// Interfaces only: other modules implement them (lib/agents, lib/memory,
// lib/context). A skill never imports an implementation directly.

export interface ToolCallRequest {
  runId: string;
  stepId: string;
  tool: ToolName;
  args: unknown;
  toolCallId: string;
  signal: AbortSignal;
}

export interface ToolCallResult<T = unknown> {
  ok: boolean;
  summary: string;
  data: T;
  provenance?: Provenance[];
  table?: EvidenceTable;
}

/** Executes a named tool (ERP fetch, document parse, workbook build, …). */
export interface ToolCaller {
  call<T = unknown>(req: ToolCallRequest): Promise<ToolCallResult<T>>;
}

export type MemoryKind = 'process' | 'historical' | 'user' | 'semantic';

export interface MemoryQuery {
  kind: MemoryKind;
  client: string;
  key: string;
}

/** Process, historical, user and semantic memory behind one keyed interface. */
export interface MemoryPort {
  recall<T = unknown>(query: MemoryQuery): Promise<T | null>;
  remember(entry: MemoryQuery & { value: unknown; sources?: SourceRef[] }): Promise<void>;
}

export interface ContextNodeInput {
  kind: string;
  label: string;
  runId: string;
  stepId: string;
  data?: unknown;
  sources?: SourceRef[];
}

export interface ContextSubgraph {
  nodes: { id: string; kind: string; label: string; data?: unknown }[];
  edges: { from: string; to: string; relation: string }[];
}

/** The context graph built from interaction: record what was touched, read what is near. */
export interface GraphPort {
  record(node: ContextNodeInput): Promise<string>;
  link(fromId: string, toId: string, relation: string): Promise<void>;
  neighborhood(ids: string[], depth?: number): Promise<ContextSubgraph>;
}

export interface OntologyConcept {
  id: string;
  label: string;
  definition: string;
  related?: string[];
}

/** The accounting ontology as a tool: look up, validate, and slice for prompts. */
export interface OntologyPort {
  lookup(concept: string): Promise<OntologyConcept | null>;
  validate(kind: string, value: unknown): Promise<CheckResult[]>;
  slice(concepts: string[], maxChars?: number): Promise<string>;
}

/** Period status for the periodOpen gate. `period` is `YYYY-MM`. */
export interface PeriodPort {
  isOpen(client: string, period: string): Promise<boolean>;
}

/** Distinct approvers recorded against a subject (see ApprovalRequest.subject). */
export interface ApprovalPort {
  count(runId: string, subject: string): Promise<number>;
}

export interface SkillServices {
  tools: ToolCaller;
  memory: MemoryPort;
  graph: GraphPort;
  ontology: OntologyPort;
  periods: PeriodPort;
  approvals: ApprovalPort;
}

// ---------------------------------------------------------------- errors

export type ClarificationPhase = Clarification['phase'];

export interface ClarificationSpec {
  question: string;
  help?: string;
  phase?: ClarificationPhase;
  /** How the answer reads once known, e.g. "Capitalization threshold: $2,500". */
  known?: string;
  /** 'missing_document' asks for an upload; the default asks for an answer. */
  reason?: 'missing_document' | 'policy_decision';
}

/** Thrown by `ctx.clarify`: the skill cannot proceed without a human answer. */
export class ClarificationNeeded extends Error {
  readonly code = 'CLARIFICATION_NEEDED';
  readonly question: string;
  readonly help: string;
  readonly phase: ClarificationPhase;
  readonly known: string;
  readonly reason: 'missing_document' | 'policy_decision';

  constructor(spec: ClarificationSpec) {
    super(spec.question);
    this.name = 'ClarificationNeeded';
    this.question = spec.question;
    this.help = spec.help ?? '';
    this.phase = spec.phase ?? 'Data';
    this.known = spec.known ?? '';
    this.reason = spec.reason ?? 'policy_decision';
  }

  toClarification(id: string): Clarification {
    return { id, phase: this.phase, question: this.question, help: this.help, known: this.known };
  }
}

/** A skill's input or output broke its Zod contract. Never retried: it is a bug, not a judgment call. */
export class SkillValidationError extends Error {
  readonly code = 'SKILL_VALIDATION';
  constructor(
    readonly skillId: string,
    readonly phase: 'input' | 'output',
    readonly issues: z.ZodIssue[],
  ) {
    const detail = issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    super(`Skill ${skillId} ${phase === 'input' ? 'rejected its input' : 'returned invalid output'}: ${detail}`);
    this.name = 'SkillValidationError';
  }
}

export class ServiceUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  constructor(service: string, method: string) {
    super(`No ${service} service is configured (called ${service}.${method}).`);
    this.name = 'ServiceUnavailableError';
  }
}

// ---------------------------------------------------------------- context

/** The events a skill may raise itself; lifecycle events belong to the executor. */
export type SkillEvent = Extract<AgentEvent, { type: 'tool_called' | 'tool_result' | 'progress' | 'artifact_created' }>;

export interface SkillContext {
  readonly runId: string;
  /** The graph node this work belongs to; every event carries it. */
  readonly stepId: string;
  readonly client: string;
  /** 1-based attempt number of the enclosing node. */
  readonly attempt: number;
  /** Checks that failed on the previous attempt, so the worker can correct itself. */
  readonly feedback: readonly CheckResult[];
  readonly signal: AbortSignal;
  readonly services: SkillServices;
  /** Present when the running skill is bound to a SKILL.md playbook. */
  readonly playbook?: Playbook;
  emit(event: SkillEvent): void;
  /** Calls a tool through the ToolCaller, emitting tool_called / tool_result around it. */
  callTool<T = unknown>(tool: ToolName, args: unknown): Promise<ToolCallResult<T>>;
  /** Progress within this step, 0–100. */
  progress(pct: number, note: string): void;
  /** Stops the skill with a question for a human. */
  clarify(question: string | ClarificationSpec): never;
  /** Records the source records that justify this step's figures. Returns them for inline use. */
  cite(refs: readonly SourceRef[]): SourceRef[];
}

export interface SkillContextInit {
  runId: string;
  stepId: string;
  client: string;
  services?: Partial<SkillServices>;
  emit?: (event: SkillEvent) => void;
  signal?: AbortSignal;
  attempt?: number;
  feedback?: readonly CheckResult[];
  onCite?: (refs: SourceRef[]) => void;
}

/** A port nobody configured fails loudly on first use instead of returning undefined. */
function unavailable<T extends object>(service: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      // Keep the proxy from looking like a thenable or leaking into inspection.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => {
        throw new ServiceUnavailableError(service, prop);
      };
    },
  });
}

export function resolveServices(services: Partial<SkillServices> = {}): SkillServices {
  return {
    tools: services.tools ?? unavailable<ToolCaller>('tools'),
    memory: services.memory ?? unavailable<MemoryPort>('memory'),
    graph: services.graph ?? unavailable<GraphPort>('graph'),
    ontology: services.ontology ?? unavailable<OntologyPort>('ontology'),
    periods: services.periods ?? unavailable<PeriodPort>('periods'),
    approvals: services.approvals ?? unavailable<ApprovalPort>('approvals'),
  };
}

/** Builds a context. The executor uses it per attempt; tests and ad-hoc callers can too. */
export function createSkillContext(init: SkillContextInit): SkillContext {
  const services = resolveServices(init.services);
  const emit = init.emit ?? (() => {});
  const signal = init.signal ?? new AbortController().signal;
  const attempt = init.attempt ?? 1;
  let toolSeq = 0;
  const ctx: SkillContext = {
    runId: init.runId,
    stepId: init.stepId,
    client: init.client,
    attempt,
    feedback: init.feedback ?? [],
    signal,
    services,
    emit,
    async callTool<T = unknown>(tool: ToolName, args: unknown): Promise<ToolCallResult<T>> {
      signal.throwIfAborted();
      // Deterministic ids (step, attempt, sequence) keep replayed event logs comparable.
      const toolCallId = `${init.stepId}#${attempt}.${++toolSeq}`;
      emit({ type: 'tool_called', stepId: init.stepId, tool, args, toolCallId });
      try {
        const res = await services.tools.call<T>({ runId: init.runId, stepId: init.stepId, tool, args, toolCallId, signal });
        emit({
          type: 'tool_result',
          stepId: init.stepId,
          ok: res.ok,
          summary: res.summary,
          toolCallId,
          provenance: res.provenance,
          table: res.table,
        });
        return res;
      } catch (err) {
        emit({ type: 'tool_result', stepId: init.stepId, ok: false, summary: errorMessage(err), toolCallId });
        throw err;
      }
    },
    progress(pct: number, note: string) {
      emit({ type: 'progress', stepId: init.stepId, pct: Math.max(0, Math.min(100, pct)), note });
    },
    clarify(question: string | ClarificationSpec): never {
      throw new ClarificationNeeded(typeof question === 'string' ? { question } : question);
    },
    cite(refs: readonly SourceRef[]): SourceRef[] {
      const list = [...refs];
      init.onCite?.(list);
      return list;
    },
  };
  return ctx;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- runnables

export type RunnableType = 'skill' | 'chain' | 'workflow';

export interface Runnable<I = unknown, O = unknown> {
  readonly type: RunnableType;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly kind: SkillKind;
  readonly effect: Effect;
  readonly model: ModelTier;
  readonly input: z.ZodTypeAny;
  readonly output: z.ZodTypeAny;
  /** id@version plus the fingerprints of everything it composes; keys the replay cache. */
  readonly fingerprint: string;
  /** Property (not method) syntax so input types are checked contravariantly. */
  readonly run: (ctx: SkillContext, input: I) => Promise<O>;
}

/** Heterogeneous collections (chain steps, graph nodes) hold runnables of any I/O. */
export type AnyRunnable = Runnable<any, any>;

export interface Skill<I = unknown, O = unknown> extends Runnable<I, O> {
  readonly type: 'skill';
  readonly playbook?: Playbook;
}

export interface SkillDefinition<IS extends z.ZodTypeAny, OS extends z.ZodTypeAny> {
  id: string;
  version: string;
  name: string;
  description: string;
  kind: SkillKind;
  effect: Effect;
  model: ModelTier;
  input: IS;
  output: OS;
  run(ctx: SkillContext, input: z.output<IS>): Promise<z.input<OS>> | z.input<OS>;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Shared id/version rules for skills, chains and workflows. */
export function assertIdentity(what: string, id: string, version: string): void {
  if (!ID_RE.test(id)) throw new Error(`${what} id "${id}" must be lowercase kebab-case.`);
  if (!VERSION_RE.test(version)) throw new Error(`${what} ${id} version "${version}" must be semver (e.g. 1.0.0).`);
}

export function defineSkill<IS extends z.ZodTypeAny, OS extends z.ZodTypeAny>(
  def: SkillDefinition<IS, OS>,
): Skill<z.input<IS>, z.output<OS>> {
  assertIdentity('Skill', def.id, def.version);
  // Routing rule: deterministic work never calls a model, agentic work always does.
  if (def.kind === 'deterministic' && def.model !== 'none') {
    throw new Error(`Skill ${def.id} is deterministic and must use model 'none', not '${def.model}'.`);
  }
  if (def.kind === 'agentic' && def.model === 'none') {
    throw new Error(`Skill ${def.id} is agentic and needs a model tier ('small' or 'frontier').`);
  }
  const run = async (ctx: SkillContext, raw: z.input<IS>): Promise<z.output<OS>> => {
    ctx.signal.throwIfAborted();
    const input = def.input.safeParse(raw);
    if (!input.success) throw new SkillValidationError(def.id, 'input', input.error.issues);
    const result = await def.run(ctx, input.data);
    const output = def.output.safeParse(result);
    if (!output.success) throw new SkillValidationError(def.id, 'output', output.error.issues);
    return output.data;
  };
  return Object.freeze({
    type: 'skill' as const,
    id: def.id,
    version: def.version,
    name: def.name,
    description: def.description,
    kind: def.kind,
    effect: def.effect,
    model: def.model,
    input: def.input,
    output: def.output,
    fingerprint: `${def.id}@${def.version}`,
    run,
  });
}
