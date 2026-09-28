import { assertIdentity, type AnyRunnable, type Runnable, type SkillContext } from './skill';
import { maxEffect, maxModel } from './types';

/**
 * A chain is a predictable sub-process: skills in a fixed order with pure
 * input-mapping functions between them. A chain is itself a Runnable, so it
 * can be a graph node, a workflow step or a step of another chain.
 */

export interface ChainMeta {
  id: string;
  version: string;
  name: string;
  description?: string;
}

/** What a mapping function may look at: the chain input and every earlier step's output. */
export interface ChainTrail<I = unknown> {
  readonly input: I;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface ChainStep {
  readonly runnable: AnyRunnable;
  /** Output key in the trail; the step id, suffixed `#2`, `#3` when a skill repeats. */
  readonly key: string;
  readonly map?: (prev: unknown, trail: ChainTrail) => unknown;
}

export interface Chain<I = unknown, O = unknown> extends Runnable<I, O> {
  readonly type: 'chain';
  readonly steps: readonly ChainStep[];
  /** Append a step whose input is exactly the previous output. */
  then<O2>(next: Runnable<O, O2>): Chain<I, O2>;
  /** Append a step with a pure mapping from the previous output (and the trail) to its input. */
  then<N, O2>(next: Runnable<N, O2>, map: (prev: O, trail: ChainTrail<I>) => N): Chain<I, O2>;
}

function assertComposable(owner: string, r: AnyRunnable): void {
  // Workflow outcomes carry gate semantics a chain cannot honour.
  if (r.type === 'workflow') throw new Error(`Chain ${owner} cannot contain workflow ${r.id}; compose workflows in the graph.`);
}

function build<I, O>(meta: ChainMeta, steps: readonly ChainStep[]): Chain<I, O> {
  const runnables = steps.map((s) => s.runnable);
  const first = runnables[0];
  const last = runnables[runnables.length - 1];

  const run = async (ctx: SkillContext, input: I): Promise<O> => {
    const outputs: Record<string, unknown> = {};
    let prev: unknown = input;
    for (const step of steps) {
      ctx.signal.throwIfAborted();
      // Mappers see a frozen snapshot so they stay pure with respect to the trail.
      const trail: ChainTrail = { input, outputs: Object.freeze({ ...outputs }) };
      const stepInput = step.map ? step.map(prev, trail) : prev;
      prev = await step.runnable.run(ctx, stepInput);
      outputs[step.key] = prev;
    }
    return prev as O;
  };

  const self = {
    type: 'chain' as const,
    id: meta.id,
    version: meta.version,
    name: meta.name,
    description: meta.description ?? '',
    kind: runnables.some((r) => r.kind === 'agentic') ? ('agentic' as const) : ('deterministic' as const),
    effect: maxEffect(runnables.map((r) => r.effect)),
    model: maxModel(runnables.map((r) => r.model)),
    input: first.input,
    output: last.output,
    fingerprint: `${meta.id}@${meta.version}[${runnables.map((r) => r.fingerprint).join(',')}]`,
    steps,
    run,
    then(next: AnyRunnable, map?: (prev: unknown, trail: ChainTrail) => unknown) {
      assertComposable(meta.id, next);
      return build(meta, [...steps, { runnable: next, key: keyFor(steps, next.id), map }]);
    },
  };
  return Object.freeze(self) as unknown as Chain<I, O>;
}

function keyFor(steps: readonly ChainStep[], id: string): string {
  const n = steps.filter((s) => s.runnable.id === id).length;
  return n === 0 ? id : `${id}#${n + 1}`;
}

export function chain<I, O>(meta: ChainMeta, first: Runnable<I, O>): Chain<I, O> {
  assertIdentity('Chain', meta.id, meta.version);
  assertComposable(meta.id, first);
  return build<I, O>(meta, [{ runnable: first, key: first.id }]);
}
