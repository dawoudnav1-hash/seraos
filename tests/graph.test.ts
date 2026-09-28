import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CheckResult } from '@/lib/engine/types';
import type { AgentEvent, Artifact, Blocker, RunStatus } from '@/lib/domain/types';
import { applyEvent, emptyRun } from '@/lib/domain/reducer';
import { canTransition } from '@/lib/domain/state-machine';
import {
  CAPABILITY_CATALOG,
  GraphCycleError,
  GraphDefinitionError,
  MemoryReplayCache,
  SkillValidationError,
  bindSkill,
  chain,
  createSkillContext,
  defineSkill,
  loadPlaybooks,
  node,
  parseFrontmatter,
  periodOpen,
  planGraph,
  playbookContext,
  requireApproval,
  runGraph,
  stableStringify,
  verificationPassed,
  workflow,
  type Effect,
  type GraphNode,
  type RunGraphOptions,
  type ToolCaller,
} from '@/lib/graph';

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(id: string, pass: boolean, confidence = 1): CheckResult {
  return { id, layer: 'tie_out', pass, confidence, message: pass ? `${id} ok` : `${id} does not tie` };
}

/** Counts how many probes are in flight at once, per effect. */
function tracker() {
  const inFlight: Record<string, number> = {};
  const max: Record<string, number> = {};
  const started: string[] = [];
  return {
    started,
    max,
    async enter(id: string, group: string, ms: number) {
      started.push(id);
      inFlight[group] = (inFlight[group] ?? 0) + 1;
      max[group] = Math.max(max[group] ?? 0, inFlight[group]);
      await sleep(ms);
      inFlight[group]--;
    },
  };
}

function probe(id: string, effect: Effect, t: ReturnType<typeof tracker>, ms = 25) {
  return defineSkill({
    id,
    version: '1.0.0',
    name: `Probe ${id}`,
    description: 'Test probe',
    kind: 'deterministic',
    effect,
    model: 'none',
    input: z.unknown(),
    output: z.object({ id: z.string(), saw: z.array(z.string()) }),
    async run(_ctx, input) {
      await t.enter(id, effect, ms);
      const saw = input && typeof input === 'object' ? Object.keys(input as object) : [];
      return { id, saw };
    },
  });
}

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => void events.push(e), of: <T extends AgentEvent['type']>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type) };
}

const base = (extra: Partial<RunGraphOptions> = {}): RunGraphOptions => ({ runId: 'run_test', client: 'Brevard Logistics', ...extra });

const amountSkill = (id: string, run: (attempt: number) => number) =>
  defineSkill({
    id,
    version: '1.0.0',
    name: id,
    description: 'Returns a total',
    kind: 'deterministic',
    effect: 'propose',
    model: 'none',
    input: z.unknown(),
    output: z.object({ totalCents: z.number().int() }),
    run: (ctx) => ({ totalCents: run(ctx.attempt) }),
  });

// ---------------------------------------------------------------- skills

