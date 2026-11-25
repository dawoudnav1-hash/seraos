import type { Account, AccountType, Contact } from '../types';
import { type EntityActivity, type EventIndex, type OutreachStatus, EMPTY_ACTIVITY, isContacted, normEmail } from './status';

export type Section = 'all' | AccountType;
export const SECTIONS: readonly Section[] = ['firm', 'services', 'internal', 'solo', 'all'];

/** Lower-case, accent-folded text for search ("Zoë" matches "zoe"). */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function queryTerms(q: string): string[] {
  return foldText(q).split(/\s+/).filter(Boolean);
}

/** Every term must appear somewhere in the haystack. */
export function matchesQuery(haystack: string, terms: readonly string[]): boolean {
  for (const t of terms) if (!haystack.includes(t)) return false;
  return true;
}

/* ---------- location (city / state) ---------- */

/** Filter value meaning "no city" / "no state" recorded. */
export const UNKNOWN = '__unknown__';
export const STATE_ORDER: readonly string[] = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

export function cityOf(a: Account): string {
  return a.city?.trim() ?? '';
}
export function stateOf(a: Account): string {
  return a.state?.trim().toUpperCase() ?? '';
}

/** Secondary location text under the city: "Richmond, VIC", "VIC", "Richmond" or '' (e.g. "Tauranga" has no state). */
export function citySubtitle(a: Account): string {
  return [a.suburb?.trim(), stateOf(a)].filter(Boolean).join(', ');
}

/** "Melbourne (Richmond, VIC)", "Tauranga", or '' when the city is unknown. */
export function cityDisplay(a: Account): string {
  const city = cityOf(a);
  if (!city) return '';
  const sub = citySubtitle(a);
  return sub ? `${city} (${sub})` : city;
}

/** Sort key for the City column: city then suburb; unknown city → undefined (always sorts last). */
export function citySortKey(a: Account): string | undefined {
  const city = cityOf(a);
  return city ? `${city} ${a.suburb?.trim() ?? ''}`.trim().toLowerCase() : undefined;
}

export interface LocationFilter {
  city: string; // '' = any, UNKNOWN = no city
  state: string; // '' = any, UNKNOWN = no state
}

export function matchesLocation(a: Account, f: LocationFilter): boolean {
  if (f.city && (cityOf(a) || UNKNOWN) !== f.city) return false;
  if (f.state && (stateOf(a) || UNKNOWN) !== f.state) return false;
  return true;
}

export interface CountedOption {
  value: string;
  count: number;
}

