/**
 * Accounting domain ontology: pure, deterministic functions over
 * `ontology-data.ts`. Agents use it three ways: as a tool (lookup, classify,
 * validate, explain, close order), as lean prompt context (`contextFor`), and
 * as the first verification gate (`validateEntry`, layer 'structural').
 */
import {
  JOURNAL_ENTRY_TYPES,
  type CheckResult,
  type JournalEntry,
  type JournalEntryType,
  type JournalLine,
  type SourceRef,
  type Txn,
} from '@/lib/engine/types';
import {
  ACCOUNT_CLASSES,
  ACCOUNT_SUBTYPES,
  CLOSE_TASKS,
  CONTRA_CLASSES,
  ENTRY_TYPES,
  NAME_RULES,
  QBO_ACCOUNT_SUBTYPES,
  QBO_ACCOUNT_TYPES,
  RECONCILIATIONS,
  SCHEDULES,
  SKILL_CONCEPTS,
  CATALOG_SKILL_ALIASES,
  STANDARDS,
  SUSPENSE_NAME,
  TXN_CATEGORIES,
  XERO_ACCOUNT_CLASSES,
  XERO_ACCOUNT_TYPES,
  XERO_SYSTEM_ACCOUNTS,
  type AccountClass,
  type AccountSelector,
  type AccountSubtypeDef,
  type AccountSubtypeId,
  type CloseTaskDef,
  type CloseTaskId,
  type Concept,
  type ConceptKind,
  type EntryPattern,
  type EntryTypeDef,
  type NormalBalance,
  type ProviderSubtypeMapping,
  type ProviderTypeMapping,
  type Relation,
  type RelationKind,
  type StandardId,
  type TxnCategoryDef,
} from './ontology-data';

// ─── Registry ────────────────────────────────────────────────────────────────

export const CONCEPTS: readonly Concept[] = [
  ...ACCOUNT_CLASSES,
  ...CONTRA_CLASSES,
  ...ACCOUNT_SUBTYPES,
  ...Object.values(ENTRY_TYPES),
  ...SCHEDULES,
  ...RECONCILIATIONS,
  ...TXN_CATEGORIES,
  ...STANDARDS,
  ...CLOSE_TASKS,
];

const BY_ID = new Map<string, Concept>(CONCEPTS.map((c) => [c.id, c]));
const SUBTYPES = new Map<string, AccountSubtypeDef>(ACCOUNT_SUBTYPES.map((s) => [s.id, s]));

export function getConcept(id: string): Concept | undefined {
  return BY_ID.get(id);
}

export function getSubtype(id: string): AccountSubtypeDef | undefined {
  return SUBTYPES.get(id);
}

export function isAccountSubtypeId(id: string): id is AccountSubtypeId {
  return SUBTYPES.has(id);
}

export function isJournalEntryType(t: string): t is JournalEntryType {
  return (JOURNAL_ENTRY_TYPES as readonly string[]).includes(t);
}

/** Lowercase, `&` → and, drop apostrophes and punctuation (keeps `/` for "a/r"). */
export function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesSelector(subtype: string, sel: AccountSelector): boolean {
  const s = SUBTYPES.get(subtype);
  if (!s) return false;
  return Boolean(
    sel.subtypes?.includes(s.id) ||
      sel.classes?.includes(s.class) ||
      sel.sections?.includes(s.section) ||
      sel.tags?.some((t) => s.tags?.includes(t)),
  );
}

export function subtypesMatching(sel: AccountSelector): AccountSubtypeId[] {
  return ACCOUNT_SUBTYPES.filter((s) => matchesSelector(s.id, sel)).map((s) => s.id);
}

// ─── Relations (derived, so the data has one source of truth) ────────────────

/** Concept ids a selector points at: explicit subtypes, expanded tags/sections, and class concepts. */
function selectorTargets(sel: AccountSelector): string[] {
  const out = new Set<string>(sel.subtypes ?? []);
  for (const id of subtypesMatching({ tags: sel.tags, sections: sel.sections })) out.add(id);
  // Whole classes point at the class concept rather than fanning out to every subtype.
  for (const c of sel.classes ?? []) out.add(c);
  return [...out];
}

