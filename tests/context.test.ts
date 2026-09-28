import { describe, expect, it } from 'vitest';
import tb from '@/fixtures/trial-balance.json';
import { JOURNAL_ENTRY_TYPES, type CheckResult, type JournalEntry, type JournalLine, type SourceRef, type Txn } from '@/lib/engine/types';
import {
  ACCOUNT_SUBTYPE_IDS,
  ACCOUNT_SUBTYPES,
  CLOSE_TASKS,
  ContextGraph,
  ENTRY_TYPES,
  InMemoryGraphStore,
  ONTOLOGY_TOOLS,
  RELATIONS,
  categorizeTransaction,
  classifyAccount,
  closeOrder,
  contextFor,
  explain,
  getConcept,
  graphIds,
  lookup,
  relations,
  runOntologyTool,
  validateEntry,
  type ChartAccount,
  type Interaction,
} from '@/lib/context';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const src = (id: string, system = 'register'): SourceRef[] => [{ system, id }];

const CHART: ChartAccount[] = [
  { code: '1000', name: 'Operating checking', subtype: 'cash' },
  { code: '1100', name: 'Accounts receivable', subtype: 'accounts_receivable' },
  { code: '1200', name: 'Prepaid expenses', subtype: 'prepaid_expenses' },
  { code: '1510', name: 'Computer equipment', subtype: 'computer_equipment' },
  { code: '1519', name: 'Accumulated depreciation - computers', subtype: 'accumulated_depreciation' },
  { code: '2100', name: 'Accrued liabilities', subtype: 'accrued_liabilities' },
  { code: '2200', name: 'Deferred revenue', subtype: 'deferred_revenue' },
  { code: '4000', name: 'Subscription revenue', subtype: 'revenue' },
  { code: '6100', name: 'Professional fees', subtype: 'professional_fees' },
  { code: '6410', name: 'Depreciation expense', subtype: 'depreciation_expense' },
  { code: '6500', name: 'Insurance', subtype: 'insurance_expense' },
];

const line = (account: string, debitCents: number, creditCents: number, sources: SourceRef[] = src('FA-2201')): JournalLine => ({
  account,
  description: '',
  debitCents,
  creditCents,
  sources,
});

function entry(lines: JournalLine[], overrides: Partial<JournalEntry> = {}): JournalEntry {
  return { id: 'JE-1', date: '2026-04-30', type: 'depreciation', memo: 'April depreciation', lines, attachments: [], idempotencyKey: 'JE-1', ...overrides };
}

const depreciation = () => entry([line('6410', 62200, 0), line('1519', 0, 62200)]);

function check(results: CheckResult[], id: string): CheckResult {
  const r = results.find((c) => c.id === `structural.${id}`);
  if (!r) throw new Error(`missing check ${id}`);
  return r;
}

const failing = (results: CheckResult[]) => results.filter((r) => !r.pass).map((r) => r.id.replace('structural.', ''));

// ─── Ontology data ───────────────────────────────────────────────────────────

describe('ontology data', () => {
  it('defines every subtype exactly once with derived normal balances', () => {
    const ids = ACCOUNT_SUBTYPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ACCOUNT_SUBTYPE_IDS].sort());
    expect(ids.length).toBeGreaterThanOrEqual(40);
    for (const s of ACCOUNT_SUBTYPES) {
      const classNormal = s.class === 'asset' || s.class === 'expense' ? 'debit' : 'credit';
      expect(s.normalBalance, s.id).toBe(s.contraOf ? (classNormal === 'debit' ? 'credit' : 'debit') : classNormal);
    }
    expect(Object.keys(ENTRY_TYPES).sort()).toEqual([...JOURNAL_ENTRY_TYPES].sort());
  });

  it('derives relations whose endpoints all resolve', () => {
    for (const r of RELATIONS) {
      expect(getConcept(r.from), `${r.from} (${r.kind})`).toBeDefined();
      expect(getConcept(r.to), `${r.to} (${r.kind})`).toBeDefined();
    }
    const has = (from: string, kind: string, to: string) => RELATIONS.some((r) => r.from === from && r.kind === kind && r.to === to);
    expect(has('accumulated_depreciation', 'contra_of', 'computer_equipment')).toBe(true);
    expect(has('allowance_for_doubtful_accounts', 'contra_of', 'accounts_receivable')).toBe(true);
    expect(has('schedule.depreciation', 'rolls_forward_to', 'accumulated_depreciation')).toBe(true);
    expect(has('rec.bank', 'reconciles_to', 'cash')).toBe(true);
    expect(has('je.depreciation', 'posts_to', 'depreciation_expense')).toBe(true);
    expect(has('je.revenue_recognition', 'posts_to', 'deferred_revenue')).toBe(true);
    expect(has('deferred_revenue', 'governed_by', 'asc.606')).toBe(true);
    expect(has('right_of_use_asset', 'governed_by', 'asc.842')).toBe(true);
    expect(has('close.tb_flux', 'depends_on', 'close.gl_review')).toBe(true);
    for (const std of ['asc.606', 'asc.842', 'asc.360', 'asc.350', 'asc.340-40', 'asc.450', 'asc.855']) {
      expect(relations({ to: std, kind: 'governed_by' }).length, std).toBeGreaterThan(0);
    }
  });
});

