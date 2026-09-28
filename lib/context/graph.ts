/**
 * Context graph built from interaction. Nothing is preloaded: whatever an
 * agent touches (a tool call, a record, a document, a figure, an account, an
 * entity) becomes nodes and edges linked to the run and step that touched it.
 * Ids are deterministic, so observing the same thing twice merges instead of
 * duplicating, and later agents read the subgraph around their task.
 */
import type { Cents, SourceRef, Txn } from '@/lib/engine/types';
import { classifyAccount, clip, fitLines, formatCents, getConcept, getSubtype, isAccountSubtypeId, normalizeTerm } from './ontology';

// ─── Types ───────────────────────────────────────────────────────────────────

export const NODE_KINDS = ['run', 'step', 'tool_call', 'record', 'document', 'account', 'entity', 'figure', 'concept'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ['produced', 'cites', 'derived_from', 'mentions', 'belongs_to', 'instance_of'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export type Props = Record<string, unknown>;

/** A row of graph_nodes(id, kind, label, props jsonb, client, created_at, updated_at). */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  props: Props;
  client: string;
  createdAt: string;
  updatedAt: string;
}

/** A row of graph_edges(id, from_id, to_id, kind, props jsonb, run_id, step_id, created_at). */
export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  props: Props;
  runId: string | null;
  stepId: string | null;
  createdAt: string;
}

export interface NodeInput {
  id: string;
  kind: NodeKind;
  label: string;
  client: string;
  props?: Props;
}

export interface EdgeInput {
  fromId: string;
  toId: string;
  kind: EdgeKind;
  props?: Props;
  runId?: string | null;
  stepId?: string | null;
  /** Defaults to the deterministic `edgeId(fromId, kind, toId)`. */
  id?: string;
}

export interface NeighborOptions {
  direction?: 'out' | 'in' | 'both';
  edgeKinds?: EdgeKind[];
}

export interface Neighbor {
  edge: GraphEdge;
  node: GraphNode;
  direction: 'out' | 'in';
}

export interface NodeQuery {
  client: string;
  kinds?: NodeKind[];
  /** Case-insensitive substring of the label. */
  labelContains?: string;
  limit?: number;
}

/**
 * Storage contract. Merge semantics a SQL store should mirror:
 * - upsertNode: `INSERT … ON CONFLICT (id) DO UPDATE SET label = excluded.label,
 *   props = graph_nodes.props || excluded.props, updated_at = now()`; kind and client never change.
 * - upsertEdge: `INSERT … ON CONFLICT (id) DO UPDATE SET props = graph_edges.props || excluded.props`;
 *   run_id, step_id and created_at keep the first observation. Both endpoints must exist.
 * - neighbors and query return rows in a deterministic order (edge id; updated_at desc, id).
 */
export interface GraphStore {
  upsertNode(node: NodeInput): Promise<GraphNode>;
  upsertEdge(edge: EdgeInput): Promise<GraphEdge>;
  getNode(id: string): Promise<GraphNode | null>;
  neighbors(id: string, opts?: NeighborOptions): Promise<Neighbor[]>;
  query(q: NodeQuery): Promise<GraphNode[]>;
}

// ─── Deterministic ids ───────────────────────────────────────────────────────

// Escape the separator so ids stay unambiguous whatever the source ids contain.
const esc = (s: string) => s.replace(/%/g, '%25').replace(/:/g, '%3A');
const key = (kind: string, ...parts: string[]) => [kind, ...parts.map(esc)].join(':');

/** Stable JSON: sorted keys, undefined dropped. Same args → same tool-call id. */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** 53-bit non-cryptographic hash (cyrb53), base36. Only used to shorten ids. */
export function shortHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const slug = (s: string) => normalizeTerm(s).replace(/[ /]+/g, '-').slice(0, 60) || 'x';
const sourceKey = (s: SourceRef) => `${s.system}:${s.id}`;