function deriveRelations(): Relation[] {
  const out: Relation[] = [];
  const seen = new Set<string>();
  const add = (from: string, kind: RelationKind, to: string) => {
    const k = `${from}|${kind}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from, kind, to });
  };
  for (const c of CONTRA_CLASSES) add(c.id, 'contra_of', c.class);
  for (const s of ACCOUNT_SUBTYPES) for (const t of s.contraOf ?? []) add(s.id, 'contra_of', t);
  for (const je of Object.values(ENTRY_TYPES)) {
    for (const p of je.patterns) for (const leg of p.legs) for (const t of selectorTargets(leg.accounts)) add(je.id, 'posts_to', t);
  }
  for (const t of TXN_CATEGORIES) add(t.id, 'posts_to', t.subtype);
  for (const s of SCHEDULES) {
    for (const t of selectorTargets(s.supports)) add(s.id, 'rolls_forward_to', t);
    for (const d of s.dependsOn ?? []) add(s.id, 'depends_on', d);
  }
  for (const r of RECONCILIATIONS) for (const t of selectorTargets(r.accounts)) add(r.id, 'reconciles_to', t);
  for (const t of CLOSE_TASKS) for (const d of t.dependsOn) add(t.id, 'depends_on', d);
  for (const c of CONCEPTS) for (const std of c.standards ?? []) add(c.id, 'governed_by', std);
  return out;
}

export const RELATIONS: readonly Relation[] = deriveRelations();

export function relations(filter: { from?: string; to?: string; kind?: RelationKind } = {}): Relation[] {
  return RELATIONS.filter(
    (r) => (!filter.from || r.from === filter.from) && (!filter.to || r.to === filter.to) && (!filter.kind || r.kind === filter.kind),
  );
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface LookupMatch {
  concept: Concept;
  /** 1 = exact id/label/synonym; lower for partial matches. */
  score: number;
  /** The label or synonym that matched. */
  matched: string;
}

const KIND_RANK: Record<ConceptKind, number> = {
  account_subtype: 0,
  account_class: 1,
  contra_class: 2,
  entry_type: 3,
  schedule: 4,
  reconciliation: 5,
  standard: 6,
  close_task: 7,
  txn_category: 8,
};

const SEARCH_TERMS: { concept: Concept; terms: { raw: string; norm: string }[] }[] = CONCEPTS.map((c) => {
  const raws = [c.id, c.id.replace(/[._-]/g, ' '), c.label, ...c.synonyms, ...(c.kind === 'standard' ? [c.code] : [])];
  return { concept: c, terms: raws.map((raw) => ({ raw, norm: normalizeTerm(raw) })).filter((t) => t.norm) };
});

const hasPhrase = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);

function termScore(q: string, qTokens: Set<string>, cand: string): number {
  if (cand === q) return 1;
  if (hasPhrase(cand, q)) return 0.6 + 0.3 * (q.length / cand.length);
  if (hasPhrase(q, cand)) return 0.5 + 0.3 * (cand.length / q.length);
  const cTokens = new Set(cand.split(' '));
  let shared = 0;
  for (const t of qTokens) if (cTokens.has(t)) shared++;
  const jaccard = shared / (qTokens.size + cTokens.size - shared);
  return jaccard >= 0.5 ? 0.5 * jaccard : 0;
}

/** Ranked concept matches for a free-text term, by id, label, synonym or standard code. */
export function lookup(term: string, limit = 5): LookupMatch[] {
  const q = normalizeTerm(term);
  if (!q) return [];
  const qTokens = new Set(q.split(' '));
  const matches: LookupMatch[] = [];
  for (const { concept, terms } of SEARCH_TERMS) {
    let best = 0;
    let matched = '';
    for (const t of terms) {
      const s = termScore(q, qTokens, t.norm);
      if (s > best) {
        best = s;
        matched = t.raw;
      }
    }
    if (best >= 0.3) matches.push({ concept, score: Math.round(best * 100) / 100, matched });
  }
  matches.sort(
    (a, b) => b.score - a.score || KIND_RANK[a.concept.kind] - KIND_RANK[b.concept.kind] || a.concept.id.localeCompare(b.concept.id),
  );
  return matches.slice(0, Math.max(0, limit));
}

/** An id if it is one, else the best lookup hit above `minScore`. */
export function resolveConceptId(idOrTerm: string, minScore = 0.75): string | undefined {
  if (BY_ID.has(idOrTerm)) return idOrTerm;
  const hit = lookup(idOrTerm, 1)[0];
  return hit && hit.score >= minScore ? hit.concept.id : undefined;
}

// ─── Account classification ──────────────────────────────────────────────────

export interface ClassifyInput {
  name: string;
  /** Chart-of-accounts number, e.g. "6410". */
  number?: string;
  qboType?: string;
  qboSubType?: string;
  xeroType?: string;
  xeroClass?: string;
  xeroSystemAccount?: string;
}

export interface Classification {
  subtype: AccountSubtypeId | null;
  class: AccountClass | null;
  normalBalance: NormalBalance | null;
  /** 0..1. Provider subtype ≈ 0.97, provider type + name ≈ 0.88, name + number ≈ 0.9, number only ≈ 0.4. */
  confidence: number;
  rationale: string;
  basis: 'provider_subtype' | 'provider_type' | 'name' | 'number' | 'none';
}

const providerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function keyed<T>(rec: Record<string, T>): Map<string, [string, T]> {
  return new Map(Object.entries(rec).map(([k, v]) => [providerKey(k), [k, v] as [string, T]]));
}
const QBO_TYPES = keyed<ProviderTypeMapping>(QBO_ACCOUNT_TYPES);
const QBO_SUBTYPES = keyed<ProviderSubtypeMapping>(QBO_ACCOUNT_SUBTYPES);
const XERO_TYPES = keyed<ProviderTypeMapping>(XERO_ACCOUNT_TYPES);
const XERO_CLASSES = keyed<ProviderTypeMapping>(XERO_ACCOUNT_CLASSES);
const XERO_SYSTEM = keyed<AccountSubtypeId>(XERO_SYSTEM_ACCOUNTS);

/** First matching name rule; order in NAME_RULES is precedence. */
export function classifyByName(name: string): { subtype: AccountSubtypeId; weak: boolean } | null {
  const n = normalizeTerm(name);
  if (!n) return null;
  for (const r of NAME_RULES) {
    if (r.pattern.test(n) && !(r.unless && r.unless.test(n))) return { subtype: r.subtype, weak: Boolean(r.weak) };
  }
  return null;
}

type NumberClass = { cls: AccountClass | 'other'; fallback: AccountSubtypeId; digit: string };

/** Conventional US numbering: 1 assets, 2 liabilities, 3 equity, 4 revenue, 5 COGS, 6–7 opex, 8–9 other. */
function classFromNumber(num?: string): NumberClass | null {
  const m = num?.trim().match(/^(\d{3,6})(?!\d)/);
  if (!m) return null;
  const digit = m[1][0];
  const table: Record<string, Omit<NumberClass, 'digit'>> = {
    '1': { cls: 'asset', fallback: 'other_current_assets' },
    '2': { cls: 'liability', fallback: 'other_current_liabilities' },
    '3': { cls: 'equity', fallback: 'owners_equity' },
    '4': { cls: 'revenue', fallback: 'revenue' },
    '5': { cls: 'expense', fallback: 'cogs' },
    '6': { cls: 'expense', fallback: 'other_operating_expense' },
    '7': { cls: 'expense', fallback: 'other_operating_expense' },
    '8': { cls: 'other', fallback: 'other_expense' },
    '9': { cls: 'other', fallback: 'other_expense' },
  };
  const row = table[digit];
  return row ? { ...row, digit } : null;
}

const numberFits = (n: NumberClass, cls: AccountClass) => (n.cls === 'other' ? cls === 'revenue' || cls === 'expense' : n.cls === cls);
const classOf = (id: AccountSubtypeId) => SUBTYPES.get(id)!.class;
const labelOf = (id: AccountSubtypeId) => SUBTYPES.get(id)!.label;

/**
 * Map a ledger account to an ontology subtype. The provider's own type wins
 * when present; the account name narrows generic provider types; the account
 * number only sets the class. Returns nulls with confidence 0 rather than guess.
 */
export function classifyAccount(input: ClassifyInput): Classification {
  const name = input.name ?? '';
  const byName = classifyByName(name);
  const num = classFromNumber(input.number);
  const notes: string[] = [];
  let subtype: AccountSubtypeId | null = null;
  let confidence = 0;
  let basis: Classification['basis'] = 'none';

  const qboSub = input.qboSubType ? QBO_SUBTYPES.get(providerKey(input.qboSubType)) : undefined;
  const xeroSys = input.xeroSystemAccount ? XERO_SYSTEM.get(providerKey(input.xeroSystemAccount)) : undefined;
  const qboType = input.qboType ? QBO_TYPES.get(providerKey(input.qboType)) : undefined;
  const xeroType = input.xeroType ? XERO_TYPES.get(providerKey(input.xeroType)) : undefined;
  const xeroClass = input.xeroClass ? XERO_CLASSES.get(providerKey(input.xeroClass)) : undefined;
  const typed = qboType
    ? { label: `QBO AccountType "${qboType[0]}"`, map: qboType[1] }
    : xeroType
      ? { label: `Xero Type ${xeroType[0]}`, map: xeroType[1] }
      : xeroClass
        ? { label: `Xero Class ${xeroClass[0]}`, map: xeroClass[1] }
        : undefined;

  for (const [given, known] of [
    [input.qboType, qboType],
    [input.qboSubType, qboSub],
    [input.xeroType, xeroType],
    [input.xeroClass, xeroClass],
    [input.xeroSystemAccount, xeroSys],
  ] as const) {
    if (given && !known) notes.push(`Provider value "${given}" is not in the mapping.`);
  }

  if (qboSub) {
    const [enumName, [mapped, generic]] = qboSub;
    if (generic && byName && classOf(byName.subtype) === classOf(mapped)) {
      subtype = byName.subtype;
      confidence = byName.weak ? 0.75 : 0.88;
      notes.unshift(`QBO AccountSubType ${enumName} is generic; the name narrows it to ${labelOf(subtype)}.`);
    } else {
      subtype = mapped;
      confidence = generic ? 0.75 : 0.97;
      notes.unshift(`QBO AccountSubType ${enumName} maps to ${labelOf(mapped)}.`);
    }
    basis = 'provider_subtype';
    if (typed && typed.map.class !== classOf(subtype)) {
      confidence = Math.min(confidence, 0.7);
      notes.push(`${typed.label} says ${typed.map.class}, which contradicts the subtype.`);
    }
  } else if (xeroSys) {
    subtype = xeroSys[1];
    confidence = 0.97;
    basis = 'provider_subtype';
    notes.unshift(`Xero SystemAccount ${xeroSys[0]} is ${labelOf(subtype)}.`);
  } else if (typed) {
    basis = 'provider_type';
    const { map, label } = typed;
    if (!map.refineWithin) {
      subtype = map.fallback;
      confidence = 0.95;
      notes.unshift(`${label} maps to ${labelOf(subtype)}.`);
      if (byName && classOf(byName.subtype) !== map.class) {
        confidence = 0.8;
        notes.push(`The name suggests ${labelOf(byName.subtype)}; confirm the account type.`);
      }
    } else if (byName && matchesSelector(byName.subtype, map.refineWithin)) {
      subtype = byName.subtype;
      confidence = byName.weak ? 0.75 : 0.88;
      notes.unshift(`${label} fixes the class (${map.class}); the name narrows it to ${labelOf(subtype)}.`);
    } else {
      subtype = map.fallback;
      confidence = 0.65;
      notes.unshift(`${label} fixes the class (${map.class}); the name did not narrow it, so ${labelOf(subtype)}.`);
    }
  } else if (byName) {
    basis = 'name';
    subtype = byName.subtype;
    confidence = byName.weak ? 0.6 : 0.8;
    notes.unshift(`Name "${name}" reads as ${labelOf(subtype)}${byName.weak ? ' (generic wording)' : ''}.`);
    if (num) {
      if (numberFits(num, classOf(subtype))) {
        confidence += 0.1;
        notes.push(`Account number ${input.number} (${num.digit}xxx) agrees.`);
      } else if (byName.weak) {
        // A generic word loses to the number range.
        subtype = num.fallback;
        basis = 'number';
        confidence = 0.45;
        notes.push(`Account number ${input.number} (${num.digit}xxx) points to ${num.cls}; using ${labelOf(subtype)}.`);
      } else {
        confidence = 0.5;
        notes.push(`Account number ${input.number} (${num.digit}xxx) suggests ${num.cls}, which conflicts; confirm.`);
      }
    }
  } else if (num) {
    basis = 'number';
    subtype = num.fallback;
    confidence = num.cls === 'other' ? 0.3 : 0.4;
    notes.unshift(`Only the account number ${input.number} (${num.digit}xxx) is informative; defaulting to ${labelOf(subtype)}.`);
  } else {
    notes.unshift(`Could not classify "${name}": no provider type, no recognizable name, no account number.`);
  }

  if (subtype && SUSPENSE_NAME.test(normalizeTerm(name))) {
    confidence *= 0.6;
    notes.push('Looks like a suspense/clearing account; it should be cleared to zero at close.');
  }

  const def = subtype ? SUBTYPES.get(subtype)! : undefined;
  return {
    subtype,
    class: def?.class ?? null,
    normalBalance: def?.normalBalance ?? null,
    confidence: Math.round(confidence * 100) / 100,
    rationale: notes.join(' '),
    basis,
  };
}

// ─── Structural validation (verification layer 1) ────────────────────────────

export interface ChartAccount {
  code: string;
  name: string;
  /** Ontology subtype id preferred; a QBO subtype or a synonym also resolves. Absent → classified by name. */
  subtype?: string | null;
}

interface ResolvedLine {
  index: number;
  line: JournalLine;
  side: 'debit' | 'credit' | null;
  account?: ChartAccount;
  subtype: AccountSubtypeId | null;
  confidence: number;
}

function resolveChartAccount(acct: ChartAccount): { subtype: AccountSubtypeId | null; confidence: number } {
  const given = acct.subtype?.trim();
  if (given) {
    if (isAccountSubtypeId(given)) return { subtype: given, confidence: 1 };
    const qbo = QBO_SUBTYPES.get(providerKey(given));
    if (qbo) return { subtype: qbo[1][0], confidence: 0.95 };
    const hit = lookup(given, 5).find((m) => m.concept.kind === 'account_subtype' && m.score >= 0.9);
    if (hit) return { subtype: hit.concept.id as AccountSubtypeId, confidence: 0.95 };
  }
  const c = classifyAccount({ name: acct.name, number: acct.code });
  return { subtype: c.subtype, confidence: c.confidence };
}

const isIsoDate = (d: unknown): d is string =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

const isCents = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function selectorText(sel: AccountSelector): string {
  return [
    ...(sel.subtypes ?? []),
    ...(sel.tags ?? []).map((t) => `any ${t.replace(/_/g, ' ')} account`),
    ...(sel.sections ?? []).map((s) => `any ${s.replace(/_/g, ' ')} account`),
    ...(sel.classes ?? []).map((c) => `any ${c} account`),
  ].join(' | ');
}

/** "Dr depreciation_expense | cogs / Cr accumulated_depreciation". */
export function patternText(p: EntryPattern): string {
  const side = (s: 'debit' | 'credit') =>
    p.legs
      .filter((l) => l.side === s)
      .map((l) => selectorText(l.accounts))
      .join(' + ');
  return `Dr ${side('debit')} / Cr ${side('credit')}${p.strict ? '' : ' (other lines allowed)'}`;
}

function evaluatePattern(p: EntryPattern, lines: ResolvedLine[], describe: (l: ResolvedLine) => string): string[] {
  const problems: string[] = [];
  const fits = (l: ResolvedLine, side: 'debit' | 'credit', sel: AccountSelector) =>
    l.side === side && l.subtype !== null && matchesSelector(l.subtype, sel);
  for (const leg of p.legs) {
    if (!lines.some((l) => fits(l, leg.side, leg.accounts))) problems.push(`no ${leg.side} to ${leg.label}`);
  }
  if (p.strict) {
    for (const l of lines) {
      if (!l.side) continue;
      if (!p.legs.some((leg) => fits(l, leg.side, leg.accounts))) {
        problems.push(`${describe(l)} ${l.side === 'debit' ? 'debits' : 'credits'} ${l.subtype ?? 'an unclassified account'}, which is not part of the pattern`);
      }
    }
  }
  return problems;
}

/** "$1,234.56" from integer cents; locale-independent so output is deterministic. */
export const formatCents = (c: number): string => {
  const neg = c < 0;
  const abs = Math.abs(Math.trunc(c));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * Structural checks on a proposed entry against the client's chart. Pure code,
 * no model: every check returns a result (pass or fail) so the audit trail
 * shows what was verified, not just what failed.
 */
export function validateEntry(je: JournalEntry, chart: ChartAccount[]): CheckResult[] {
  const results: CheckResult[] = [];
  const lines = Array.isArray(je.lines) ? je.lines : [];
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const resolvedCache = new Map<string, { subtype: AccountSubtypeId | null; confidence: number }>();
  const resolved: ResolvedLine[] = lines.map((line, index) => {
    const account = byCode.get(line.account);
    let r = { subtype: null as AccountSubtypeId | null, confidence: 1 };
    if (account) {
      r = resolvedCache.get(account.code) ?? resolveChartAccount(account);
      resolvedCache.set(account.code, r);
    }
    const side = line.debitCents > 0 && !(line.creditCents > 0) ? 'debit' : line.creditCents > 0 && !(line.debitCents > 0) ? 'credit' : null;
    return { index, line, side, account, subtype: r.subtype, confidence: r.confidence };
  });
  const describe = (l: ResolvedLine) => `line ${l.index + 1} (${l.line.account}${l.account ? ` ${l.account.name}` : ''})`;
  const evidenceOf = (ls: ResolvedLine[]): SourceRef[] | undefined => {
    const refs = ls.flatMap((l) => l.line.sources ?? []);
    return refs.length ? refs : undefined;
  };
  const push = (id: string, pass: boolean, message: string, confidence = 1, evidence?: SourceRef[]) =>
    results.push({ id: `structural.${id}`, layer: 'structural', pass, confidence, message, ...(evidence ? { evidence } : {}) });

  // Entry type and dates.
  const def: EntryTypeDef | undefined = isJournalEntryType(je.type) ? ENTRY_TYPES[je.type] : undefined;
  push('entry_type', Boolean(def), def ? `Entry type "${je.type}" is known.` : `Unknown entry type "${String(je.type)}"; expected one of ${JOURNAL_ENTRY_TYPES.join(', ')}.`);
  push('date', isIsoDate(je.date), isIsoDate(je.date) ? `Entry date ${je.date} is a valid ISO date.` : `Entry date "${String(je.date)}" is not a valid YYYY-MM-DD date.`);

  // Line shape: integer, non-negative, exactly one side.
  const shapeProblems: string[] = [];
  const badShape: ResolvedLine[] = [];
  if (lines.length < 2) shapeProblems.push(`entry has ${lines.length} line(s); at least 2 are required`);
  for (const l of resolved) {
    const { debitCents: dr, creditCents: cr } = l.line;
    if (!isCents(dr) || !isCents(cr)) shapeProblems.push(`${describe(l)} amounts must be non-negative integer cents`);
    else if (dr > 0 && cr > 0) shapeProblems.push(`${describe(l)} has both a debit and a credit`);
    else if (dr === 0 && cr === 0) shapeProblems.push(`${describe(l)} is zero`);
    else continue;
    badShape.push(l);
  }
  push('line_shape', shapeProblems.length === 0, shapeProblems.length ? `${capitalize(shapeProblems.join('; '))}.` : 'Every line has exactly one non-zero side in integer cents.', 1, evidenceOf(badShape));

  // Balance.
  const debits = lines.reduce((s, l) => s + (Number.isFinite(l.debitCents) ? l.debitCents : 0), 0);
  const credits = lines.reduce((s, l) => s + (Number.isFinite(l.creditCents) ? l.creditCents : 0), 0);
  const balanced = debits === credits && debits > 0;
  push(
    'balanced',
    balanced,
    balanced
      ? `Debits equal credits at ${formatCents(debits)}.`
      : debits === 0 && credits === 0
        ? 'Entry has no amount.'
        : `Debits ${formatCents(debits)} ≠ credits ${formatCents(credits)} (off by ${formatCents(Math.abs(debits - credits))}).`,
  );

  // Accounts exist in the client's chart.
  const missing = resolved.filter((l) => !l.account);
  push(
    'accounts_exist',
    missing.length === 0,
    missing.length ? `Not in the chart of accounts: ${missing.map(describe).join(', ')}.` : 'Every line posts to an account in the chart.',
    1,
    evidenceOf(missing),
  );

  // Evidence: "no source, not allowed".
  const unsourced = resolved.filter((l) => !(l.line.sources ?? []).some((s) => s && s.system && s.id));
  push('sources', unsourced.length === 0, unsourced.length ? `No source on ${unsourced.map(describe).join(', ')}.` : 'Every line cites at least one source.');

  // Account pattern for the entry type.
  const patternConfidence = Math.min(1, ...resolved.filter((l) => l.account).map((l) => l.confidence));
  if (!def) {
    push('pattern', false, 'Account pattern not checked: unknown entry type.');
  } else if (def.patterns.length === 0) {
    push('pattern', true, `${def.label}s have no fixed account pattern.`);
  } else {
    const evaluated = def.patterns.map((p) => ({ p, problems: evaluatePattern(p, resolved, describe) }));
    const ok = evaluated.find((e) => e.problems.length === 0);
    if (ok) {
      push('pattern', true, `Matches the ${def.label.toLowerCase()} pattern "${ok.p.name}": ${patternText(ok.p)}.`, patternConfidence);
    } else {
      const best = evaluated.reduce((a, b) => (b.problems.length < a.problems.length ? b : a));
      const expected = def.patterns.map((p) => patternText(p)).join(' OR ');
      push('pattern', false, `${def.label} must be ${expected}. Found: ${best.problems.join('; ')}.`, patternConfidence);
    }
  }

  // Auto-reversal.
  if (def?.autoReverse && !je.reversesOn) {
    push('reversal', false, `${def.label}s must auto-reverse: set reversesOn (usually the first day of the next period).`);
  } else if (je.reversesOn !== undefined && je.reversesOn !== null) {
    const ok = isIsoDate(je.reversesOn) && isIsoDate(je.date) && je.reversesOn > je.date;
    push('reversal', ok, ok ? `Reverses on ${je.reversesOn}.` : `reversesOn "${String(je.reversesOn)}" must be a valid date after the entry date ${String(je.date)}.`);
  } else {
    push('reversal', true, 'No reversal required.');
  }

  // Normal-balance direction: period-end entries should not reduce expense, revenue or accumulated contras.
  if (!def || !def.enforceDirection) {
    push('direction', true, `Direction not enforced for ${def ? def.label.toLowerCase() + 's' : 'unknown entry types'}.`);
  } else {
    const against = resolved.filter((l) => {
      if (!l.side || !l.subtype) return false;
      const s = SUBTYPES.get(l.subtype)!;
      const sensitive = ((s.class === 'expense' || s.class === 'revenue') && !s.contraOf) || s.id === 'accumulated_depreciation' || s.id === 'accumulated_amortization';
      if (!sensitive || l.side === s.normalBalance) return false;
      return !(def.allowAgainstNormal && matchesSelector(l.subtype, def.allowAgainstNormal));
    });
    push(
      'direction',
      against.length === 0,
      against.length
        ? `Against normal balance in a ${def.label.toLowerCase()}: ${against
            .map((l) => `${describe(l)} ${l.side === 'debit' ? 'debits' : 'credits'} ${l.subtype} (normal ${SUBTYPES.get(l.subtype!)!.normalBalance})`)
            .join('; ')}.`
        : 'Every line moves its account in a sane direction for this entry type.',
      against.length ? Math.min(0.85, patternConfidence) : patternConfidence,
      evidenceOf(against),
    );
  }

  return results;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ─── Explain and prompt context ──────────────────────────────────────────────

function firstSentence(s: string, max = 170): string {
  const i = s.search(/\.\s/);
  const one = i >= 0 ? s.slice(0, i + 1) : s;
  return clip(one, max);
}

export function clip(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Join lines in priority order without exceeding `maxChars`; lines that do not fit are skipped. */
export function fitLines(lines: string[], maxChars: number): string {
  if (maxChars <= 0) return '';
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length <= maxChars) out = next;
    else if (!out) return clip(line, maxChars);
  }
  return out;
}

const drcr = (b: NormalBalance) => (b === 'debit' ? 'Dr' : 'Cr');
const stdCode = (id: StandardId) => STANDARDS.find((s) => s.id === id)!.code;

/** One lean line per concept, for prompts. */
export function conceptLine(c: Concept): string {
  const stds = c.standards?.length ? ` [${c.standards.map(stdCode).join(', ')}]` : '';
  switch (c.kind) {
    case 'account_subtype':
      return `${c.id}: ${c.label}; ${c.class}${c.contraOf ? ` contra (of ${c.contraOf.slice(0, 3).join(', ')}${c.contraOf.length > 3 ? ', …' : ''})` : ''}, normal ${drcr(c.normalBalance)}. ${firstSentence(c.definition)}${stds}`;
    case 'account_class':
      return `${c.label}: normal ${drcr(c.normalBalance)}; numbered ${c.numberPrefixes.join('/')}xxx.`;
    case 'contra_class':
      return `${c.label}: normal ${drcr(c.normalBalance)}. ${firstSentence(c.definition)}`;
    case 'entry_type':
      return `JE ${c.entryType}: ${c.patterns.length ? c.patterns.map(patternText).join(' OR ') : 'no fixed pattern'}${c.autoReverse ? '; must set reversesOn (auto-reverse)' : ''}.${stds}`;
    case 'schedule':
      return `${c.label}: ${c.rollForward.opening} + ${c.rollForward.additions.join(' + ')} − ${c.rollForward.reductions.join(' − ')} = ${c.rollForward.closing}; ties to ${selectorText(c.supports)}.${stds}`;
    case 'reconciliation':
      return `${c.label}: ${c.sides[0].name} ↔ ${c.sides[1].name}; match on ${c.matchOn.join(', ')}; proof: ${c.proof}.`;
    case 'txn_category':
      return `${c.label} → ${c.subtype}${c.direction !== 'either' ? ` (${c.direction})` : ''}. ${firstSentence(c.definition)}`;
    case 'standard':
      return `${c.code} ${c.label}: ${firstSentence(c.definition, 220)}`;
    case 'close_task':
      return `Close: ${c.label}${c.dependsOn.length ? ` after ${c.dependsOn.join(', ')}` : ''}.${stds}`;
  }
}

const KIND_LABEL: Record<ConceptKind, string> = {
  account_class: 'account class',
  contra_class: 'contra class',
  account_subtype: 'account subtype',
  entry_type: 'journal entry type',
  schedule: 'schedule',
  reconciliation: 'reconciliation',
  txn_category: 'transaction category',
  standard: 'accounting standard',
  close_task: 'close task',
};

/** A short, human explanation of a concept with its standard references. Accepts an id or a term. */
export function explain(conceptId: string): string {
  const id = resolveConceptId(conceptId);
  const c = id ? BY_ID.get(id) : undefined;
  if (!c) return `Unknown concept "${conceptId}". Try ontology_lookup to find the right id.`;
  const out: string[] = [`${c.kind === 'standard' ? `${c.code} ` : ''}${c.label} (${KIND_LABEL[c.kind]}, id ${c.id}).`, c.definition];
  const names = (ids: string[]) => ids.map((i) => BY_ID.get(i)?.label ?? i).join(', ');
  switch (c.kind) {
    case 'account_subtype':
      out.push(`${capitalize(c.class)}${c.contraOf ? ' (contra)' : ''}; normal ${c.normalBalance} balance; presented in ${c.section.replace(/_/g, ' ')}.`);
      if (c.contraOf) out.push(`Contra of: ${names(c.contraOf)}.`);
      break;
    case 'entry_type':
      out.push(c.patterns.length ? `Pattern: ${c.patterns.map(patternText).join(' OR ')}.` : 'No fixed account pattern.');
      if (c.autoReverse) out.push('Must carry reversesOn so it auto-reverses next period.');
      break;
    case 'schedule':
      out.push(`Roll-forward: ${c.rollForward.opening} + ${c.rollForward.additions.join(' + ')} − ${c.rollForward.reductions.join(' − ')} = ${c.rollForward.closing}.`);
      out.push(`Rows need: ${c.requiredFields.join(', ')}.`);
      break;
    case 'reconciliation':
      out.push(`Sides: ${c.sides.map((s) => `${s.name} (${s.system}: ${s.requiredFields.join(', ')})`).join(' vs ')}.`);
      out.push(`Proof: ${c.proof}. Typical reconciling items: ${c.reconcilingItems.join(', ')}.`);
      break;
    case 'close_task':
      if (c.dependsOn.length) out.push(`Runs after: ${names(c.dependsOn)}.`);
      break;
    case 'txn_category':
      out.push(`Codes to ${labelOf(c.subtype)} (${c.subtype}).`);
      break;
    default:
      break;
  }
  const rel = (kind: RelationKind, dir: 'from' | 'to') =>
    relations(dir === 'from' ? { from: c.id, kind } : { to: c.id, kind }).map((r) => (dir === 'from' ? r.to : r.from));
  const rolledBy = rel('rolls_forward_to', 'to');
  if (rolledBy.length) out.push(`Rolled forward by: ${names(rolledBy)}.`);
  const recBy = rel('reconciles_to', 'to');
  if (recBy.length) out.push(`Reconciled by: ${names(recBy)}.`);
  if (c.kind === 'standard') {
    const governs = rel('governed_by', 'to');
    if (governs.length) out.push(`Governs: ${names(governs.slice(0, 12))}${governs.length > 12 ? ', …' : ''}.`);
  } else if (c.standards?.length) {
    out.push(`Standards: ${c.standards.map((s) => { const d = STANDARDS.find((x) => x.id === s)!; return `${d.code} ${d.label}`; }).join('; ')}.`);
  }
  return out.join('\n');
}

export interface ContextRequest {
  /** Concept ids or free-text terms. */
  concepts?: string[];
  entryType?: JournalEntryType;
  /** Skill name, e.g. "depreciation" or "bank-reconciliation". */
  skill?: string;
}

const ENTRY_RULES = 'Every JE: debits = credits in integer cents; one side per line; every line cites ≥1 source; accounts must exist in the chart.';
const NORMAL_BALANCES = 'Normal balances: asset/expense Dr; liability/equity/revenue Cr; contra accounts the opposite.';

export function skillConcepts(skill?: string): string[] {
  if (!skill) return [];
  // Catalog ids first: an explicit mapping beats a fuzzy lookup.
  if (skill in CATALOG_SKILL_ALIASES) {
    const alias = CATALOG_SKILL_ALIASES[skill];
    return alias ? SKILL_CONCEPTS[alias] : [];
  }
  const key = skill.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return SKILL_CONCEPTS[key] ?? lookup(skill, 3).filter((m) => m.score >= 0.6).map((m) => m.concept.id);
}

/**
 * Lean prompt text for a task: only the concepts it needs, most relevant
 * first, trimmed to `maxChars` by dropping whole lines from the tail.
 */
export function contextFor(req: ContextRequest, maxChars = 1500): string {
  const primary: string[] = [];
  if (req.entryType && isJournalEntryType(req.entryType)) primary.push(ENTRY_TYPES[req.entryType].id);
  for (const t of req.concepts ?? []) {
    const id = resolveConceptId(t);
    if (id) primary.push(id);
  }
  primary.push(...skillConcepts(req.skill));

  const order: string[] = [];
  const add = (id: string) => {
    if (BY_ID.has(id) && !order.includes(id)) order.push(id);
  };
  primary.forEach(add);
  // Second ring: each leg's primary account (alternates like COGS stay out to keep it lean), and contra partners.
  for (const id of [...order]) {
    const c = BY_ID.get(id)!;
    if (c.kind === 'entry_type') {
      c.patterns.forEach((p) =>
        p.legs.forEach((l) => {
          if (!l.accounts.tags && !l.accounts.classes && l.accounts.subtypes?.[0]) add(l.accounts.subtypes[0]);
        }),
      );
    }
    if (c.kind === 'schedule') (c.supports.subtypes ?? []).forEach(add);
    if (c.kind === 'reconciliation') (c.accounts.subtypes ?? []).forEach(add);
    if (c.kind === 'account_subtype') {
      (c.contraOf ?? []).slice(0, 2).forEach(add);
      relations({ to: c.id, kind: 'contra_of' }).forEach((r) => add(r.from));
    }
  }
  // Third ring: governing standards.
  for (const id of [...order]) for (const s of BY_ID.get(id)!.standards ?? []) add(s);

  const lines = ['Accounting ontology (US GAAP):'];
  const body = order.map((id) => conceptLine(BY_ID.get(id)!));
  if (req.entryType) lines.push(body.shift() ?? '', ENTRY_RULES);
  lines.push(...body, NORMAL_BALANCES);
  return fitLines(lines.filter(Boolean), maxChars);
}

// ─── Close order ─────────────────────────────────────────────────────────────

export interface CloseStep {
  id: CloseTaskId;
  label: string;
  dependsOn: CloseTaskId[];
  /** Longest dependency chain beneath the task; tasks with equal level can run in parallel. */
  level: number;
  uses: string[];
  standards: StandardId[];
}

/**
 * Month-end close tasks in dependency order. With `include`, returns only
 * those tasks and everything they transitively depend on.
 */
export function closeOrder(opts: { include?: string[] } = {}): CloseStep[] {
  const byId = new Map<string, CloseTaskDef>(CLOSE_TASKS.map((t) => [t.id, t]));
  let wanted: Set<string>;
  if (opts.include?.length) {
    const unknown = opts.include.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown close task(s): ${unknown.join(', ')}.`);
    wanted = new Set<string>();
    const visit = (id: string) => {
      if (wanted.has(id)) return;
      wanted.add(id);
      byId.get(id)!.dependsOn.forEach(visit);
    };
    opts.include.forEach(visit);
  } else {
    wanted = new Set(byId.keys());
  }

  const level = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();
  const depth = (id: string): number => {
    if (state.get(id) === 'done') return level.get(id)!;
    if (state.get(id) === 'visiting') throw new Error(`Close dependency cycle through ${id}.`);
    state.set(id, 'visiting');
    const t = byId.get(id)!;
    const l = t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map(depth)) : 0;
    state.set(id, 'done');
    level.set(id, l);
    return l;
  };
  CLOSE_TASKS.forEach((t) => depth(t.id));

  // Stable: by level, then by declaration order. Dependencies always have a lower level.
  return CLOSE_TASKS.filter((t) => wanted.has(t.id))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => level.get(a.t.id)! - level.get(b.t.id)! || a.i - b.i)
    .map(({ t }) => ({ id: t.id, label: t.label, dependsOn: [...t.dependsOn], level: level.get(t.id)!, uses: [...t.uses], standards: [...(t.standards ?? [])] }));
}