describe('skills', () => {
  it('validates input with Zod and enforces the model routing rule at definition', async () => {
    const double = defineSkill({
      id: 'double',
      version: '1.0.0',
      name: 'Double',
      description: 'Doubles cents',
      kind: 'deterministic',
      effect: 'read',
      model: 'none',
      input: z.object({ cents: z.number().int() }),
      output: z.object({ cents: z.number().int() }),
      run: (_ctx, { cents }) => ({ cents: cents * 2 }),
    });
    const ctx = createSkillContext({ runId: 'r', stepId: 's', client: 'c' });
    expect(await double.run(ctx, { cents: 21 })).toEqual({ cents: 42 });
    await expect(double.run(ctx, { cents: 1.5 })).rejects.toBeInstanceOf(SkillValidationError);

    const bad = { id: 'x', version: '1.0.0', name: 'x', description: '', effect: 'read' as const, input: z.unknown(), output: z.unknown(), run: () => null };
    expect(() => defineSkill({ ...bad, kind: 'deterministic', model: 'small' })).toThrow(/must use model 'none'/);
    expect(() => defineSkill({ ...bad, kind: 'agentic', model: 'none' })).toThrow(/needs a model tier/);
    expect(() => defineSkill({ ...bad, id: 'Not Kebab', kind: 'deterministic', model: 'none' })).toThrow(/kebab-case/);
  });

  it('routes tool calls through ctx with events, collects citations, and releases artifacts only after verification', async () => {
    const { events, emit, of } = collect();
    const tools: ToolCaller = { call: vi.fn(async () => ({ ok: true, summary: 'Fetched 3 assets', data: { count: 3 } as never })) };
    const artifact: Artifact = { id: 'art_fa', filename: 'FA_Rollforward.xlsx', kind: 'xlsx', sizeBytes: 2048, url: '/a', generatedBy: 'LedgerAgent' };
    const fetchRegister = defineSkill({
      id: 'fetch-register',
      version: '1.0.0',
      name: 'Fetch register',
      description: '',
      kind: 'deterministic',
      effect: 'read',
      model: 'none',
      input: z.unknown(),
      output: z.object({ count: z.number(), attempt: z.number() }),
      async run(ctx) {
        const res = await ctx.callTool<{ count: number }>('fetchSubledger', { ledger: 'fixed-assets' });
        ctx.cite([{ system: 'register', id: 'FA-2201' }, { system: 'register', id: 'FA-2201' }]);
        ctx.emit({ type: 'artifact_created', artifact: { ...artifact, sizeBytes: 1000 * ctx.attempt } });
        return { count: res.data.count, attempt: ctx.attempt };
      },
    });
    const res = await runGraph(
      { id: 'g', nodes: [node({ id: 'fetch', runnable: fetchRegister, verify: (out) => [check('fresh', out.attempt > 1)] })] },
      base({ emit, services: { tools } }),
    );
    expect(res.nodes.fetch.status).toBe('completed');
    expect(tools.call).toHaveBeenCalledTimes(2);
    expect(of('tool_called').map((e) => e.toolCallId)).toEqual(['fetch#1.1', 'fetch#2.1']);
    expect(of('tool_result').every((e) => e.ok && e.summary === 'Fetched 3 assets')).toBe(true);
    expect(res.nodes.fetch.sources).toEqual([{ system: 'register', id: 'FA-2201' }]);
    // Only the verified attempt's artifact surfaces.
    expect(of('artifact_created').map((e) => e.artifact.sizeBytes)).toEqual([2000]);
    expect(events.findIndex((e) => e.type === 'artifact_created')).toBeLessThan(events.findIndex((e) => e.type === 'step_completed'));
  });
});

// ---------------------------------------------------------------- chains

describe('chains', () => {
  const parse = defineSkill({
    id: 'parse-register',
    version: '1.0.0',
    name: 'Parse register',
    description: '',
    kind: 'deterministic',
    effect: 'read',
    model: 'none',
    input: z.object({ csv: z.string() }),
    output: z.object({ rows: z.array(z.object({ id: z.string(), costCents: z.number().int() })) }),
    run: (_ctx, { csv }) => ({
      rows: csv.split('\n').map((line) => {
        const [id, cost] = line.split(',');
        return { id, costCents: Number(cost) };
      }),
    }),
  });
  const sum = defineSkill({
    id: 'sum-cost',
    version: '2.1.0',
    name: 'Sum cost',
    description: '',
    kind: 'deterministic',
    effect: 'read',
    model: 'none',
    input: z.object({ costs: z.array(z.number().int()) }),
    output: z.object({ totalCents: z.number().int() }),
    run: (_ctx, { costs }) => ({ totalCents: costs.reduce((a, b) => a + b, 0) }),
  });

  it('runs skills in order through pure mappers and is itself runnable as a graph node', async () => {
    const c = chain({ id: 'register-total', version: '1.0.0', name: 'Register total' }, parse).then(sum, (prev, trail) => {
      expect(trail.outputs['parse-register']).toBe(prev);
      return { costs: prev.rows.map((r) => r.costCents) };
    });
    expect(c.effect).toBe('read');
    expect(c.fingerprint).toBe('register-total@1.0.0[parse-register@1.0.0,sum-cost@2.1.0]');
    const res = await runGraph({ id: 'g', nodes: [node({ id: 'total', runnable: c })] }, base({ input: { csv: 'FA-1,2239200\nFA-2,1449818' } }));
    expect(res.outputs.total).toEqual({ totalCents: 3689018 });

    // @ts-expect-error — parse's output does not fit sum's input without a mapper.
    const unmapped = chain({ id: 'unmapped', version: '1.0.0', name: 'Unmapped' }, parse).then(sum);
    await expect(unmapped.run(createSkillContext({ runId: 'r', stepId: 's', client: 'c' }), { csv: 'FA-1,1' })).rejects.toThrow(/sum-cost rejected its input/);
  });
});

