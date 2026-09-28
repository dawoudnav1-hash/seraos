import type { Cents, IsoDate, SourceRef, Txn } from './types';

/**
 * The matching engine: one deterministic algorithm behind every reconciliation
 * (bank vs GL, card vs GL, GL vs subledger, Stripe payouts vs bank). No model
 * calls; every record is accounted for exactly once, across matches or exceptions.
 */

export interface MatchConfig {
  /** Amount tolerance in cents for "exact amount" comparisons. Default 0. */
  amountToleranceCents: Cents;
  /** Date tolerance in days for date-window strategies. Default 3. */
  dateToleranceDays: number;
  /** FX tolerance in basis points for cross-currency amount comparisons. Default 50 (0.5%). */
  fxToleranceBps: number;
  /** Minimum normalized similarity (0..1) to accept a fuzzy reference/counterparty match. Default 0.82. */
  fuzzyThreshold: number;
  /** Max records combined on one side of a group (one-to-many / many-to-one). Default 6. */
  maxGroupSize: number;
  /** Day window searched for group-aggregation candidates. Default 10. */
  groupDateWindowDays: number;
  /** Date used to bucket exception aging. Defaults to the latest txn date seen. */
  asOf?: IsoDate;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  amountToleranceCents: 0,
  dateToleranceDays: 3,
  fxToleranceBps: 50,
  fuzzyThreshold: 0.82,
  maxGroupSize: 6,
  groupDateWindowDays: 10,
};

export type MatchType = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

export type MatchingBasis =
  | 'exact_identifier'
  | 'exact_amount_date'
  | 'identifier_amount'
  | 'identifier_date'
  | 'amount_date_tolerance'
  | 'reference_similarity'
  | 'counterparty_similarity'
  | 'group_aggregation'
  | 'fuzzy';

export type VarianceCategory =
  | 'FX Difference'
  | 'Timing Difference'
  | 'Bank Fee'
  | 'Interest'
  | 'Rounding'
  | 'Duplicate Posting'
  | 'Missing Entry'
  | 'Partial Payment'
  | 'Credit Note'
  | 'Unexplained Difference';

export interface Match {
  matchId: string;
  matchType: MatchType;
  sourceAIds: string[];
  sourceBIds: string[];
  matchedAmount: Cents;
  confidence: number;
  matchingBasis: MatchingBasis[];
  variance: { amount: Cents; category: VarianceCategory | null };
}

export type ExceptionCategory =
  | 'Missing from Source A'
  | 'Missing from Source B'
  | 'Amount Mismatch'
  | 'Duplicate'
  | 'Reference Mismatch'
  | 'Currency Difference'
  | 'Date Difference'
  | 'Manual Review Required'
  | 'Insufficient Evidence';

export type AgingBucket = 'Current' | '1-30' | '31-60' | '61-90' | '91-180' | '181-365' | '365+';

export interface Exception {
  id: string;
  side: 'A' | 'B';
  category: ExceptionCategory;
  recommendedAction: string;
  agingBucket: AgingBucket;
  amountCents: Cents;
  source: SourceRef;
}

export interface Duplicate {
  side: 'A' | 'B';
  ids: string[];
  amountCents: Cents;
  confidence: number;
  reason: 'same_amount_counterparty_date_window' | 'same_reference';
}

export interface ReconciliationSummary {
  reconciliationType: string;
  currency: string;
  totalRecordsA: number;
  totalRecordsB: number;
  matchedRecords: number;
  unmatchedRecords: number;
  duplicateRecords: number;
  matchedAmount: Cents;
  unmatchedAmount: Cents;
  overallConfidence: number;
  status: 'reconciled' | 'partially_reconciled' | 'unreconciled';
}

export interface Metrics {
  exactMatches: number;
  fuzzyMatches: number;
  oneToMany: number;
  manyToOne: number;
  manualReviewCount: number;
  fxVariance: Cents;
  timingVariance: Cents;
  bankFeeVariance: Cents;
  otherVariance: Cents;
}

export interface Validation {
  mathVerified: boolean;
  totalsVerified: boolean;
  noDuplicateUse: boolean;
  auditTrailComplete: boolean;
}