/**
 * Every id is scoped by client (tenant isolation: two clients' QuickBooks can
 * both have JE 123). Same inputs always give the same id.
 */
export const graphIds = {
  run: (client: string, runId: string) => key('run', client, runId),
  step: (client: string, runId: string, stepId: string) => key('step', client, runId, stepId),
  toolCall: (client: string, runId: string, stepId: string | null | undefined, tool: string, fingerprint: string) =>
    key('tool_call', client, runId, stepId ?? '-', tool, fingerprint),
  record: (client: string, system: string, id: string) => key('record', client, system, id),
  document: (client: string, id: string) => key('document', client, id),
  account: (client: string, code: string) => key('account', client, code),
  entity: (client: string, id: string) => key('entity', client, id),
  /** Content-addressed: the same label, value and sources is the same figure, whichever run asserted it. */
  figure: (client: string, label: string, value: string, sources: SourceRef[]) =>
    key('figure', client, slug(label), shortHash(`${value}|${sources.map(sourceKey).sort().join(',')}`)),
  concept: (client: string, conceptId: string) => key('concept', client, conceptId),
};

export const edgeId = (fromId: string, kind: EdgeKind, toId: string) => `${fromId}|${kind}|${toId}`;

// ─── In-memory store ─────────────────────────────────────────────────────────

const copyNode = (n: GraphNode): GraphNode => ({ ...n, props: { ...n.props } });
const copyEdge = (e: GraphEdge): GraphEdge => ({ ...e, props: { ...e.props } });

export class InMemoryGraphStore implements GraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly outIdx = new Map<string, Set<string>>();
  private readonly inIdx = new Map<string, Set<string>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async upsertNode(input: NodeInput): Promise<GraphNode> {
    const ts = this.now();
    const existing = this.nodes.get(input.id);
    if (existing) {
      if (existing.kind !== input.kind || existing.client !== input.client) {
        throw new Error(`Node ${input.id} exists as ${existing.kind} for client ${existing.client}; refusing to change kind or client.`);
      }
      const merged: GraphNode = { ...existing, label: input.label || existing.label, props: { ...existing.props, ...(input.props ?? {}) }, updatedAt: ts };
      this.nodes.set(input.id, merged);
      return copyNode(merged);
    }
    const node: GraphNode = { id: input.id, kind: input.kind, label: input.label, client: input.client, props: { ...(input.props ?? {}) }, createdAt: ts, updatedAt: ts };
    this.nodes.set(node.id, node);
    return copyNode(node);
  }

  async upsertEdge(input: EdgeInput): Promise<GraphEdge> {
    if (!this.nodes.has(input.fromId) || !this.nodes.has(input.toId)) {
      throw new Error(`Edge ${input.kind} references a missing node (${input.fromId} → ${input.toId}).`);
    }
    const id = input.id ?? edgeId(input.fromId, input.kind, input.toId);
    const existing = this.edges.get(id);
    if (existing) {
      const merged: GraphEdge = { ...existing, props: { ...existing.props, ...(input.props ?? {}) } };
      this.edges.set(id, merged);
      return copyEdge(merged);
    }
    const edge: GraphEdge = {
      id,
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      props: { ...(input.props ?? {}) },
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      createdAt: this.now(),
    };
    this.edges.set(id, edge);
    if (!this.outIdx.has(edge.fromId)) this.outIdx.set(edge.fromId, new Set());
    if (!this.inIdx.has(edge.toId)) this.inIdx.set(edge.toId, new Set());
    this.outIdx.get(edge.fromId)!.add(id);
    this.inIdx.get(edge.toId)!.add(id);
    return copyEdge(edge);
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const n = this.nodes.get(id);
    return n ? copyNode(n) : null;
  }

  async neighbors(id: string, opts: NeighborOptions = {}): Promise<Neighbor[]> {
    const dir = opts.direction ?? 'both';
    const out: Neighbor[] = [];
    const collect = (ids: Set<string> | undefined, direction: 'out' | 'in') => {
      for (const eid of ids ?? []) {
        const e = this.edges.get(eid)!;
        if (opts.edgeKinds && !opts.edgeKinds.includes(e.kind)) continue;
        const other = this.nodes.get(direction === 'out' ? e.toId : e.fromId);
        if (other) out.push({ edge: copyEdge(e), node: copyNode(other), direction });
      }
    };
    if (dir !== 'in') collect(this.outIdx.get(id), 'out');
    if (dir !== 'out') collect(this.inIdx.get(id), 'in');
    return out.sort((a, b) => a.edge.id.localeCompare(b.edge.id) || a.direction.localeCompare(b.direction));
  }

  async query(q: NodeQuery): Promise<GraphNode[]> {
    const needle = q.labelContains?.toLowerCase();
    const rows = [...this.nodes.values()].filter(
      (n) => n.client === q.client && (!q.kinds || q.kinds.includes(n.kind)) && (!needle || n.label.toLowerCase().includes(needle)),
    );
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return rows.slice(0, q.limit ?? rows.length).map(copyNode);
  }

  /** Row counts, for tests and diagnostics. */
  size(): { nodes: number; edges: number } {
    return { nodes: this.nodes.size, edges: this.edges.size };
  }
}