// ---------------------------------------------------------------- scheduling

describe('graph scheduling', () => {
  it('runs read nodes in a layer concurrently, bounded by the concurrency limit', async () => {
    const t = tracker();
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node({ id, runnable: probe(`read-${id}`, 'read', t, 30) }));
    const started = Date.now();
    const res = await runGraph({ id: 'g', nodes }, base({ concurrency: 3 }));
    expect(res.status).toBe('completed');
    expect(t.max.read).toBe(3);
    // Six 30ms reads three at a time take ~60ms, not ~180ms.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('serializes propose and write nodes in declaration order while reads overlap', async () => {
    const t = tracker();
    const nodes: GraphNode[] = [
      node({ id: 'p2', runnable: probe('propose-2', 'propose', t, 15) }),
      node({ id: 'r1', runnable: probe('read-1', 'read', t, 30) }),
      node({ id: 'w1', runnable: probe('write-1', 'write', t, 15) }),
      node({ id: 'r2', runnable: probe('read-2', 'read', t, 30) }),
      node({ id: 'p1', runnable: probe('propose-1', 'propose', t, 15) }),
    ];
    await runGraph({ id: 'g', nodes }, base());
    expect(t.max.read).toBe(2);
    expect(t.max.propose).toBe(1);
    expect(t.max.write).toBe(1);
    // Reads of the layer first, then the serial lane in declaration order.
    expect(t.started).toEqual(['read-1', 'read-2', 'propose-2', 'write-1', 'propose-1']);
  });

  it('respects topological order and hands dependency outputs to dependents', async () => {
    const t = tracker();
    const { of, emit } = collect();
    const nodes: GraphNode[] = [
      node({ id: 'report', runnable: probe('report', 'propose', t, 5), dependsOn: ['schedule', 'bank'] }),
      node({ id: 'schedule', runnable: probe('schedule', 'propose', t, 5), dependsOn: ['register'] }),
      node({ id: 'register', runnable: probe('register', 'read', t, 5) }),
      node({ id: 'bank', runnable: probe('bank', 'read', t, 5) }),
    ];
    expect(planGraph(nodes).layers).toEqual([['register', 'bank'], ['schedule'], ['report']]);
    const res = await runGraph({ id: 'g', nodes }, base({ emit }));
    expect(t.started.indexOf('register')).toBeLessThan(t.started.indexOf('schedule'));
    expect(t.started.indexOf('schedule')).toBeLessThan(t.started.indexOf('report'));
    expect((res.outputs.report as { saw: string[] }).saw).toEqual(['schedule', 'bank']);
    const plan = of('plan_created')[0];
    expect(plan.steps.map((s) => s.id)).toEqual(['report', 'schedule', 'register', 'bank']);
    expect(plan.reasoning?.[0]).toBe('Layer 1 — in parallel: register, bank');
  });

  it('rejects cycles, unknown dependencies and duplicate ids before running anything', async () => {
    const t = tracker();
    const mk = (id: string, dependsOn: string[] = []) => node({ id, runnable: probe(id, 'read', t, 1), dependsOn });
    const { events, emit } = collect();
    const cyclic = runGraph({ id: 'g', nodes: [mk('a', ['c']), mk('b', ['a']), mk('c', ['b']), mk('d')] }, base({ emit }));
    await expect(cyclic).rejects.toBeInstanceOf(GraphCycleError);
    await expect(cyclic).rejects.toThrow('a → c → b → a');
    expect(events).toEqual([]);
    expect(t.started).toEqual([]);
    expect(() => planGraph([mk('a', ['ghost'])])).toThrow(/unknown node "ghost"/);
    expect(() => planGraph([mk('a'), mk('a')])).toThrow(GraphDefinitionError);
    expect(() => planGraph([mk('a', ['a'])])).toThrow(GraphCycleError);
  });
});

// ---------------------------------------------------------------- verification

