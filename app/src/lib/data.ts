import type { Account, AccountType, Contact, OutreachEvent, SourceNote } from '../types';
import { sanitizeEvents } from './events';

/**
 * Defensive normalisation of the generated JSON. The pipeline is supposed to match
 * DATA_CONTRACT.md, but the UI must never crash if a field is missing or mistyped.
 */

const TYPES: readonly AccountType[] = ['firm', 'internal', 'solo'];

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? v : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}
function num(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const ACCOUNT_STRING_FIELDS = [
  'domain',
  'website',
  'linkedin',
  'logoUrl',
  'sector',
  'description',
  'location',
  'employees',
  'employeeRange',
  'headcountBasis',
  'revenue',
  'arr',
  'funding',
  'valuation',
  'founded',
  'signalSummary',
  'signal',
  'serviceSignal',
  'fitConfidence',
  'growth',
  'icpStatus',
  'flags',
  'notes',
  'cfo',
  'financeTeam',
  'founder',
  'attioId',
] as const;

const CONTACT_STRING_FIELDS = [
  'title',
  'roleType',
  'email',
  'emailStatus',
  'linkedin',
  'location',
  'inRoleSince',
  'priority',
  'notes',
] as const;

export function normalizeContact(raw: unknown, fallbackId: string): Contact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.email) ?? 'Unnamed contact';
  const c: Contact = {
    id: str(r.id) ?? fallbackId,
    name,
    sources: strArr(r.sources),
    inAttio: r.inAttio === true,
  };
  for (const f of CONTACT_STRING_FIELDS) {
    const v = str(r[f]);
    if (v !== undefined) c[f] = v;
  }
  if (r.emailRisk === 'ok' || r.emailRisk === 'caution' || r.emailRisk === 'none') c.emailRisk = r.emailRisk;
  else c.emailRisk = c.email ? 'ok' : 'none';
  if (r.isPrimary === true) c.isPrimary = true;
  if (r.likelyLeft === true) c.likelyLeft = true;
  return c;
}

export function normalizeAccounts(raw: unknown): { accounts: Account[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('accounts.json is not an array — no accounts loaded.');
    return { accounts: [], warnings };
  }
  const accounts: Account[] = [];
  const accountIds = new Set<string>();
  const contactIds = new Set<string>();
  let dupAccounts = 0,
    dupContacts = 0,
    invalid = 0;
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      invalid++;
      return;
    }
    const r = item as Record<string, unknown>;
    const id = str(r.id) ?? `account-${i}`;
    if (accountIds.has(id)) {
      dupAccounts++;
      return;
    }
    accountIds.add(id);
    const type = TYPES.includes(r.type as AccountType) ? (r.type as AccountType) : 'internal';
    const a: Account = {
      id,
      name: str(r.name) ?? str(r.domain) ?? id,
      type,
      typeReason: str(r.typeReason) ?? '',
      segment: str(r.segment) ?? 'Other',
      inAttio: r.inAttio === true,
      sources: strArr(r.sources),
      contacts: [],
    };
    for (const f of ACCOUNT_STRING_FIELDS) {
      const v = str(r[f]);
      if (v !== undefined) a[f] = v;
    }
    const fh = num(r.financeHeadcount);
    if (fh !== undefined) a.financeHeadcount = fh;
    const ss = num(r.signalScore);
    if (ss !== undefined) a.signalScore = ss == null ? null : Math.max(1, Math.min(5, Math.round(ss)));
    const od = strArr(r.otherDomains);
    if (od.length) a.otherDomains = od;
    const oa = strArr(r.otherAttioIds);
    if (oa.length) a.otherAttioIds = oa;
    const rawContacts = Array.isArray(r.contacts) ? r.contacts : [];
    rawContacts.forEach((rc, j) => {
      const c = normalizeContact(rc, `${id}--contact-${j}`);
      if (!c) return;
      if (contactIds.has(c.id)) {
        dupContacts++;
        return;
      }
      contactIds.add(c.id);
      a.contacts.push(c);
    });
    accounts.push(a);
  });
  if (dupAccounts) warnings.push(`${dupAccounts} duplicate account id(s) ignored.`);
  if (dupContacts) warnings.push(`${dupContacts} duplicate contact id(s) ignored.`);
  if (invalid) warnings.push(`${invalid} malformed account record(s) ignored.`);
  return { accounts, warnings };
}

export interface OutreachData {
  generatedAt?: string;
  sources: SourceNote[];
  events: OutreachEvent[];
}

export function normalizeOutreach(raw: unknown): { outreach: OutreachData; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { outreach: { sources: [], events: [] }, warnings: ['outreach.json is missing or invalid — no events loaded.'] };
  }
  const r = raw as Record<string, unknown>;
  const rawEvents = Array.isArray(r.events) ? r.events : [];
  const events = sanitizeEvents(rawEvents);
  if (events.length < rawEvents.length) warnings.push(`${rawEvents.length - events.length} malformed outreach event(s) ignored.`);
  const sources: SourceNote[] = Array.isArray(r.sources)
    ? r.sources
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({ name: str(s.name) ?? 'Source', detail: str(s.detail) ?? '' }))
    : [];
  return { outreach: { generatedAt: str(r.generatedAt), sources, events }, warnings };
}

/** Parses a JSON string, returning undefined (never throwing) when invalid. */
export function parseJSONSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