// ─── Interactions ────────────────────────────────────────────────────────────

export interface ObservedFigure {
  label: string;
  /** As displayed, e.g. "$4,302.51". */
  value: string;
  valueCents?: Cents;
  sources: SourceRef[];
}

export interface ObservedAccount {
  code: string;
  name: string;
  /** Ontology subtype id (or a QBO subtype); classified by name when absent. */
  subtype?: string;
}

export interface ObservedEntity {
  id: string;
  name: string;
  /** vendor, customer, employee, bank, … */
  kind: string;
}

export interface ObservedDocument {
  id: string;
  name: string;
}

export interface Interaction {
  client: string;
  runId: string;
  stepId?: string;
  tool: string;
  args: unknown;
  summary: string;
  /** Records the tool call read. */
  sources: SourceRef[];
  figures?: ObservedFigure[];
  accounts?: ObservedAccount[];
  entities?: ObservedEntity[];
  documents?: ObservedDocument[];
  /** Ontology concept ids the step worked with, e.g. "je.depreciation". */
  concepts?: string[];
}

export interface TxnObservationContext {
  runId: string;
  stepId?: string;
  tool?: string;
  summary?: string;
}

export interface ObserveResult {
  toolCallId: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface SubgraphQuery {
  client: string;
  /** Node ids to start from (see `graphIds`). */
  seeds: string[];
  /** Hops from the seeds, in both directions. Default 2. */
  depth?: number;
  /** Only return these kinds (seeds always returned); traversal still passes through others. */
  kinds?: NodeKind[];
  edgeKinds?: EdgeKind[];
  /** Maximum nodes returned, nearest first. Default 100. */
  limit?: number;
}

export interface Subgraph {
  client: string;
  seeds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface ProvenanceTrail {
  target: GraphNode | null;
  /** Each path runs from the target back to a source record or document. */
  paths: GraphNode[][];
  /** Distinct records and documents the paths end at. */
  sources: GraphNode[];
  /** Tool calls that produced the target, with the step and run they belong to. */
  producedBy: { toolCall: GraphNode; step: GraphNode | null; run: GraphNode | null }[];
}

/** Collects what one observation touched, with run/step stamped on every edge. */
class Recorder {
  readonly nodeIds = new Set<string>();
  readonly edgeIds = new Set<string>();

  constructor(
    private readonly store: GraphStore,
    readonly client: string,
    private readonly runId: string,
    private readonly stepId: string | null,
  ) {}