describe('verification, retry and escalation', () => {
  it('re-runs a node with the failed checks as feedback and passes on retry', async () => {
    const feedbackSeen: string[][] = [];
    const s = defineSkill({
      id: 'tie-schedule',
      version: '1.0.0',
      name: 'Tie schedule',
      description: '',
      kind: 'deterministic',
      effect: 'propose',
      model: 'none',
      input: z.unknown(),
      output: z.object({ totalCents: z.number().int() }),
      run(ctx) {
        feedbackSeen.push(ctx.feedback.map((c) => c.id));
        return { totalCents: ctx.attempt === 1 ? 9_999 : 10_000 };
      },
    });
    const { of, emit } = collect();
    const res = await runGraph(
      { id: 'g', nodes: [node({ id: 'tie', runnable: s, verify: (out) => [check('ties-to-register', out.totalCents === 10_000)] })] },
      base({ emit }),
    );
    expect(res.status).toBe('completed');
    expect(res.nodes.tie.attempts).toBe(2);
    expect(feedbackSeen).toEqual([[], ['ties-to-register']]);
    expect(res.nodes.tie.failedAttempts.map((a) => a.map((c) => c.id))).toEqual([['ties-to-register']]);
    expect(of('progress').some((e) => e.note.startsWith('Retrying Tie schedule (2/3)'))).toBe(true);
    expect(of('blocked')).toHaveLength(0);
  });

  it('escalates with a structured blocker after maxAttempts and skips only dependents', async () => {
    const t = tracker();
    const { events, of, emit } = collect();
    const res = await runGraph(
      {
        id: 'g',
        nodes: [
          node({ id: 'accrual', runnable: amountSkill('accrual-schedule', () => 1), verify: () => [check('ties-to-gl', false), check('reasonable', true, 0.4)], minConfidence: 0.7 }),
          node({ id: 'je', runnable: probe('accrual-je', 'propose', t, 1), dependsOn: ['accrual'] }),
          node({ id: 'reverse', runnable: probe('reversing-je', 'propose', t, 1), dependsOn: ['je'] }),
          node({ id: 'flux', runnable: probe('flux', 'read', t, 1) }),
        ],
      },
      base({ emit }),
    );
    expect(res.status).toBe('blocked');
    expect(res.nodes.accrual.attempts).toBe(3);
    expect(res.nodes.je.status).toBe('skipped');
    expect(res.nodes.je.skippedBecause).toBe('accrual is blocked');
    expect(res.nodes.reverse.skippedBecause).toBe('je is skipped');
    expect(res.nodes.flux.status).toBe('completed');
    expect(t.started).toEqual(['flux']);
    const [blocked] = of('blocked');
    const blocker: Blocker = blocked.blocker;
    expect(blocker).toMatchObject({ stepId: 'accrual', reason: 'low_confidence', resolution: { kind: 'confirm' } });
    expect(blocker.detail).toContain('ties-to-gl');
    expect(blocker.detail).toContain('reasonable [tie_out, 40%]');
    // Raised after independent work drained, so it is the run's final state.
    expect(events.at(-1)?.type).toBe('blocked');
  });
});

// ---------------------------------------------------------------- workflows and gates