// ─── Lookup ──────────────────────────────────────────────────────────────────

describe('lookup', () => {
  it('matches ids, labels, synonyms and standard codes', () => {
    expect(lookup('A/R')[0].concept.id).toBe('accounts_receivable');
    expect(lookup('unearned revenue')[0].concept.id).toBe('deferred_revenue');
    expect(lookup('ASC 842')[0].concept.id).toBe('asc.842');
    expect(lookup('accum depr')[0].concept.id).toBe('accumulated_depreciation');
    expect(lookup('bank rec')[0].concept.id).toBe('rec.bank');
    expect(lookup('prepaid insurance')[0]).toMatchObject({ concept: { id: 'prepaid_expenses' }, score: 1 });
    expect(lookup('   ')).toEqual([]);
  });
});

// ─── Classification ──────────────────────────────────────────────────────────

describe('classifyAccount', () => {
  it('trusts a QuickBooks AccountSubType', () => {
    expect(classifyAccount({ name: 'Business Checking', qboType: 'Bank', qboSubType: 'Checking' })).toMatchObject({
      subtype: 'cash',
      class: 'asset',
      normalBalance: 'debit',
      basis: 'provider_subtype',
    });
    const ad = classifyAccount({ name: 'A/D', qboType: 'Fixed Asset', qboSubType: 'AccumulatedDepreciation' });
    expect(ad).toMatchObject({ subtype: 'accumulated_depreciation', normalBalance: 'credit' });
    expect(ad.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('narrows generic QuickBooks types by name but not specific ones', () => {
    expect(classifyAccount({ name: 'Prepaid Insurance', qboType: 'Other Current Asset' }).subtype).toBe('prepaid_expenses');
    expect(classifyAccount({ name: 'Prepaid Insurance', qboType: 'Other Current Asset', qboSubType: 'OtherCurrentAssets' }).subtype).toBe('prepaid_expenses');
    expect(classifyAccount({ name: 'Depreciation', qboType: 'Expense' }).subtype).toBe('depreciation_expense');
    // Cost of Goods Sold is specific: the name cannot move it to shipping expense.
    expect(classifyAccount({ name: 'Shipping', qboType: 'Cost of Goods Sold' }).subtype).toBe('cogs');
    // A name from another class cannot refine a typed account.
    expect(classifyAccount({ name: 'Deferred revenue', qboType: 'Expense' })).toMatchObject({ subtype: 'other_operating_expense', class: 'expense' });
  });

  it('maps Xero Type, Class and SystemAccount', () => {
    expect(classifyAccount({ name: 'Less Accumulated Depreciation on Office Equipment', xeroType: 'FIXED', xeroClass: 'ASSET' })).toMatchObject({
      subtype: 'accumulated_depreciation',
      normalBalance: 'credit',
      basis: 'provider_type',
    });
    expect(classifyAccount({ name: 'Depreciation', xeroType: 'DEPRECIATN' }).subtype).toBe('depreciation_expense');
    expect(classifyAccount({ name: 'Prepayments', xeroType: 'PREPAYMENT' }).subtype).toBe('prepaid_expenses');
    expect(classifyAccount({ name: 'Accounts Receivable', xeroType: 'CURRENT', xeroSystemAccount: 'DEBTORS' })).toMatchObject({
      subtype: 'accounts_receivable',
      basis: 'provider_subtype',
    });
    expect(classifyAccount({ name: 'Interest Income', xeroClass: 'REVENUE' }).subtype).toBe('interest_income');
  });

  it('classifies the fixture trial balance by name and number into the right class', () => {
    for (const a of tb.accounts) {
      const c = classifyAccount({ name: a.name, number: a.account });
      expect(c.class, a.name).toBe(a.type);
      expect(c.confidence, a.name).toBeGreaterThanOrEqual(0.7);
    }
    const sub = (name: string, number: string) => classifyAccount({ name, number }).subtype;
    expect(sub('Property, plant & equipment', '1500')).toBe('other_fixed_assets');
    expect(sub('Right-of-use assets (ASC 842)', '1600')).toBe('right_of_use_asset');
    expect(sub('Lease liabilities (ASC 842)', '2300')).toBe('lease_liability');
    expect(sub('Common stock and APIC', '3000')).toBe('owners_equity');
  });

  it('lets precise wording beat the nouns it contains', () => {
    expect(classifyAccount({ name: 'Accumulated Depreciation - Vehicles' }).subtype).toBe('accumulated_depreciation');
    expect(classifyAccount({ name: 'Allowance for Doubtful Accounts' }).normalBalance).toBe('credit');
    expect(classifyAccount({ name: 'Vehicle expenses' }).subtype).toBe('travel');
    expect(classifyAccount({ name: 'Computer and Internet Expenses' }).subtype).toBe('software_subscriptions');
    expect(classifyAccount({ name: 'Accrued Payroll' }).subtype).toBe('payroll_liabilities');
    expect(classifyAccount({ name: "Owner's Draw" })).toMatchObject({ subtype: 'owner_distributions', normalBalance: 'debit' });
  });

  it('lowers confidence on conflicts and says "unknown" instead of guessing', () => {
    const conflict = classifyAccount({ name: 'Office Supplies', number: '1200' });
    expect(conflict.subtype).toBe('office_supplies');
    expect(conflict.confidence).toBeLessThanOrEqual(0.5);
    expect(conflict.rationale).toMatch(/1xxx/);
    expect(classifyAccount({ name: 'ZZ-1', number: '4050' })).toMatchObject({ class: 'revenue', basis: 'number', confidence: 0.4 });
    expect(classifyAccount({ name: 'Ask My Accountant' })).toMatchObject({ subtype: null, class: null, confidence: 0, basis: 'none' });
    const suspense = classifyAccount({ name: 'Uncategorized Expense' });
    expect(suspense.confidence).toBeLessThan(0.5);
    expect(suspense.rationale).toMatch(/suspense/);
  });
});

// ─── Structural validation ───────────────────────────────────────────────────

describe('validateEntry', () => {
  it('passes a correct depreciation entry on every structural check', () => {
    const results = validateEntry(depreciation(), CHART);
    expect(results.length).toBe(9);
    expect(results.every((r) => r.layer === 'structural')).toBe(true);
    expect(failing(results)).toEqual([]);
    expect(check(results, 'pattern').confidence).toBe(1);
  });

  it('catches an unbalanced entry', () => {
    const results = validateEntry(entry([line('6410', 62200, 0), line('1519', 0, 62100)]), CHART);
    expect(failing(results)).toEqual(['balanced']);
    expect(check(results, 'balanced').message).toContain('off by $1.00');
  });

  it('catches accounts missing from the chart', () => {
    const results = validateEntry(entry([line('6410', 62200, 0), line('1599', 0, 62200)]), CHART);
    expect(failing(results)).toContain('accounts_exist');
    expect(check(results, 'accounts_exist').message).toContain('1599');
  });

  it('catches a line with both sides, a zero line and fractional cents', () => {
    const both = validateEntry(entry([line('6410', 100, 100), line('1519', 0, 0)]), CHART);
    expect(check(both, 'line_shape').pass).toBe(false);
    expect(check(both, 'line_shape').message).toMatch(/both a debit and a credit.*is zero/);
    const fractional = validateEntry(entry([line('6410', 100.5, 0), line('1519', 0, 100.5)]), CHART);
    expect(check(fractional, 'line_shape').pass).toBe(false);
    expect(check(validateEntry(entry([line('6410', 100, 0)]), CHART), 'line_shape').message).toMatch(/at least 2/);
  });

  it('requires a source on every line', () => {
    const results = validateEntry(entry([line('6410', 62200, 0), line('1519', 0, 62200, [])]), CHART);
    expect(failing(results)).toEqual(['sources']);
    expect(check(results, 'sources').message).toContain('line 2');
  });

  it('enforces the depreciation account pattern', () => {
    // Credited the cost account instead of accumulated depreciation.
    const results = validateEntry(entry([line('6410', 62200, 0), line('1510', 0, 62200)]), CHART);
    expect(failing(results)).toEqual(['pattern']);
    expect(check(results, 'pattern').message).toContain('accumulated_depreciation');
  });

  it('requires accruals to auto-reverse after the entry date', () => {
    const accrual = (reversesOn?: string) =>
      validateEntry(entry([line('6100', 450000, 0, src('INV-88', 'upload')), line('2100', 0, 450000, src('INV-88', 'upload'))], { type: 'accrual', reversesOn }), CHART);
    expect(failing(accrual())).toEqual(['reversal']);
    expect(failing(accrual('2026-05-01'))).toEqual([]);
    expect(failing(accrual('2026-04-01'))).toEqual(['reversal']);
  });

  it('flags revenue recognition booked backwards', () => {
    const results = validateEntry(entry([line('4000', 50000, 0), line('2200', 0, 50000)], { type: 'revenue_recognition' }), CHART);
    expect(failing(results)).toEqual(['pattern', 'direction']);
    expect(check(results, 'direction').message).toMatch(/debits revenue/);
  });

  it('accepts prepaid amortization and capitalizing a miscoded purchase', () => {
    const prepaid = entry([line('6500', 10000, 0), line('1200', 0, 10000)], { type: 'prepaid' });
    expect(failing(validateEntry(prepaid, CHART))).toEqual([]);
    // Crediting an expense is against its normal balance, but legitimate when capitalizing.
    const capitalize = entry([line('1510', 129999, 0, src('JE-2026-0403', 'gl')), line('6100', 0, 129999, src('JE-2026-0403', 'gl'))], { type: 'fixed_asset' });
    expect(failing(validateEntry(capitalize, CHART))).toEqual([]);
    // The same credit to expense in a prepaid entry is not.
    const wrong = entry([line('1200', 10000, 0), line('6500', 0, 10000)], { type: 'prepaid' });
    expect(failing(validateEntry(wrong, CHART))).toEqual(['pattern', 'direction']);
  });

  it('classifies chart accounts by name when no subtype is given', () => {
    const bare = CHART.map(({ code, name }) => ({ code, name }));
    const results = validateEntry(depreciation(), bare);
    expect(failing(results)).toEqual([]);
    expect(check(results, 'pattern').confidence).toBeLessThan(1);
  });

  it('rejects unknown entry types and bad dates', () => {
    const results = validateEntry({ ...depreciation(), type: 'bonus' as JournalEntry['type'], date: '2026-02-30' }, CHART);
    expect(failing(results)).toEqual(expect.arrayContaining(['entry_type', 'date', 'pattern']));
  });
});

// ─── Explain, prompt context, close order, coding ────────────────────────────

describe('explain and contextFor', () => {
  it('explains concepts with standard references', () => {
    const text = explain('deferred_revenue');
    expect(text).toContain('normal credit');
    expect(text).toContain('ASC 606');
    expect(explain('unearned revenue')).toContain('id deferred_revenue');
    expect(explain('asc.842')).toMatch(/Governs: .*Right-of-use asset/);
    expect(explain('zzz-not-a-thing')).toMatch(/^Unknown concept/);
  });

  it('keeps context under maxChars and relevant to the task', () => {
    for (const max of [0, 40, 120, 300, 600, 1200, 5000]) {
      for (const req of [{ entryType: 'depreciation' as const }, { skill: 'revenue_recognition' }, { concepts: ['cash', 'asc.842', 'rec.bank'] }]) {
        expect(contextFor(req, max).length, `${JSON.stringify(req)} @ ${max}`).toBeLessThanOrEqual(max);
      }
    }
    const dep = contextFor({ entryType: 'depreciation' }, 400);
    expect(dep).toContain('Dr depreciation_expense');
    expect(dep).toContain('Cr accumulated_depreciation');
    expect(dep).not.toContain('deferred_revenue');
    const bank = contextFor({ skill: 'bank-reconciliation' }, 1500);
    expect(bank).toContain('statement ending balance');
    expect(contextFor({ skill: 'deferred revenue waterfall' }, 1500)).toContain('Deferred revenue waterfall');
  });
});

describe('closeOrder', () => {
  it('puts every task after its dependencies', () => {
    const order = closeOrder();
    expect(order.length).toBe(CLOSE_TASKS.length);
    const pos = new Map<string, number>(order.map((s, i) => [s.id, i]));
    for (const s of order) for (const d of s.dependsOn) expect(pos.get(d)!, `${d} before ${s.id}`).toBeLessThan(pos.get(s.id)!);
    const before = (a: string, b: string) => expect(pos.get(a)!, `${a} before ${b}`).toBeLessThan(pos.get(b)!);
    for (const rec of ['close.bank_rec', 'close.card_rec', 'close.ar_tieout', 'close.ap_tieout']) before(rec, 'close.gl_review');
    for (const je of ['close.accruals', 'close.depreciation', 'close.amortization', 'close.prepaids']) before(je, 'close.tb_flux');
    before('close.post_entries', 'close.consolidation');
    before('close.post_entries', 'close.financial_statements');
    expect(order[order.length - 1].id).toBe('close.lock_period');
    for (const s of order) for (const d of s.dependsOn) expect(order.find((x) => x.id === d)!.level).toBeLessThan(s.level);
  });

  it('returns only a task and its ancestors when asked', () => {
    const ids = closeOrder({ include: ['close.depreciation'] }).map((s) => s.id);
    expect(new Set(ids)).toEqual(
      new Set(['close.sync_sources', 'close.txn_coding', 'close.bank_rec', 'close.card_rec', 'close.ap_tieout', 'close.fixed_assets', 'close.depreciation']),
    );
    expect(ids[ids.length - 1]).toBe('close.depreciation');
    expect(() => closeOrder({ include: ['close.nope'] })).toThrow(/Unknown close task/);
  });
});

describe('categorizeTransaction', () => {
  it('codes bank lines to subtypes, preferring the more specific merchant', () => {
    expect(categorizeTransaction({ description: 'AWS EMEA aws.amazon.com', amountCents: -12000 })[0].subtype).toBe('software_subscriptions');
    expect(categorizeTransaction({ description: 'UBER EATS 8123', amountCents: -2400 })[0].category.id).toBe('txn.meals');
    expect(categorizeTransaction({ description: 'Interest', amountCents: 312 })[0].subtype).toBe('interest_income');
    expect(categorizeTransaction({ description: 'Interest', amountCents: -312 })[0].subtype).toBe('interest_expense');
  });
});

// ─── Tools ───────────────────────────────────────────────────────────────────

describe('ontology tools', () => {
  it('exposes the five tools with JSON object schemas and validating handlers', () => {
    expect(ONTOLOGY_TOOLS.map((t) => t.name)).toEqual([
      'ontology_lookup',
      'ontology_classify_account',
      'ontology_validate_entry',
      'ontology_explain',
      'ontology_close_order',
    ]);
    for (const t of ONTOLOGY_TOOLS) expect(t.input_schema.type).toBe('object');

    const ok = runOntologyTool('ontology_validate_entry', { entry: depreciation(), chart: CHART });
    expect(ok).toMatchObject({ ok: true, data: { pass: true } });
    const bad = runOntologyTool('ontology_validate_entry', { entry: { ...depreciation(), type: 'bogus' }, chart: CHART });
    expect(bad.ok).toBe(false);
    expect(runOntologyTool('ontology_lookup', { term: 'A/R' })).toMatchObject({ ok: true, data: [{ id: 'accounts_receivable' }] });
    expect(runOntologyTool('ontology_close_order', { include: ['close.nope'] })).toMatchObject({ ok: false });
    expect(runOntologyTool('nope', {})).toMatchObject({ ok: false });
  });
});

// ─── Context graph ───────────────────────────────────────────────────────────

function clock() {
  let t = 0;
  return () => new Date(Date.UTC(2026, 3, 30, 12, 0, t++)).toISOString();
}

const depreciationRun = (overrides: Partial<Interaction> = {}): Interaction => ({
  client: 'acme',
  runId: 'run-1',
  stepId: 'step-2',
  tool: 'computeDepreciation',
  args: { period: '2026-04', assets: ['FA-2201', 'FA-2202'] },
  summary: 'April depreciation computed from the register.',
  sources: [
    { system: 'register', id: 'FA-2201', label: 'MacBook Pro 14" (x8)' },
    { system: 'register', id: 'FA-2202' },
  ],
  figures: [
    { label: 'April depreciation', value: '$622.00', valueCents: 62200, sources: [{ system: 'register', id: 'FA-2201' }] },
  ],
  accounts: [
    { code: '1510', name: 'Computer equipment' },
    { code: '6410', name: 'Depreciation expense', subtype: 'depreciation_expense' },
  ],
  entities: [{ id: 'vendor:apple', name: 'Apple', kind: 'vendor' }],
  documents: [{ id: 'doc-7', name: 'Fixed asset register April.xlsx' }],
  concepts: ['je.depreciation'],
  ...overrides,
});

describe('ContextGraph', () => {
  it('turns an interaction into nodes and edges with deterministic ids', async () => {
    const graph = new ContextGraph(new InMemoryGraphStore(clock()));
    const res = await graph.observe(depreciationRun());
    const kinds = new Set((await Promise.all(res.nodeIds.map((id) => graph.store.getNode(id)))).map((n) => n!.kind));
    expect(kinds).toEqual(new Set(['run', 'step', 'tool_call', 'record', 'document', 'account', 'entity', 'figure', 'concept']));

    const account = await graph.store.getNode(graphIds.account('acme', '1510'));
    expect(account).toMatchObject({ id: 'account:acme:1510', label: '1510 Computer equipment', props: { subtype: 'computer_equipment', normalBalance: 'debit' } });
    const [isA] = await graph.store.neighbors(account!.id, { direction: 'out', edgeKinds: ['instance_of'] });
    expect(isA.node.id).toBe('concept:acme:computer_equipment');
    expect(isA.edge).toMatchObject({ runId: 'run-1', stepId: 'step-2' });
    expect(await graph.store.getNode('record:acme:register:FA-2201')).toMatchObject({ label: 'MacBook Pro 14" (x8)' });
  });

  it('merges repeated observations instead of duplicating', async () => {
    const store = new InMemoryGraphStore(clock());
    const graph = new ContextGraph(store);
    const first = await graph.observe(depreciationRun());
    const size = store.size();
    const before = await store.getNode(first.toolCallId);
    const second = await graph.observe(depreciationRun({ args: { assets: ['FA-2201', 'FA-2202'], period: '2026-04' } }));
    expect(second.toolCallId).toBe(first.toolCallId);
    expect(store.size()).toEqual(size);
    const after = await store.getNode(first.toolCallId);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.updatedAt > before!.updatedAt).toBe(true);
    // A bare source ref later on does not erase the descriptive label.
    await graph.observe(depreciationRun({ tool: 'other', sources: [{ system: 'register', id: 'FA-2201' }], figures: [] }));
    expect((await store.getNode('record:acme:register:FA-2201'))!.label).toBe('MacBook Pro 14" (x8)');
  });

  it('walks provenance from a figure back to its source record', async () => {
    const graph = new ContextGraph(new InMemoryGraphStore(clock()));
    await graph.observe(depreciationRun());
    const [figure] = await graph.store.query({ client: 'acme', kinds: ['figure'] });
    const trail = await graph.provenance(figure.id);
    expect(trail.paths.map((p) => p.map((n) => n.kind))).toEqual([['figure', 'record']]);
    expect(trail.sources.map((n) => n.id)).toEqual(['record:acme:register:FA-2201']);
    expect(trail.producedBy).toHaveLength(1);
    expect(trail.producedBy[0].toolCall.props.tool).toBe('computeDepreciation');
    expect(trail.producedBy[0].step!.id).toBe('step:acme:run-1:step-2');
    expect(trail.producedBy[0].run!.id).toBe('run:acme:run-1');
  });

  it('falls back to what the producing tool call cited when a figure has no sources', async () => {
    const graph = new ContextGraph(new InMemoryGraphStore(clock()));
    await graph.observe(depreciationRun({ figures: [{ label: 'Register total', value: '$59,299.55', sources: [] }] }));
    const [figure] = await graph.store.query({ client: 'acme', kinds: ['figure'] });
    const trail = await graph.provenance(figure.id);
    expect(trail.paths.every((p) => p[0].kind === 'figure' && p[1].kind === 'tool_call')).toBe(true);
    expect(trail.sources.map((n) => n.id).sort()).toEqual(['document:acme:doc-7', 'record:acme:register:FA-2201', 'record:acme:register:FA-2202']);
  });

  it('observes transactions as records tied to accounts and counterparties', async () => {
    const store = new InMemoryGraphStore(clock());
    const graph = new ContextGraph(store);
    await graph.observe(depreciationRun());
    const txns: Txn[] = [
      { id: 't1', date: '2026-04-03', amountCents: -129999, description: 'BEST BUY 00123', counterparty: 'Best Buy', account: '1510', source: { system: 'bank', id: 'tx_991' } },
      { id: 't2', date: '2026-04-05', amountCents: -2400, description: 'UBER EATS', counterparty: 'Uber Eats', source: { system: 'bank', id: 'tx_992' } },
    ];
    await graph.observeTransactions('acme', txns, { runId: 'run-2' });
    const size = store.size();
    await graph.observeTransactions('acme', txns, { runId: 'run-2' });
    expect(store.size()).toEqual(size);

    const record = await store.getNode('record:acme:bank:tx_991');
    expect(record).toMatchObject({ label: '2026-04-03 BEST BUY 00123 -$1,299.99', props: { amountCents: -129999, counterparty: 'Best Buy' } });
    const out = await store.neighbors(record!.id, { direction: 'out' });
    expect(out.map((n) => `${n.edge.kind}:${n.node.id}`).sort()).toEqual(['belongs_to:account:acme:1510', 'mentions:entity:acme:counterparty%3Abest-buy']);
    // The code-only mention keeps the name learned earlier.
    expect((await store.getNode('account:acme:1510'))!.label).toBe('1510 Computer equipment');
  });

  it('lets an explicit subtype supersede a name-based classification', async () => {
    const graph = new ContextGraph(new InMemoryGraphStore(clock()));
    await graph.observe(depreciationRun({ accounts: [{ code: '6900', name: 'Misc' }] }));
    expect((await graph.store.getNode('account:acme:6900'))!.props.subtype).toBe('other_operating_expense');
    await graph.observe(depreciationRun({ tool: 'recode', accounts: [{ code: '6900', name: 'Misc', subtype: 'software_subscriptions' }] }));
    expect((await graph.store.getNode('account:acme:6900'))!.props.subtype).toBe('software_subscriptions');
    const edges = await graph.store.neighbors('account:acme:6900', { direction: 'out', edgeKinds: ['instance_of'] });
    expect(edges.map((e) => [e.node.id, e.edge.props.superseded])).toEqual([
      ['concept:acme:other_operating_expense', true],
      ['concept:acme:software_subscriptions', false],
    ]);
  });

  it('builds client-scoped subgraphs and lean context text', async () => {
    const graph = new ContextGraph(new InMemoryGraphStore(clock()));
    await graph.observe(depreciationRun());
    await graph.observe(depreciationRun({ client: 'globex' }));
    const figureId = (await graph.store.query({ client: 'acme', kinds: ['figure'] }))[0].id;

    const sg = await graph.subgraph({ client: 'acme', seeds: [figureId], depth: 2 });
    expect(sg.nodes.every((n) => n.client === 'acme')).toBe(true);
    expect(sg.nodes.map((n) => n.id)).toContain('record:acme:register:FA-2201');
    expect(sg.edges.every((e) => sg.nodes.some((n) => n.id === e.fromId) && sg.nodes.some((n) => n.id === e.toId))).toBe(true);

    const oneHop = await graph.subgraph({ client: 'acme', seeds: [figureId], depth: 1 });
    expect(oneHop.nodes.map((n) => n.kind).sort()).toEqual(['figure', 'record', 'tool_call']);
    const onlyRecords = await graph.subgraph({ client: 'acme', seeds: [figureId], depth: 2, kinds: ['record'] });
    expect(new Set(onlyRecords.nodes.map((n) => n.kind))).toEqual(new Set(['figure', 'record']));
    expect((await graph.subgraph({ client: 'globex', seeds: [figureId] })).nodes).toEqual([]);

    const text = graph.toContext(sg, 2000);
    expect(text.split('\n')[1]).toBe(`Figure: April depreciation = $622.00 [sources: register:FA-2201] (${figureId})`);
    expect(text).toContain('Account: 1510 Computer equipment → computer_equipment (asset, normal Dr)');
    for (const max of [0, 30, 120, 250]) expect(graph.toContext(sg, max).length).toBeLessThanOrEqual(max);
    expect(graph.toContext(sg, 250)).toMatch(/more not shown/);
  });
});