  async node(input: Omit<NodeInput, 'client'>): Promise<GraphNode> {
    const n = await this.store.upsertNode({ ...input, client: this.client });
    this.nodeIds.add(n.id);
    return n;
  }

  async edge(from: GraphNode, kind: EdgeKind, to: GraphNode, props?: Props): Promise<GraphEdge> {
    const e = await this.store.upsertEdge({ fromId: from.id, toId: to.id, kind, props, runId: this.runId, stepId: this.stepId });
    this.edgeIds.add(e.id);
    return e;
  }

  /** A record node for a SourceRef. A bare ref never overwrites a better label from an earlier observation. */
  async record(s: SourceRef, props: Props = {}, preferredLabel?: string): Promise<GraphNode> {
    const id = graphIds.record(this.client, s.system, s.id);
    const existing = await this.store.getNode(id);
    const label = s.label ?? preferredLabel ?? existing?.label ?? sourceKey(s);
    return this.node({ id, kind: 'record', label, props: { system: s.system, recordId: s.id, ...props } });
  }

  async concept(conceptId: string): Promise<GraphNode | null> {
    const c = getConcept(conceptId);
    if (!c) return null;
    const cls = c.kind === 'account_subtype' ? { class: c.class, normalBalance: c.normalBalance } : {};
    return this.node({ id: graphIds.concept(this.client, c.id), kind: 'concept', label: c.label, props: { conceptId: c.id, conceptKind: c.kind, ...cls } });
  }

  result(toolCallId: string): ObserveResult {
    return { toolCallId, nodeIds: [...this.nodeIds], edgeIds: [...this.edgeIds] };
  }
}

// ─── ContextGraph ────────────────────────────────────────────────────────────

export class ContextGraph {
  constructor(readonly store: GraphStore = new InMemoryGraphStore()) {}

  /** Record one tool call and everything it touched. Idempotent for identical interactions. */
  async observe(i: Interaction): Promise<ObserveResult> {
    const rec = new Recorder(this.store, i.client, i.runId, i.stepId ?? null);
    const call = await this.toolCall(rec, i.runId, i.stepId, i.tool, shortHash(stableStringify(i.args)), i.args, i.summary);

    for (const s of i.sources) await rec.edge(call, 'cites', await rec.record(s));
    for (const d of i.documents ?? []) {
      const doc = await rec.node({ id: graphIds.document(i.client, d.id), kind: 'document', label: d.name, props: { documentId: d.id, name: d.name } });
      await rec.edge(call, 'cites', doc);
    }
    for (const a of i.accounts ?? []) await rec.edge(call, 'mentions', await this.account(rec, a));
    for (const e of i.entities ?? []) {
      const ent = await rec.node({ id: graphIds.entity(i.client, e.id), kind: 'entity', label: e.name, props: { entityId: e.id, name: e.name, entityKind: e.kind } });
      await rec.edge(call, 'mentions', ent);
    }
    for (const f of i.figures ?? []) {
      const fig = await rec.node({
        id: graphIds.figure(i.client, f.label, f.value, f.sources),
        kind: 'figure',
        label: f.label,
        props: { value: f.value, ...(f.valueCents !== undefined ? { valueCents: f.valueCents } : {}), sources: f.sources },
      });
      await rec.edge(call, 'produced', fig);
      for (const s of f.sources) await rec.edge(fig, 'derived_from', await rec.record(s));
    }
    for (const id of i.concepts ?? []) {
      const c = await rec.concept(id);
      if (c) await rec.edge(call, 'mentions', c);
    }
    return rec.result(call.id);
  }