function countedOptions(
  accounts: readonly Account[],
  keyOf: (a: Account) => string,
  weight: (a: Account) => number,
  tieBreak: (a: string, b: string) => number,
): CountedOption[] {
  const m = new Map<string, number>();
  for (const a of accounts) {
    const k = keyOf(a) || UNKNOWN;
    m.set(k, (m.get(k) ?? 0) + weight(a));
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .filter((o) => o.count > 0)
    .sort((x, y) => {
      if ((x.value === UNKNOWN) !== (y.value === UNKNOWN)) return x.value === UNKNOWN ? 1 : -1;
      return y.count - x.count || tieBreak(x.value, y.value);
    });
}

/**
 * Every city present, most common first, unknown last. `weight` counts accounts by default (pass
 * `a => a.contacts.length` to count contacts). With `state`, only cities in that state are listed.
 */
export function cityOptions(accounts: readonly Account[], weight: (a: Account) => number = () => 1, state = ''): CountedOption[] {
  const scoped = state ? accounts.filter((a) => matchesLocation(a, { city: '', state })) : accounts;
  return countedOptions(scoped, cityOf, weight, (a, b) => a.localeCompare(b));
}

/** Every state present, most common first (canonical order on ties), "no state" last. */
export function stateOptions(accounts: readonly Account[], weight: (a: Account) => number = () => 1): CountedOption[] {
  const rank = (s: string) => (STATE_ORDER.includes(s) ? STATE_ORDER.indexOf(s) : STATE_ORDER.length);
  return countedOptions(accounts, stateOf, weight, (a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** `<select>` options for a city / state filter: "All", then "Melbourne (217)", …, "Unknown (3)". */
export function locationSelectOptions(
  opts: readonly CountedOption[],
  current: string,
  anyLabel: string,
  unknownLabel: string,
): { value: string; label: string }[] {
  const label = (v: string) => (v === UNKNOWN ? unknownLabel : v);
  const out = [{ value: '', label: anyLabel }, ...opts.map((o) => ({ value: o.value, label: `${label(o.value)} (${o.count.toLocaleString('en-AU')})` }))];
  // Keep a persisted selection visible even if the data no longer has it.
  if (current && !opts.some((o) => o.value === current)) out.push({ value: current, label: `${label(current)} (0)` });
  return out;
}

/** Changing the state clears a city that is not in that state, so the two selects never contradict each other. */
export function withState<T extends LocationFilter>(f: T, state: string, accounts: readonly Account[]): T {
  const keepCity = !f.city || !state || accounts.some((a) => matchesLocation(a, { city: f.city, state }));
  return { ...f, state, city: keepCity ? f.city : '' };
}

/* ---------- contacted / not contacted ---------- */

export type ContactedFilter = 'all' | 'not_contacted' | 'contacted';
export const CONTACTED_FILTERS: readonly ContactedFilter[] = ['all', 'not_contacted', 'contacted'];

/**
 * The quick "All · Not contacted · Contacted" toggle and the detailed Outreach status select share this state.
 * Invariant (see `normalizeOutreach`): `status` is '' or a contacted+ status, and a contacted+ status implies
 * `contacted === 'contacted'`. "Not contacted" is only ever expressed through `contacted`.
 */
export interface OutreachFilter {
  contacted: ContactedFilter;
  status: OutreachStatus | ''; // '' = any (within `contacted`)
}

export function normalizeOutreach<T extends OutreachFilter>(f: T): T {
  if (f.status === 'not_contacted') return { ...f, contacted: 'not_contacted', status: '' };
  if (f.status && f.contacted !== 'contacted') return { ...f, contacted: 'contacted' };
  return f;
}

/** Quick toggle: "Contacted" keeps a detailed contacted+ status; "All" / "Not contacted" clear it. */
export function withContacted<T extends OutreachFilter>(f: T, contacted: ContactedFilter): T {
  return { ...f, contacted, status: contacted === 'contacted' ? f.status : '' };
}

/** Detailed select: picking a status moves the toggle with it; "Any" keeps "Contacted" but leaves "Not contacted". */
export function withOutreachStatus<T extends OutreachFilter>(f: T, status: OutreachStatus | ''): T {
  if (!status) return { ...f, status: '', contacted: f.contacted === 'not_contacted' ? 'all' : f.contacted };
  return normalizeOutreach({ ...f, status });
}

/** The value the detailed Outreach select shows for the shared state. */
export function outreachSelectValue(f: OutreachFilter): OutreachStatus | '' {
  return f.contacted === 'not_contacted' ? 'not_contacted' : f.status;
}

export function matchesOutreach(status: OutreachStatus, f: OutreachFilter): boolean {
  if (f.contacted !== 'all' && isContacted(status) !== (f.contacted === 'contacted')) return false;
  if (f.status && status !== f.status) return false;
  return true;
}

/** Counts for the toggle; `rows` should already have every filter except the outreach ones applied. */
export function contactedCounts(rows: readonly { activity: EntityActivity }[]): Record<ContactedFilter, number> {
  let contacted = 0;
  for (const r of rows) if (isContacted(r.activity.status)) contacted++;
  return { all: rows.length, contacted, not_contacted: rows.length - contacted };
}

/** The same filters with the outreach part switched off (for toggle counts). */
export function withoutOutreach<T extends OutreachFilter>(f: T): T {
  return { ...f, contacted: 'all', status: '' };
}

/* ---------- accounts ---------- */

export function accountHaystack(a: Account): string {
  const parts: (string | undefined)[] = [
    a.name,
    a.domain,
    ...(a.otherDomains ?? []),
    a.website,
    a.sector,
    a.segment,
    a.signalSummary,
    a.signal,
    a.serviceSignal,
    a.description,
    a.location,
    a.city,
    a.suburb,
    a.state,
    a.cfo,
    a.whyFit,
    a.keySignals,
    a.techStack,
    a.decisionMaker,
    a.fundingStage,
    ...(a.services ?? []),
  ];
  for (const c of a.contacts) parts.push(c.name, c.email, c.title);
  return foldText(parts.filter(Boolean).join('\n'));
}

export interface AccountRow {
  account: Account;
  activity: EntityActivity;
  haystack: string;
  hasEmail: boolean;
}

export function buildAccountRows(accounts: readonly Account[], index: EventIndex): AccountRow[] {
  return accounts.map((a) => ({
    account: a,
    activity: index.byAccount.get(a.id) ?? EMPTY_ACTIVITY,
    haystack: accountHaystack(a),
    hasEmail: a.contacts.some((c) => !!normEmail(c.email)),
  }));
}

export type TriState = 'any' | 'yes' | 'no';

export interface AccountFilters extends OutreachFilter, LocationFilter {
  query: string;
  segment: string; // '' = any
  minSignal: number; // 0 = any
  hasEmail: TriState;
  inAttio: TriState;
  source: string; // '' = any
}

export const DEFAULT_ACCOUNT_FILTERS: AccountFilters = {
  query: '',
  contacted: 'all',
  city: '',
  state: '',
  segment: '',
  minSignal: 0,
  hasEmail: 'any',
  status: '',
  inAttio: 'any',
  source: '',
};

function tri(v: TriState, actual: boolean): boolean {
  return v === 'any' || (v === 'yes') === actual;
}

/** All filters except the section tab (so per-tab counts can be computed). */
export function accountMatches(row: AccountRow, f: AccountFilters, terms: readonly string[]): boolean {
  const a = row.account;
  if (f.segment && a.segment !== f.segment) return false;
  if (f.minSignal > 0 && !(typeof a.signalScore === 'number' && a.signalScore >= f.minSignal)) return false;
  if (!tri(f.hasEmail, row.hasEmail)) return false;
  if (!matchesOutreach(row.activity.status, f)) return false;
  if (!matchesLocation(a, f)) return false;
  if (!tri(f.inAttio, a.inAttio === true)) return false;
  if (f.source && !a.sources.includes(f.source)) return false;
  if (terms.length && !matchesQuery(row.haystack, terms)) return false;
  return true;
}

export function filterAccountRows(rows: readonly AccountRow[], f: AccountFilters): AccountRow[] {
  const terms = queryTerms(f.query);
  return rows.filter((r) => accountMatches(r, f, terms));
}

export function sectionCounts(rows: readonly AccountRow[]): Record<Section, number> {
  const out: Record<Section, number> = { all: rows.length, firm: 0, services: 0, internal: 0, solo: 0 };
  for (const r of rows) out[r.account.type]++;
  return out;
}

export function inSection(row: { account: Account }, s: Section): boolean {
  return s === 'all' || row.account.type === s;
}

export function activeFilterCount(f: AccountFilters | ContactFilters): number {
  let n = 0;
  for (const [k, v] of Object.entries(f)) {
    if (k === 'query') continue;
    if (v !== '' && v !== 0 && v !== 'any' && v !== 'all') n++;
  }
  return n;
}

/* ---------- generic sorting ---------- */

export type SortValue = string | number | null | undefined;
export type SortDir = 'asc' | 'desc';

/** Compares two sort values; empty values (null/undefined/'') always sort last. */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const ea = a == null || a === '' || (typeof a === 'number' && !Number.isFinite(a));
  const eb = b == null || b === '' || (typeof b === 'number' && !Number.isFinite(b));
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  let c: number;
  if (typeof a === 'number' && typeof b === 'number') c = a - b;
  else c = String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? c : -c;
}

/** Parses the first number in headcount-like text ("1,200", "51-200", "~40") for sorting. */
export function leadingNumber(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Parses money-ish text ("A$35M", "~A$6–8M", "Est. A$13.8–27.5M (basis: ~55 staff …)", "US$8M", "$500k",
 * "A$25M–50M") to a number for sorting. For a range the lower bound is used, and a unit written only after
 * the upper bound ("6–8M") applies to both ends.
 */
export function moneyValue(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = String(s)
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*([kKmMbB])?\b(?:\s*[–—-]\s*[A-Za-z]{0,3}\$?\s*\d+(?:\.\d+)?\s*([kKmMbB])?\b)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? m[3] ?? '').toLowerCase();
  return n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1);
}

/* ---------- contacts ---------- */

export interface ContactRow {
  contact: Contact;
  account: Account;
  activity: EntityActivity;
  haystack: string;
}

export function buildContactRows(accounts: readonly Account[], index: EventIndex): ContactRow[] {
  const rows: ContactRow[] = [];
  for (const a of accounts) {
    for (const c of a.contacts) {
      rows.push({
        contact: c,
        account: a,
        activity: index.byContact.get(c.id) ?? EMPTY_ACTIVITY,
        haystack: foldText(
          [c.name, c.email, c.title, c.roleType, c.location, a.name, a.domain, a.sector, a.city, a.suburb, a.state]
            .filter(Boolean)
            .join('\n'),
        ),
      });
    }
  }
  return rows;
}

export interface ContactFilters extends OutreachFilter, LocationFilter {
  query: string;
  section: Section;
  segment: string;
  emailRisk: '' | 'ok' | 'caution' | 'none';
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  query: '',
  section: 'all',
  contacted: 'all',
  city: '',
  state: '',
  segment: '',
  emailRisk: '',
  status: '',
};

export function filterContactRows(rows: readonly ContactRow[], f: ContactFilters): ContactRow[] {
  const terms = queryTerms(f.query);
  return rows.filter((r) => {
    if (!inSection(r, f.section)) return false;
    if (f.segment && r.account.segment !== f.segment) return false;
    if (f.emailRisk && (r.contact.emailRisk ?? (r.contact.email ? 'ok' : 'none')) !== f.emailRisk) return false;
    if (!matchesOutreach(r.activity.status, f)) return false;
    if (!matchesLocation(r.account, f)) return false;
    if (terms.length && !matchesQuery(r.haystack, terms)) return false;
    return true;
  });
}

/** Section tabs worth showing: 'all' plus every type that has at least one account. */
export function visibleSections(accounts: readonly { type: string }[]): Section[] {
  const present = new Set(accounts.map((a) => a.type));
  return SECTIONS.filter((s) => s === 'all' || present.has(s));
}