describe('workflows and compliance gates', () => {
  const draft = defineSkill({
    id: 'draft-depreciation',
    version: '1.0.0',
    name: 'Draft depreciation',
    description: '',
    kind: 'deterministic',
    effect: 'propose',
    model: 'none',
    input: z.object({ period: z.string() }),
    output: z.object({ entries: z.array(z.object({ id: z.string(), amountCents: z.number().int() })) }),
    run: () => ({ entries: [{ id: 'je_dep_2026_04', amountCents: 125_000 }] }),
  });

  function setup() {
    const afterGate = vi.fn();
    const annotate = defineSkill({
      id: 'annotate-entries',
      version: '1.0.0',
      name: 'Annotate',
      description: '',
      kind: 'deterministic',
      effect: 'propose',
      model: 'none',
      input: z.unknown(),
      output: z.unknown(),
      run: (_ctx, input) => {
        afterGate();
        return input;
      },
    });
    const post = defineSkill({
      id: 'sync-approved-jes',
      version: '1.0.0',
      name: 'Post approved entries',
      description: '',
      kind: 'deterministic',
      effect: 'write',
      model: 'none',
      input: z.unknown(),
      output: z.object({ posted: z.number() }),
      async run(ctx) {
        await ctx.callTool('postJournalEntry', { memo: 'April depreciation' });
        return { posted: 1 };
      },
    });
    const wf = workflow({ id: 'depreciation-close', version: '1.0.0', name: 'Depreciation close' }, chain({ id: 'depreciation', version: '1.0.0', name: 'Depreciation' }, draft), {
      verify: (out) => [check('entries-balance', out.entries.length > 0)],
      propose: (out) =>
        out.entries.map((e) => ({ id: e.id, kind: 'journal_entry' as const, title: 'April depreciation', payload: e, sources: [{ system: 'register', id: 'FA-2201' }] })),
    })
      .gate(periodOpen())
      .gate(verificationPassed())
      .gate(requireApproval('dual'))
      .then(annotate);
    const tools: ToolCaller = { call: vi.fn(async () => ({ ok: true, summary: 'Posted', data: {} as never })) };
    const graph = { id: 'close', nodes: [node({ id: 'depreciation', runnable: wf }), node({ id: 'post', runnable: post, dependsOn: ['depreciation'] })] };
    return { wf, post, graph, tools, afterGate };
  }

  it('stops at requireApproval with proposals held and nothing committed', async () => {
    const { graph, tools, afterGate, wf } = setup();
    expect(wf.effect).toBe('propose');
    const { of, emit } = collect();
    const res = await runGraph(graph, base({ emit, input: { period: '2026-04' }, services: { tools, periods: { isOpen: async () => true } } }));
    expect(res.status).toBe('blocked');
    expect(res.nodes.depreciation.status).toBe('awaiting_approval');
    expect(res.nodes.depreciation.approval).toMatchObject({ tier: 'dual', required: 2, have: 0, proposalIds: ['je_dep_2026_04'] });
    expect(res.proposals.map((p) => [p.id, p.nodeId])).toEqual([['je_dep_2026_04', 'depreciation']]);
    expect(res.nodes.depreciation.checks.map((c) => [c.id, c.pass])).toEqual([
      ['entries-balance', true],
      ['gate:periodOpen', true],
      ['gate:verificationPassed', true],
      ['gate:requireApproval', false],
    ]);
    expect(res.nodes.post.status).toBe('skipped');
    expect(tools.call).not.toHaveBeenCalled();
    expect(afterGate).not.toHaveBeenCalled();
    expect(of('blocked')[0].blocker).toMatchObject({ reason: 'approval_required', resolution: { kind: 'approve' } });
  });

  it('continues past the gate once approvals for exactly these proposals are on file', async () => {
    const { graph, tools, afterGate } = setup();
    const periods = { isOpen: async () => true };
    const first = await runGraph(graph, base({ input: { period: '2026-04' }, services: { tools, periods } }));
    const subject = first.approvals[0].subject;
    const approvals = { count: async (_runId: string, s: string) => (s === subject ? 2 : 0) };
    const res = await runGraph(graph, base({ input: { period: '2026-04' }, services: { tools, periods, approvals } }));
    expect(res.status).toBe('completed');
    expect(afterGate).toHaveBeenCalledTimes(1);
    expect(tools.call).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tools.call).mock.calls[0][0]).toMatchObject({ tool: 'postJournalEntry', stepId: 'post' });
  });

  it('refuses write steps inside a workflow and stops without retry on a closed period', async () => {
    const { post, graph } = setup();
    expect(() => workflow({ id: 'bad', version: '1.0.0', name: 'Bad' }, post)).toThrow(/never commit/);
    const res = await runGraph(graph, base({ input: { period: '2026-03' }, services: { periods: { isOpen: async () => false } } }));
    expect(res.nodes.depreciation.status).toBe('blocked');
    expect(res.nodes.depreciation.attempts).toBe(1);
    expect(res.blockers[0]).toMatchObject({ reason: 'policy_decision' });
    expect(res.blockers[0].detail).toContain('Period 2026-03 is closed');
  });
});

// ---------------------------------------------------------------- replay, failures, clarifications

