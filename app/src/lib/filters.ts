import type { Account, AccountType, Contact } from '../types';
import { type EntityActivity, type EventIndex, type OutreachStatus, EMPTY_ACTIVITY, normEmail } from './status';

export type Section = 'all' | AccountType;
export const SECTIONS: readonly Section[] = ['firm', 'internal', 'solo', 'all'];

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

export interface AccountFilters {
  query: string;
  segment: string; // '' = any
  minSignal: number; // 0 = any
  hasEmail: TriState;
  status: OutreachStatus | ''; // '' = any
  inAttio: TriState;
  source: string; // '' = any
}

export const DEFAULT_ACCOUNT_FILTERS: AccountFilters = {
  query: '',
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
  if (f.status && row.activity.status !== f.status) return false;
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
  const out: Record<Section, number> = { all: rows.length, firm: 0, internal: 0, solo: 0 };
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

/** Parses money-ish text ("A$35M", "~A$6–8M", "US$8M", "$500k", "A$25M–50M") to a number for sorting. */
export function moneyValue(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kKmMbB])?/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
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
          [c.name, c.email, c.title, c.roleType, c.location, a.name, a.domain, a.sector].filter(Boolean).join('\n'),
        ),
      });
    }
  }
  return rows;
}

export interface ContactFilters {
  query: string;
  section: Section;
  segment: string;
  emailRisk: '' | 'ok' | 'caution' | 'none';
  status: OutreachStatus | '';
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  query: '',
  section: 'all',
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
    if (f.status && r.activity.status !== f.status) return false;
    if (terms.length && !matchesQuery(r.haystack, terms)) return false;
    return true;
  });
}