  /** Ingest normalized transactions: each becomes a record tied to its account and counterparty. */
  async observeTransactions(client: string, txns: Txn[], ctx: TxnObservationContext): Promise<ObserveResult> {
    const rec = new Recorder(this.store, client, ctx.runId, ctx.stepId ?? null);
    const tool = ctx.tool ?? 'observe_transactions';
    // Fingerprint on the source ids, not the payload, so re-ingesting the same batch merges.
    const fingerprint = shortHash(txns.map((t) => sourceKey(t.source)).sort().join('|'));
    const call = await this.toolCall(rec, ctx.runId, ctx.stepId, tool, fingerprint, { count: txns.length }, ctx.summary ?? `Observed ${txns.length} transactions.`);

    for (const t of txns) {
      const props: Props = { txnId: t.id, date: t.date, amountCents: t.amountCents, description: t.description };
      if (t.counterparty) props.counterparty = t.counterparty;
      if (t.reference) props.reference = t.reference;
      if (t.currency) props.currency = t.currency;
      if (t.account) props.account = t.account;
      const record = await rec.record(t.source, props, `${t.date} ${t.description} ${formatCents(t.amountCents)}`);
      await rec.edge(call, 'cites', record);
      if (t.account) await rec.edge(record, 'belongs_to', await this.account(rec, { code: t.account }));
      if (t.counterparty) {
        const ent = await rec.node({
          id: graphIds.entity(client, `counterparty:${slug(t.counterparty)}`),
          kind: 'entity',
          label: t.counterparty,
          props: { name: t.counterparty, entityKind: 'counterparty' },
        });
        await rec.edge(record, 'mentions', ent);
      }
    }
    return rec.result(call.id);
  }

  private async toolCall(
    rec: Recorder,
    runId: string,
    stepId: string | undefined,
    tool: string,
    fingerprint: string,
    args: unknown,
    summary: string,
  ): Promise<GraphNode> {
    const client = rec.client;
    const run = await rec.node({ id: graphIds.run(client, runId), kind: 'run', label: `run ${runId}`, props: { runId } });
    let parent = run;
    if (stepId) {
      parent = await rec.node({ id: graphIds.step(client, runId, stepId), kind: 'step', label: `step ${stepId}`, props: { runId, stepId } });
      await rec.edge(parent, 'belongs_to', run);
    }
    const call = await rec.node({
      id: graphIds.toolCall(client, runId, stepId, tool, fingerprint),
      kind: 'tool_call',
      label: clip(`${tool}: ${summary}`, 160),
      props: { tool, args: args ?? null, summary, runId, stepId: stepId ?? null },
    });
    await rec.edge(call, 'belongs_to', parent);
    return call;
  }

  /**
   * Upsert an account and link it to its ontology subtype. An explicit subtype
   * replaces an earlier classification (the old edge is marked superseded); a
   * name-only re-observation never overrides one.
   */
  private async account(rec: Recorder, a: { code: string; name?: string; subtype?: string }): Promise<GraphNode> {
    const id = graphIds.account(rec.client, a.code);
    const existing = await this.store.getNode(id);
    const prior = typeof existing?.props.subtype === 'string' ? existing.props.subtype : undefined;

    let cls: { subtype: string; confidence: number; rationale: string } | null = null;
    if (a.subtype && isAccountSubtypeId(a.subtype)) {
      cls = { subtype: a.subtype, confidence: 1, rationale: 'Subtype supplied with the account.' };
    } else if (!prior && (a.name || a.subtype)) {
      const c = classifyAccount({ name: a.name ?? '', number: a.code, ...(a.subtype ? { qboSubType: a.subtype } : {}) });
      if (c.subtype) cls = { subtype: c.subtype, confidence: c.confidence, rationale: c.rationale };
    }

    const label = a.name ? `${a.code} ${a.name}` : (existing?.label ?? a.code);
    const props: Props = { code: a.code, ...(a.name ? { name: a.name } : {}) };
    const def = cls ? getSubtype(cls.subtype) : undefined;
    if (cls && def) Object.assign(props, { subtype: def.id, class: def.class, normalBalance: def.normalBalance, classificationConfidence: cls.confidence });
    const node = await rec.node({ id, kind: 'account', label, props });

    if (cls) {
      const concept = await rec.concept(cls.subtype);
      if (concept) {
        if (prior && prior !== cls.subtype) {
          const old = await this.store.getNode(graphIds.concept(rec.client, prior));
          if (old) await rec.edge(node, 'instance_of', old, { superseded: true });
        }
        await rec.edge(node, 'instance_of', concept, { confidence: cls.confidence, rationale: cls.rationale, superseded: false });
      }
    }
    return node;
  }