// ─── Transaction coding ──────────────────────────────────────────────────────

export interface TxnCategoryMatch {
  category: TxnCategoryDef;
  subtype: AccountSubtypeId;
  confidence: number;
  matched: string;
}

/**
 * Candidate categories for a bank/card transaction from its description and
 * counterparty. Assumes negative amount = money out; a direction mismatch
 * halves confidence rather than excluding, since feeds disagree on sign.
 */
export function categorizeTransaction(txn: Pick<Txn, 'description'> & Partial<Pick<Txn, 'counterparty' | 'amountCents'>>): TxnCategoryMatch[] {
  const desc = normalizeTerm(txn.description ?? '');
  const party = normalizeTerm(txn.counterparty ?? '');
  const flow = txn.amountCents === undefined || txn.amountCents === 0 ? null : txn.amountCents < 0 ? 'outflow' : 'inflow';
  const out: TxnCategoryMatch[] = [];
  for (const cat of TXN_CATEGORIES) {
    let best: { score: number; kw: string } | null = null;
    for (const kw of cat.keywords) {
      const k = normalizeTerm(kw);
      const inParty = party && hasPhrase(party, k);
      if (!inParty && !hasPhrase(desc, k)) continue;
      // Longer keywords are more specific ("uber eats" beats "uber").
      const score = (inParty ? 0.85 : 0.75) + Math.min(0.1, k.length / 200);
      if (!best || score > best.score) best = { score, kw };
    }
    if (!best) continue;
    const mismatch = flow && cat.direction !== 'either' && cat.direction !== flow;
    out.push({ category: cat, subtype: cat.subtype, confidence: Math.round(best.score * (mismatch ? 0.5 : 1) * 100) / 100, matched: best.kw });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.matched.length - a.matched.length);
}