describe('replay, failures and clarifications', () => {
  it('replays an unchanged node from the cache and misses on any change to input, version or client', async () => {
    let runs = 0;
    const mk = (version: string) =>
      defineSkill({
        id: 'flux',
        version,
        name: 'Flux',
        description: '',
        kind: 'deterministic',
        effect: 'read',
        model: 'none',
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ deltaCents: z.number() }),
        run: (_ctx, { a, b }) => {
          runs++;
          return { deltaCents: b - a };
        },
      });
    const cache = new MemoryReplayCache();
    const graph = (v = '1.0.0') => ({ id: 'g', nodes: [node({ id: 'flux', runnable: mk(v), verify: () => [check('ok', true)] })] });
    const first = await runGraph(graph(), base({ cache, input: { a: 100, b: 250 } }));
    const again = await runGraph(graph(), base({ cache, input: { b: 250, a: 100 } }));
    expect(runs).toBe(1);
    expect(again.nodes.flux).toMatchObject({ status: 'completed', cached: true, output: { deltaCents: 150 } });
    expect(first.nodes.flux.cached).toBe(false);
    await runGraph(graph(), base({ cache, input: { a: 100, b: 300 } }));
    await runGraph(graph('1.0.1'), base({ cache, input: { a: 100, b: 250 } }));
    await runGraph(graph(), base({ cache, client: 'Another Client', input: { a: 100, b: 250 } }));
    expect(runs).toBe(4);
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(stableStringify({ a: [1, { d: 2 }], b: 1 }));
  });

  it('surfaces a Zod contract violation as run_failed without retrying', async () => {
    const t = tracker();
    const bad = defineSkill({
      id: 'bad-output',
      version: '1.0.0',
      name: 'Bad output',
      description: '',
      kind: 'deterministic',
      effect: 'propose',
      model: 'none',
      input: z.unknown(),
      output: z.object({ amountCents: z.number().int() }),
      run: () => ({ amountCents: 12.5 }),
    });
    const { events, of, emit } = collect();
    const res = await runGraph(
      {
        id: 'g',
        nodes: [
          node({ id: 'read', runnable: probe('read', 'read', t, 1) }),
          node({ id: 'bad', runnable: bad, dependsOn: ['read'] }),
          node({ id: 'after', runnable: probe('after', 'propose', t, 1), dependsOn: ['bad'] }),
        ],
      },
      base({ emit }),
    );
    expect(res.status).toBe('failed');
    expect(res.nodes.bad).toMatchObject({ status: 'failed', attempts: 1 });
    expect(res.nodes.after.status).toBe('skipped');
    expect(res.error).toMatch(/bad-output returned invalid output: amountCents: Expected integer/);
    expect(events.at(-1)).toEqual({ type: 'run_failed', error: res.error });
    expect(of('blocked')).toHaveLength(0);
  });

  it('surfaces ClarificationNeeded as a clarification and an answer_question blocker', async () => {
    const policy = defineSkill({
      id: 'capitalization-policy',
      version: '1.0.0',
      name: 'Capitalization policy',
      description: '',
      kind: 'agentic',
      effect: 'read',
      model: 'small',
      input: z.unknown(),
      output: z.object({ thresholdCents: z.number() }),
      run: (ctx) => ctx.clarify({ question: 'What is the capitalization threshold?', help: 'Needed to test April purchases.', phase: 'Scope' }),
    });
    const { of, emit } = collect();
    const res = await runGraph({ id: 'g', nodes: [node({ id: 'policy', runnable: policy })] }, base({ emit }));
    expect(res.status).toBe('needs_clarification');
    expect(res.nodes.policy.attempts).toBe(1);
    expect(res.clarifications).toEqual([
      { id: 'clar_run_test_policy', phase: 'Scope', question: 'What is the capitalization threshold?', help: 'Needed to test April purchases.', known: '' },
    ]);
    expect(of('blocked')[0].blocker).toMatchObject({ reason: 'policy_decision', resolution: { kind: 'answer_question' } });
  });

  it('emits an event stream the run reducer and state machine accept', async () => {
    const t = tracker();
    const { events, emit } = collect();
    await runGraph(
      {
        id: 'g',
        nodes: [
          node({ id: 'fetch', runnable: probe('fetch', 'read', t, 1) }),
          node({ id: 'schedule', runnable: amountSkill('prepaid-schedule', () => 5), dependsOn: ['fetch'], verify: () => [check('ties', false)], maxAttempts: 2 }),
          node({ id: 'analysis', runnable: probe('analysis', 'read', t, 1), dependsOn: ['fetch'] }),
        ],
      },
      base({ emit }),
    );
    const target = (e: AgentEvent): RunStatus | null =>
      e.type === 'plan_created' ? 'planning' : e.type === 'step_started' ? 'executing' : e.type === 'blocked' ? 'blocked' : e.type === 'run_failed' ? 'failed' : null;
    let run = emptyRun({ id: 'r', title: 'Prepaids', task: 'Close prepaids', client: 'Brevard Logistics', agent: 'LedgerAgent', createdAt: 0 });
    for (const e of events) {
      const to = target(e);
      if (to && to !== run.status) expect(canTransition(run.status, to, 'orchestrator')).toBe(true);
      run = applyEvent(run, e);
    }
    expect(run.status).toBe('blocked');
    expect(run.blocker?.stepId).toBe('schedule');
    expect(Object.fromEntries(run.steps.map((s) => [s.id, s.status]))).toEqual({ fetch: 'completed', schedule: 'blocked', analysis: 'completed' });
  });
});