  /** Nodes within `depth` hops of the seeds, never crossing into another client's nodes. */
  async subgraph(q: SubgraphQuery): Promise<Subgraph> {
    const depth = Math.max(0, q.depth ?? 2);
    const limit = Math.max(1, q.limit ?? 100);
    // Bound the walk: hubs (a run, a concept) can reach a lot of the graph.
    const cap = limit * 5;
    const visited = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    let truncated = false;
    let frontier: string[] = [];
    for (const id of q.seeds) {
      const n = await this.store.getNode(id);
      if (n && n.client === q.client && !visited.has(id)) {
        visited.set(id, n);
        frontier.push(id);
      }
    }
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of await this.store.neighbors(id, { direction: 'both', edgeKinds: q.edgeKinds })) {
          if (nb.node.client !== q.client) continue;
          if (!visited.has(nb.node.id)) {
            if (visited.size >= cap) {
              truncated = true;
              continue;
            }
            visited.set(nb.node.id, nb.node);
            next.push(nb.node.id);
          }
          edges.set(nb.edge.id, nb.edge);
        }
      }
      frontier = next;
    }
    const seedSet = new Set(q.seeds);
    let nodes = [...visited.values()].filter((n) => seedSet.has(n.id) || !q.kinds || q.kinds.includes(n.kind));
    if (nodes.length > limit) {
      truncated = true;
      nodes = nodes.slice(0, limit);
    }
    const keep = new Set(nodes.map((n) => n.id));
    return {
      client: q.client,
      seeds: q.seeds.filter((s) => visited.has(s)),
      nodes,
      edges: [...edges.values()].filter((e) => keep.has(e.fromId) && keep.has(e.toId)).sort((a, b) => a.id.localeCompare(b.id)),
      truncated,
    };
  }

  /**
   * Walk a figure (or any node) back to the records it rests on: its own
   * derived_from / cites edges first, else what the producing tool call cited.
   */
  async provenance(nodeId: string, maxDepth = 6): Promise<ProvenanceTrail> {
    const target = await this.store.getNode(nodeId);
    if (!target) return { target: null, paths: [], sources: [], producedBy: [] };
    const paths: GraphNode[][] = [];
    const walk = async (node: GraphNode, path: GraphNode[]): Promise<void> => {
      let next = (await this.store.neighbors(node.id, { direction: 'out', edgeKinds: ['derived_from', 'cites'] })).map((n) => n.node);
      if (!next.length && node.kind === 'figure') {
        next = (await this.store.neighbors(node.id, { direction: 'in', edgeKinds: ['produced'] })).map((n) => n.node);
      }
      next = next.filter((n) => n.client === target.client && !path.some((p) => p.id === n.id));
      if (!next.length || path.length > maxDepth) {
        if (node.kind === 'record' || node.kind === 'document') paths.push(path);
        return;
      }
      for (const n of next) await walk(n, [...path, n]);
    };
    await walk(target, [target]);

    const sources = new Map<string, GraphNode>();
    for (const p of paths) sources.set(p[p.length - 1].id, p[p.length - 1]);

    const producedBy: ProvenanceTrail['producedBy'] = [];
    for (const { node: toolCall } of await this.store.neighbors(target.id, { direction: 'in', edgeKinds: ['produced'] })) {
      const parent = (await this.store.neighbors(toolCall.id, { direction: 'out', edgeKinds: ['belongs_to'] }))[0]?.node ?? null;
      let step: GraphNode | null = null;
      let run: GraphNode | null = null;
      if (parent?.kind === 'step') {
        step = parent;
        run = (await this.store.neighbors(parent.id, { direction: 'out', edgeKinds: ['belongs_to'] }))[0]?.node ?? null;
      } else if (parent?.kind === 'run') {
        run = parent;
      }
      producedBy.push({ toolCall, step, run });
    }
    return { target, paths, sources: [...sources.values()], producedBy };
  }

  /**
   * Lean text an agent can read: one self-describing line per node, most
   * useful kinds first (figures with their sources, then accounts, records…),
   * trimmed to `maxChars` by dropping whole lines.
   */
  toContext(sg: Subgraph, maxChars = 2000): string {
    const str = (n: GraphNode, k: string) => (typeof n.props[k] === 'string' ? (n.props[k] as string) : undefined);
    const num = (n: GraphNode, k: string) => (typeof n.props[k] === 'number' ? (n.props[k] as number) : undefined);
    const order: NodeKind[] = ['figure', 'account', 'record', 'document', 'entity', 'tool_call', 'concept', 'step', 'run'];
    const line = (n: GraphNode): string => {
      switch (n.kind) {
        case 'figure': {
          const srcs = Array.isArray(n.props.sources) ? (n.props.sources as SourceRef[]).map(sourceKey) : [];
          return `Figure: ${n.label} = ${str(n, 'value') ?? '?'}${srcs.length ? ` [sources: ${srcs.join(', ')}]` : ' [no source]'} (${n.id})`;
        }
        case 'account': {
          const sub = str(n, 'subtype');
          const bal = str(n, 'normalBalance');
          return `Account: ${n.label}${sub ? ` → ${sub} (${str(n, 'class')}, normal ${bal === 'credit' ? 'Cr' : 'Dr'})` : ' (unclassified)'}`;
        }
        case 'record': {
          const ref = `${str(n, 'system')}:${str(n, 'recordId')}`;
          const amt = num(n, 'amountCents');
          const detail = [str(n, 'date'), amt !== undefined ? formatCents(amt) : undefined].filter(Boolean).join(', ');
          return `Record: ${ref}${n.label !== ref ? ` "${n.label}"` : ''}${detail ? ` (${detail})` : ''}`;
        }
        case 'document':
          return `Document: ${str(n, 'documentId')} "${n.label}"`;
        case 'entity':
          return `Entity: ${n.label}${str(n, 'entityKind') ? ` (${str(n, 'entityKind')})` : ''}`;
        case 'tool_call':
          return `Tool call: ${str(n, 'tool')} [run ${str(n, 'runId')}${str(n, 'stepId') ? `, step ${str(n, 'stepId')}` : ''}]: ${clip(str(n, 'summary') ?? '', 140)}`;
        case 'concept':
          return `Concept: ${str(n, 'conceptId')} (${n.label})`;
        case 'step':
          return `Step: ${str(n, 'stepId')} (run ${str(n, 'runId')})`;
        case 'run':
          return `Run: ${str(n, 'runId')}`;
      }
    };
    const sorted = [...sg.nodes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const header = `Context graph for ${sg.client}: ${sg.nodes.length} nodes, ${sg.edges.length} edges${sg.truncated ? ' (truncated)' : ''}.`;
    // One node per line: flatten any newlines a label or summary carried in.
    const body = sorted.map((n) => line(n).replace(/\s*\n\s*/g, ' '));
    const all = [header, ...body];
    const full = fitLines(all, maxChars);
    if (full.split('\n').length === all.length) return full;
    // Something was dropped: reserve room to say so, so the agent knows its context is partial.
    const reserve = `\n(+${body.length} more not shown)`.length;
    if (maxChars <= reserve) return full;
    const text = fitLines(all, maxChars - reserve);
    const omitted = body.length - (text ? text.split('\n').length - 1 : 0);
    return `${text}\n(+${omitted} more not shown)`;
  }
}