export interface ReconciliationResult {
  summary: ReconciliationSummary;
  matches: Match[];
  exceptions: Exception[];
  duplicates: Duplicate[];
  metrics: Metrics;
  validation: Validation;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Strips prefixes, punctuation and leading zeros so ids from different systems compare equal. */
export function normalizeIdentifier(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = raw.trim().toUpperCase();
  s = s.replace(/^(CHK|CHECK|REF|TXN|ACH|WIRE|INV|PO)[-#:\s]*/i, '');
  s = s.replace(/[^A-Z0-9]/g, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

/** Lowercase, collapsed whitespace, punctuation-stripped description/reference. */
export function normalizeText(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDate(raw: string): IsoDate {
  return raw.slice(0, 10);
}

function daysBetween(a: IsoDate, b: IsoDate): number {
  const ta = Date.parse(normalizeDate(a));
  const tb = Date.parse(normalizeDate(b));
  return Math.abs(Math.round((ta - tb) / 86400000));
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** Levenshtein similarity ratio: 1 - distance / maxLen. 1.0 for equal strings, 0 for maximally different. */
export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dp: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const dist = dp[b.length];
  return 1 - dist / Math.max(a.length, b.length);
}

/** Jaro-Winkler similarity, 0..1. Standard implementation, prefix bonus up to 4 chars. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aFlags = new Array(a.length).fill(false);
  const bFlags = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bFlags[j] || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  const aMatched: string[] = [];
  const bMatched: string[] = [];
  for (let i = 0; i < a.length; i++) if (aFlags[i]) aMatched.push(a[i]);
  for (let j = 0; j < b.length; j++) if (bFlags[j]) bMatched.push(b[j]);
  let transpositions = 0;
  for (let k = 0; k < aMatched.length; k++) if (aMatched[k] !== bMatched[k]) transpositions++;
  transpositions = Math.floor(transpositions / 2);
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token overlap ratio: |intersection| / |union| of normalized word sets. */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/** Combined reference similarity: max(Jaro-Winkler, Levenshtein) blended with token overlap. */
export function referenceSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const jw = jaroWinkler(na, nb);
  const lev = levenshteinRatio(na, nb);
  const tok = tokenOverlap(na, nb);
  return Math.max(jw, lev) * 0.7 + tok * 0.3;
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export function agingBucket(date: IsoDate, asOf: IsoDate): AgingBucket {
  const days = Math.round((Date.parse(normalizeDate(asOf)) - Date.parse(normalizeDate(date))) / 86400000);
  if (days <= 0) return 'Current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  if (days <= 365) return '181-365';
  return '365+';
}

// ---------------------------------------------------------------------------
// Engine internals
// ---------------------------------------------------------------------------

interface Pool {
  remaining: Map<string, Txn>;
}

function makePool(txns: Txn[]): Pool {
  const remaining = new Map<string, Txn>();
  for (const t of txns) remaining.set(t.id, t);
  return { remaining };
}

/** Stable sort key: id-based, so tie-breaks are deterministic across runs. */
function byId(a: Txn, b: Txn): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function fxWithinTolerance(amountA: Cents, amountB: Cents, bps: number): boolean {
  const base = Math.max(Math.abs(amountA), Math.abs(amountB));
  if (base === 0) return amountA === amountB;
  return Math.abs(amountA - amountB) <= Math.round((base * bps) / 10000);
}

function classifyVariance(a: { amountCents: Cents; date: IsoDate; description: string }, b: { amountCents: Cents; date: IsoDate; description: string }): VarianceCategory | null {
  const diff = a.amountCents - b.amountCents;
  if (diff === 0) return null;
  const descA = normalizeText(a.description);
  const descB = normalizeText(b.description);
  if (Math.abs(diff) <= 5 && a.date === b.date) return 'Rounding';
  if (/fee|charge/.test(descA) || /fee|charge/.test(descB)) return 'Bank Fee';
  if (/interest/.test(descA) || /interest/.test(descB)) return 'Interest';
  if (/credit note|refund/.test(descA) || /credit note|refund/.test(descB)) return 'Credit Note';
  if (a.date !== b.date && Math.abs(diff) <= 5) return 'Timing Difference';
  if (Math.abs(a.amountCents) > 0 && Math.abs(diff) < Math.abs(a.amountCents)) return 'Partial Payment';
  return 'Unexplained Difference';
}

/**
 * FNV-1a 32-bit hash, hex-encoded. Content-derived match ids keep the engine
 * pure: no module-level counter, so the same input yields the same ids no
 * matter how many times or in what order `reconcile` has run before it.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildMatch(
  aList: Txn[],
  bList: Txn[],
  basis: MatchingBasis[],
  confidence: number,
): Match {
  const amountA = aList.reduce((s, t) => s + t.amountCents, 0);
  const amountB = bList.reduce((s, t) => s + t.amountCents, 0);
  const matchType: MatchType = aList.length === 1 && bList.length === 1 ? 'one_to_one' : aList.length === 1 ? 'one_to_many' : bList.length === 1 ? 'many_to_one' : 'many_to_many';
  const variance = classifyVariance(
    { amountCents: amountA, date: aList[0].date, description: aList.map((t) => t.description).join(' ') },
    { amountCents: amountB, date: bList[0].date, description: bList.map((t) => t.description).join(' ') },
  );
  const idSeed = `${basis.join(',')}|${aList.map((t) => t.id).sort().join(',')}|${bList.map((t) => t.id).sort().join(',')}`;
  return {
    matchId: `M-${fnv1a(idSeed)}`,
    matchType,
    sourceAIds: aList.map((t) => t.id).sort(),
    sourceBIds: bList.map((t) => t.id).sort(),
    matchedAmount: Math.min(Math.abs(amountA), Math.abs(amountB)) * Math.sign(amountA || amountB || 1),
    confidence,
    matchingBasis: basis,
    variance: { amount: amountA - amountB, category: variance },
  };
}

/** Subset-sum search bounded by maxGroupSize and a date window, deterministic tie-break by id order. */
function findSubsetSum(candidates: Txn[], targetCents: Cents, toleranceCents: Cents, maxGroupSize: number): Txn[] | null {
  const sorted = [...candidates].sort(byId);
  const n = sorted.length;
  if (n === 0) return null;
  let best: Txn[] | null = null;
  let bestDiff = Infinity;

  function search(start: number, chosen: Txn[], sum: Cents): void {
    if (chosen.length > 0) {
      const diff = Math.abs(sum - targetCents);
      if (diff <= toleranceCents && diff < bestDiff) {
        bestDiff = diff;
        best = [...chosen];
      }
    }
    if (chosen.length >= maxGroupSize || best !== null) return;
    for (let i = start; i < n; i++) {
      chosen.push(sorted[i]);
      search(i + 1, chosen, sum + sorted[i].amountCents);
      chosen.pop();
    }
  }
  search(0, [], 0);
  return best;
}

// ---------------------------------------------------------------------------
// Public engine entry point
// ---------------------------------------------------------------------------

export function reconcile(
  sourceA: Txn[],
  sourceB: Txn[],
  reconciliationType: string,
  currency: string,
  config: Partial<MatchConfig> = {},
): ReconciliationResult {
  const cfg: MatchConfig = { ...DEFAULT_MATCH_CONFIG, ...config };
  const poolA = makePool(sourceA);
  const poolB = makePool(sourceB);
  const matches: Match[] = [];

  const metrics: Metrics = {
    exactMatches: 0,
    fuzzyMatches: 0,
    oneToMany: 0,
    manyToOne: 0,
    manualReviewCount: 0,
    fxVariance: 0,
    timingVariance: 0,
    bankFeeVariance: 0,
    otherVariance: 0,
  };

  function recordMatch(m: Match, exact: boolean): void {
    matches.push(m);
    if (exact) metrics.exactMatches++;
    else metrics.fuzzyMatches++;
    if (m.matchType === 'one_to_many') metrics.oneToMany++;
    if (m.matchType === 'many_to_one') metrics.manyToOne++;
    switch (m.variance.category) {
      case 'FX Difference':
        metrics.fxVariance += Math.abs(m.variance.amount);
        break;
      case 'Timing Difference':
        metrics.timingVariance += Math.abs(m.variance.amount);
        break;
      case 'Bank Fee':
        metrics.bankFeeVariance += Math.abs(m.variance.amount);
        break;
      default:
        if (m.variance.category) metrics.otherVariance += Math.abs(m.variance.amount);
    }
    for (const id of m.sourceAIds) poolA.remaining.delete(id);
    for (const id of m.sourceBIds) poolB.remaining.delete(id);
  }

  const sortedA = () => [...poolA.remaining.values()].sort(byId);
  const sortedB = () => [...poolB.remaining.values()].sort(byId);

  // Strategy 1: exact identifier (reference, normalized).
  for (const a of sortedA()) {
    const idA = normalizeIdentifier(a.reference);
    if (!idA) continue;
    const b = sortedB().find((x) => normalizeIdentifier(x.reference) === idA);
    if (b) recordMatch(buildMatch([a], [b], ['exact_identifier'], 100), true);
  }

  // Strategy 2: exact amount + same date.
  for (const a of sortedA()) {
    const b = sortedB().find((x) => x.amountCents === a.amountCents && normalizeDate(x.date) === normalizeDate(a.date));
    if (b) recordMatch(buildMatch([a], [b], ['exact_amount_date'], 95), true);
  }

  // Strategy 3: identifier + amount.
  for (const a of sortedA()) {
    const idA = normalizeIdentifier(a.reference);
    if (!idA) continue;
    const b = sortedB().find((x) => normalizeIdentifier(x.reference) === idA && x.amountCents === a.amountCents);
    if (b) recordMatch(buildMatch([a], [b], ['identifier_amount'], 95), true);
  }

  // Strategy 4: identifier + date (within tolerance).
  for (const a of sortedA()) {
    const idA = normalizeIdentifier(a.reference);
    if (!idA) continue;
    const b = sortedB().find((x) => normalizeIdentifier(x.reference) === idA && daysBetween(x.date, a.date) <= cfg.dateToleranceDays);
    if (b) recordMatch(buildMatch([a], [b], ['identifier_date'], 90), true);
  }

  // Strategy 5: amount + date within tolerance (incl. FX tolerance for cross-currency amounts).
  for (const a of sortedA()) {
    const b = sortedB().find((x) => {
      if (daysBetween(x.date, a.date) > cfg.dateToleranceDays) return false;
      const withinAmount = Math.abs(x.amountCents - a.amountCents) <= cfg.amountToleranceCents;
      const withinFx = a.currency && x.currency && a.currency !== x.currency && fxWithinTolerance(a.amountCents, x.amountCents, cfg.fxToleranceBps);
      return withinAmount || withinFx;
    });
    if (b) {
      const basis: MatchingBasis[] = ['amount_date_tolerance'];
      recordMatch(buildMatch([a], [b], basis, 85), false);
    }
  }

  // Strategy 6: reference similarity (fuzzy).
  for (const a of sortedA()) {
    let bestB: Txn | null = null;
    let bestScore = 0;
    for (const b of sortedB()) {
      const score = referenceSimilarity(a.reference ?? a.description, b.reference ?? b.description);
      if (score > bestScore) {
        bestScore = score;
        bestB = b;
      }
    }
    if (bestB && bestScore >= cfg.fuzzyThreshold) {
      recordMatch(buildMatch([a], [bestB], ['reference_similarity'], 90), false);
    }
  }

  // Strategy 7: counterparty similarity + amount tolerance.
  for (const a of sortedA()) {
    if (!a.counterparty) continue;
    let bestB: Txn | null = null;
    let bestScore = 0;
    for (const b of sortedB()) {
      if (!b.counterparty) continue;
      if (Math.abs(a.amountCents - b.amountCents) > Math.max(cfg.amountToleranceCents, 1)) continue;
      const score = referenceSimilarity(a.counterparty, b.counterparty);
      if (score > bestScore) {
        bestScore = score;
        bestB = b;
      }
    }
    if (bestB && bestScore >= cfg.fuzzyThreshold) {
      recordMatch(buildMatch([a], [bestB], ['counterparty_similarity'], 85), false);
    }
  }

  // Strategy 8: group aggregation — one A vs many B (subset sum), then many A vs one B.
  for (const a of sortedA()) {
    const window = sortedB().filter((b) => daysBetween(b.date, a.date) <= cfg.groupDateWindowDays);
    if (window.length < 2) continue;
    const group = findSubsetSum(window, a.amountCents, cfg.amountToleranceCents, cfg.maxGroupSize);
    if (group && group.length >= 2) {
      recordMatch(buildMatch([a], group, ['group_aggregation'], 80), false);
    }
  }
  for (const b of sortedB()) {
    const window = sortedA().filter((a) => daysBetween(a.date, b.date) <= cfg.groupDateWindowDays);
    if (window.length < 2) continue;
    const group = findSubsetSum(window, b.amountCents, cfg.amountToleranceCents, cfg.maxGroupSize);
    if (group && group.length >= 2) {
      recordMatch(buildMatch(group, [b], ['group_aggregation'], 80), false);
    }
  }

  // Strategy 9: broad fuzzy fallback (description similarity + loose amount tolerance).
  for (const a of sortedA()) {
    let bestB: Txn | null = null;
    let bestScore = 0;
    for (const b of sortedB()) {
      if (Math.abs(a.amountCents - b.amountCents) > Math.max(cfg.amountToleranceCents * 3, 100)) continue;
      const score = referenceSimilarity(a.description, b.description);
      if (score > bestScore) {
        bestScore = score;
        bestB = b;
      }
    }
    if (bestB && bestScore >= cfg.fuzzyThreshold - 0.1) {
      recordMatch(buildMatch([a], [bestB], ['fuzzy'], 70), false);
    }
  }

  // Strategy 10: everything left is manual review — handled below as exceptions.
  const asOf = cfg.asOf ?? [...sourceA, ...sourceB].map((t) => normalizeDate(t.date)).sort().pop() ?? '9999-12-31';

  const exceptions: Exception[] = [];
  function classifyLeftover(t: Txn, side: 'A' | 'B'): Exception {
    const otherPool = side === 'A' ? sourceB : sourceA;
    const sameAmount = otherPool.find((o) => o.amountCents === t.amountCents);
    let category: ExceptionCategory = side === 'A' ? 'Missing from Source B' : 'Missing from Source A';
    let action = 'Investigate and obtain the missing record, or confirm it does not apply.';
    if (sameAmount) {
      if (sameAmount.currency && t.currency && sameAmount.currency !== t.currency) {
        category = 'Currency Difference';
        action = 'Confirm FX rate applied and tolerance; adjust or match manually.';
      } else if (normalizeDate(sameAmount.date) !== normalizeDate(t.date)) {
        category = 'Date Difference';
        action = 'Confirm timing (post date vs value date) and match manually.';
      } else if (normalizeIdentifier(sameAmount.reference) !== normalizeIdentifier(t.reference)) {
        category = 'Reference Mismatch';
        action = 'Confirm reference mapping and match manually.';
      } else {
        category = 'Manual Review Required';
        action = 'Insufficient distinguishing evidence; route to manual review.';
      }
    } else if (!t.reference && !t.counterparty) {
      category = 'Insufficient Evidence';
      action = 'Record lacks reference and counterparty; request source documentation.';
    }
    return {
      id: t.id,
      side,
      category,
      recommendedAction: action,
      agingBucket: agingBucket(t.date, asOf),
      amountCents: t.amountCents,
      source: t.source,
    };
  }

  for (const t of sortedA()) exceptions.push(classifyLeftover(t, 'A'));
  for (const t of sortedB()) exceptions.push(classifyLeftover(t, 'B'));
  metrics.manualReviewCount = exceptions.filter((e) => e.category === 'Manual Review Required' || e.category === 'Insufficient Evidence').length;

  // Duplicate detection, within each side independently, before any consumption of matched ids.
  const duplicates: Duplicate[] = [
    ...findDuplicates(sourceA, 'A', cfg),
    ...findDuplicates(sourceB, 'B', cfg),
  ];

  const matchedA = matches.reduce((s, m) => s + m.sourceAIds.length, 0);
  const matchedB = matches.reduce((s, m) => s + m.sourceBIds.length, 0);
  const matchedAmountTotal = matches.reduce((s, m) => s + Math.abs(m.matchedAmount), 0);
  const unmatchedAmountTotal = exceptions.reduce((s, e) => s + Math.abs(e.amountCents), 0);
  const overallConfidence = matches.length > 0 ? matches.reduce((s, m) => s + m.confidence, 0) / matches.length / 100 : 0;

  const summary: ReconciliationSummary = {
    reconciliationType,
    currency,
    totalRecordsA: sourceA.length,
    totalRecordsB: sourceB.length,
    matchedRecords: matchedA + matchedB,
    unmatchedRecords: exceptions.length,
    duplicateRecords: duplicates.reduce((s, d) => s + d.ids.length, 0),
    matchedAmount: matchedAmountTotal,
    unmatchedAmount: unmatchedAmountTotal,
    overallConfidence,
    status: exceptions.length === 0 ? 'reconciled' : matches.length > 0 ? 'partially_reconciled' : 'unreconciled',
  };

  const validation = computeValidation(sourceA, sourceB, matches, exceptions);

  return { summary, matches, exceptions, duplicates, metrics, validation };
}

function findDuplicates(txns: Txn[], side: 'A' | 'B', cfg: MatchConfig): Duplicate[] {
  const dups: Duplicate[] = [];
  const sorted = [...txns].sort(byId);
  const seenRef = new Map<string, Txn[]>();
  for (const t of sorted) {
    const ref = normalizeIdentifier(t.reference);
    if (!ref) continue;
    (seenRef.get(ref) ?? seenRef.set(ref, []).get(ref)!).push(t);
  }
  const groupedIds = new Set<string>();
  for (const [, group] of seenRef) {
    if (group.length > 1) {
      dups.push({ side, ids: group.map((t) => t.id).sort(), amountCents: group[0].amountCents, confidence: 0.95, reason: 'same_reference' });
      for (const t of group) groupedIds.add(t.id);
    }
  }
  // Same amount + counterparty + date window, excluding already-grouped-by-reference records.
  const remaining = sorted.filter((t) => !groupedIds.has(t.id));
  const used = new Set<string>();
  for (let i = 0; i < remaining.length; i++) {
    if (used.has(remaining[i].id)) continue;
    const group = [remaining[i]];
    for (let j = i + 1; j < remaining.length; j++) {
      if (used.has(remaining[j].id)) continue;
      const a = remaining[i];
      const b = remaining[j];
      if (
        a.amountCents === b.amountCents &&
        (a.counterparty ?? '').toLowerCase() === (b.counterparty ?? '').toLowerCase() &&
        a.counterparty &&
        daysBetween(a.date, b.date) <= cfg.dateToleranceDays
      ) {
        group.push(b);
      }
    }
    if (group.length > 1) {
      for (const t of group) used.add(t.id);
      dups.push({ side, ids: group.map((t) => t.id).sort(), amountCents: group[0].amountCents, confidence: 0.8, reason: 'same_amount_counterparty_date_window' });
    }
  }
  return dups;
}

function computeValidation(sourceA: Txn[], sourceB: Txn[], matches: Match[], exceptions: Exception[]): Validation {
  const matchedATotal = matches.reduce((s, m) => {
    const ids = new Set(m.sourceAIds);
    return s + sourceA.filter((t) => ids.has(t.id)).reduce((ss, t) => ss + t.amountCents, 0);
  }, 0);
  const matchedBTotal = matches.reduce((s, m) => {
    const ids = new Set(m.sourceBIds);
    return s + sourceB.filter((t) => ids.has(t.id)).reduce((ss, t) => ss + t.amountCents, 0);
  }, 0);
  const varianceTotal = matches.reduce((s, m) => s + m.variance.amount, 0);
  const mathVerified = matchedATotal - matchedBTotal === varianceTotal;

  const allAIds = new Set(sourceA.map((t) => t.id));
  const allBIds = new Set(sourceB.map((t) => t.id));
  const accountedA = new Set<string>();
  const accountedB = new Set<string>();
  for (const m of matches) {
    for (const id of m.sourceAIds) accountedA.add(id);
    for (const id of m.sourceBIds) accountedB.add(id);
  }
  for (const e of exceptions) {
    if (e.side === 'A') accountedA.add(e.id);
    else accountedB.add(e.id);
  }
  const totalsVerified = allAIds.size === accountedA.size && allBIds.size === accountedB.size && [...allAIds].every((id) => accountedA.has(id)) && [...allBIds].every((id) => accountedB.has(id));

  const usedA = new Map<string, number>();
  const usedB = new Map<string, number>();
  for (const m of matches) {
    for (const id of m.sourceAIds) usedA.set(id, (usedA.get(id) ?? 0) + 1);
    for (const id of m.sourceBIds) usedB.set(id, (usedB.get(id) ?? 0) + 1);
  }
  const noDuplicateUse = [...usedA.values()].every((c) => c === 1) && [...usedB.values()].every((c) => c === 1);

  const auditTrailComplete = matches.every((m) => m.sourceAIds.length > 0 && m.sourceBIds.length > 0) && exceptions.every((e) => Boolean(e.source));

  return { mathVerified, totalsVerified, noDuplicateUse, auditTrailComplete };
}