// ---------------------------------------------------------------- playbooks

describe('SKILL.md playbooks', () => {
  const registry = loadPlaybooks(path.resolve(__dirname, '../skills'));
  const fa = registry.get('fixed-asset-depreciation');

  it('parses the reference playbook: frontmatter, nested maps and sections', () => {
    expect(fa).toMatchObject({
      version: '1.0.0',
      category: 'schedules',
      model: 'none',
      confidenceThreshold: 0.7,
      humanReviewThreshold: { confidenceBelow: 0.9, whenMaterial: true },
      tools: ['fetchSubledger', 'fetchTrialBalance', 'buildWorkbook'],
    });
    expect(Object.keys(fa.inputs)).toEqual(['period', 'register', 'expense_lines', 'gl_balances', 'policy']);
    expect(Object.keys(fa.outputs)).toEqual(['schedule', 'rollforward', 'draft_entries']);
    expect(fa.successCriteria).toContain('Every draft entry balances and every line cites a register row or GL line');
    expect(fa.sections.decisionRules).toContain('month after the asset is placed in service');
    expect(fa.sections.guardrails).toContain('Propose only');
    expect(registry.match('Run April depreciation and the fixed-asset roll-forward').map((p) => p.id)).toEqual(['fixed-asset-depreciation']);
    expect(registry.match('MACRS tax depreciation for the return')).toEqual([]);
  });

  it('parses the frontmatter subset and rejects what it does not support', () => {
    const fm = parseFrontmatter(
      [
        '# comment',
        'id: demo',
        "name: 'It''s quoted'",
        'label: "tab\\tescaped"',
        'count: 3',
        'enabled: false',
        'tags: [a, "b, c", 2]',
        'empty: []',
        'limits:',
        '  confidence_below: 0.9',
        '  when_material: true',
        'steps:',
        '  - first',
        '  - second # trailing comment',
      ].join('\n'),
    );
    expect(fm).toEqual({
      id: 'demo',
      name: "It's quoted",
      label: 'tab\tescaped',
      count: 3,
      enabled: false,
      tags: ['a', 'b, c', 2],
      empty: [],
      limits: { confidence_below: 0.9, when_material: true },
      steps: ['first', 'second'],
    });
    expect(() => parseFrontmatter('a:\n  b:\n    c: 1')).toThrow(/deeper than one level/);
    expect(() => parseFrontmatter('a: |\n  text')).toThrow(/Unsupported YAML/);
    expect(() => parseFrontmatter('a: 1\na: 2')).toThrow(/Duplicate key/);
  });

  it('binds an implementation only when id, version, model and schema keys match', async () => {
    const def = {
      id: 'fixed-asset-depreciation',
      name: 'Fixed-asset depreciation',
      description: '',
      kind: 'deterministic' as const,
      effect: 'propose' as const,
      model: 'none' as const,
      input: z.object({ period: z.string(), register: z.array(z.unknown()), expenseLines: z.array(z.unknown()), glBalances: z.unknown(), policy: z.unknown() }),
      output: z.object({ schedule: z.array(z.unknown()), rollforward: z.array(z.unknown()), draftEntries: z.array(z.unknown()) }),
    };
    let seen: string | undefined;
    const impl = defineSkill({
      ...def,
      version: '1.0.0',
      run: (ctx) => {
        seen = ctx.playbook?.id;
        return { schedule: [], rollforward: [], draftEntries: [] };
      },
    });
    const bound = bindSkill(fa, impl);
    expect(bound.playbook?.version).toBe('1.0.0');
    await bound.run(createSkillContext({ runId: 'r', stepId: 's', client: 'c' }), { period: '2026-04', register: [], expenseLines: [], glBalances: {}, policy: {} });
    expect(seen).toBe('fixed-asset-depreciation');

    expect(() => bindSkill(fa, defineSkill({ ...def, version: '1.1.0', run: () => ({ schedule: [], rollforward: [], draftEntries: [] }) }))).toThrow(/version 1.1.0 ≠ playbook 1.0.0/);
    const noPolicy = defineSkill({ ...def, version: '1.0.0', input: def.input.omit({ policy: true }), run: () => ({ schedule: [], rollforward: [], draftEntries: [] }) });
    expect(() => bindSkill(fa, noPolicy)).toThrow(/playbook inputs missing from the schema: policy/);
  });

  it('builds lean prompt context within the character budget, trimming procedure before guardrails', () => {
    const full = playbookContext(fa, 20_000);
    expect(full).toContain('## Procedure');
    expect(full).toContain('## Guardrails');
    expect(full).not.toContain('## Decision rules');
    expect(full).not.toContain('## Error handling');
    for (const max of [full.length, 3000, 2000, 1000, 600, 400, 50]) {
      expect(playbookContext(fa, max).length).toBeLessThanOrEqual(max);
    }
    const tight = playbookContext(fa, 3000);
    expect(tight).toContain('## Procedure');
    expect(tight).toContain('…');
    expect(tight).toContain('Propose only. Never post an entry');
    const tighter = playbookContext(fa, 1000);
    expect(tighter).not.toContain('## Procedure');
    expect(tighter).toContain('Propose only. Never post an entry');
    expect(playbookContext('fixed-asset-depreciation', 3000, registry)).toBe(tight);
  });
});

// ---------------------------------------------------------------- catalog

describe('capability catalog', () => {
  const EXPECTED = {
    transaction_processing: ['code-bank-transactions', 'categorize-expenses', 'detect-unmatched', 'exclude-invalid-transactions', 'sync-approved-transactions'],
    reconciliations: ['bank-reconciliation', 'credit-card-reconciliation', 'gl-reconciliation', 'stripe-reconciliation', 'flag-exceptions'],
    journal_entries: ['manual-je', 'accrual-je', 'reversing-je', 'payroll-je', 'revenue-recognition-je', 'depreciation-je', 'amortization-je', 'prepaid-je', 'fixed-asset-je', 'attach-evidence', 'sync-approved-jes'],
    schedules: ['fixed-asset-rollforward', 'depreciation-schedule', 'amortization-schedule', 'deferred-revenue-schedule', 'prepaid-schedule', 'accrual-schedule', 'balance-sheet-rollforward'],
    analysis: ['data-analysis', 'flux-analysis', 'variance-analysis', 'budget-vs-actual', 'period-over-period', 'revenue-analysis', 'expense-analysis', 'waterfall-analysis', 'management-commentary'],
    documents: ['read-pdf', 'ocr-document', 'extract-tables', 'read-excel', 'create-spreadsheet', 'modify-spreadsheet', 'merge-split-pdf', 'generate-workpaper'],
    reuse: ['reuse-workflow'],
  };

  it('lists every capability exactly once, in the right family, as an acyclic dependency graph', () => {
    const ids = CAPABILITY_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.values(EXPECTED).flat().sort());
    for (const [family, members] of Object.entries(EXPECTED)) {
      expect(CAPABILITY_CATALOG.filter((e) => e.family === family).map((e) => e.id)).toEqual(members);
    }
    expect(() => planGraph(CAPABILITY_CATALOG.map((e) => ({ id: e.id, dependsOn: [...(e.dependsOn ?? [])] })))).not.toThrow();
  });

  it('follows the model and effect rules', () => {
    const frontier = CAPABILITY_CATALOG.filter((e) => e.model === 'frontier').map((e) => e.id);
    expect(frontier.sort()).toEqual(['management-commentary', 'reuse-workflow', 'variance-analysis']);
    const small = CAPABILITY_CATALOG.filter((e) => e.model === 'small').map((e) => e.id);
    expect(small.sort()).toEqual(['categorize-expenses', 'code-bank-transactions', 'extract-tables', 'ocr-document']);
    const writes = CAPABILITY_CATALOG.filter((e) => e.effect === 'write');
    expect(writes.map((e) => e.id)).toEqual(['sync-approved-transactions', 'sync-approved-jes']);
    expect(writes.every((e) => e.model === 'none')).toBe(true);
    expect(CAPABILITY_CATALOG.filter((e) => e.family === 'journal_entries').every((e) => e.model === 'none')).toBe(true);
  });
});
