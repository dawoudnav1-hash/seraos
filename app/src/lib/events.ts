import type { OutreachEvent } from '../types';

export type EventKind = OutreachEvent['kind'];
export type Channel = OutreachEvent['channel'];

export const EVENT_KINDS: readonly EventKind[] = [
  'sent',
  'reply',
  'opened',
  'connection_sent',
  'connection_accepted',
  'message_sent',
  'message_seen',
  'meeting',
];
export const CHANNELS: readonly Channel[] = ['email', 'linkedin'];

/** Kinds that count as "Messages sent" (DATA_CONTRACT.md, Kind semantics). */
export const SENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['sent', 'message_sent', 'connection_sent']);
/** Kinds that count as "Seen" (plus any event whose seenFlag === true). */
export const SEEN_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['opened', 'message_seen']);

export const KIND_LABEL: Record<EventKind, string> = {
  sent: 'Email sent',
  reply: 'Replied',
  opened: 'Opened',
  connection_sent: 'Connection request sent',
  connection_accepted: 'Connection accepted',
  message_sent: 'LinkedIn message sent',
  message_seen: 'LinkedIn message seen',
  meeting: 'Meeting',
};

export function kindLabel(e: Pick<OutreachEvent, 'kind' | 'channel'>): string {
  if (e.kind === 'sent' && e.channel === 'linkedin') return 'LinkedIn message sent';
  if (e.kind === 'reply') return e.channel === 'linkedin' ? 'LinkedIn reply' : 'Email reply';
  return KIND_LABEL[e.kind] ?? String(e.kind);
}

export function isSentEvent(e: OutreachEvent): boolean {
  return SENT_KINDS.has(e.kind);
}
export function isSeenEvent(e: OutreachEvent): boolean {
  return SEEN_KINDS.has(e.kind) || e.seenFlag === true;
}

/** Epoch ms of an event date, or null when missing / unparseable. */
export function eventTime(e: Pick<OutreachEvent, 'date'>): number | null {
  if (typeof e.date !== 'string' || !e.date) return null;
  const t = Date.parse(e.date);
  return Number.isFinite(t) ? t : null;
}

/** Newest first; events without a valid date go last; ties broken by id for stable order. */
export function compareEventsDesc(a: OutreachEvent, b: OutreachEvent): number {
  const ta = eventTime(a);
  const tb = eventTime(b);
  if (ta !== tb) {
    if (ta == null) return 1;
    if (tb == null) return -1;
    return tb - ta;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validates one raw event. Returns a clean OutreachEvent or null when the shape is unusable
 * (missing id, unknown kind/channel). Unknown extra fields are dropped.
 */
export function sanitizeEvent(raw: unknown): OutreachEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  if (typeof r.date !== 'string') return null;
  if (!CHANNELS.includes(r.channel as Channel)) return null;
  if (!EVENT_KINDS.includes(r.kind as EventKind)) return null;
  const ev: OutreachEvent = {
    id: r.id,
    date: r.date,
    channel: r.channel as Channel,
    kind: r.kind as EventKind,
    source: typeof r.source === 'string' && r.source ? r.source : 'unknown',
  };
  if (typeof r.accountId === 'string' && r.accountId) ev.accountId = r.accountId;
  if (typeof r.contactId === 'string' && r.contactId) ev.contactId = r.contactId;
  if (isStringArray(r.counterpartyEmails)) ev.counterpartyEmails = r.counterpartyEmails.filter(Boolean);
  if (typeof r.personName === 'string' && r.personName) ev.personName = r.personName;
  if (typeof r.subject === 'string' && r.subject) ev.subject = r.subject;
  if (typeof r.snippet === 'string' && r.snippet) ev.snippet = r.snippet;
  if (typeof r.seenFlag === 'boolean' || r.seenFlag === null) ev.seenFlag = r.seenFlag as boolean | null;
  return ev;
}

export function sanitizeEvents(raw: unknown): OutreachEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: OutreachEvent[] = [];
  for (const r of raw) {
    const e = sanitizeEvent(r);
    if (e) out.push(e);
  }
  return out;
}

/** Removes duplicate ids, keeping the first occurrence. */
export function dedupeById(events: readonly OutreachEvent[]): OutreachEvent[] {
  const seen = new Set<string>();
  const out: OutreachEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Source of an email sent from the Outreach page (stored with the manual events). */
export const PAGE_SEND_SOURCE = 'page-send';

/** Sources a locally stored (manual) event may carry. Anything else is stored as 'manual'. */
export function manualSource(source: unknown): 'manual' | typeof PAGE_SEND_SOURCE {
  return source === PAGE_SEND_SOURCE ? PAGE_SEND_SOURCE : 'manual';
}

/** True for events that live in this browser (logged by hand or sent from the page) and can be deleted. */
export function isManualEvent(e: Pick<OutreachEvent, 'source'>): boolean {
  return e.source === 'manual' || e.source === PAGE_SEND_SOURCE;
}

const DEDUPE_WINDOW_MS = 48 * 3_600_000;
const normSubject = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/**
 * A 'page-send' event duplicates an imported one when the pipeline later picks the same email up from the
 * mailbox: a generated `sent` event with a shared counterparty email (case-insensitive), the same subject
 * (trimmed, case-insensitive) and a date within 48 hours.
 */
export function isDuplicatePageSend(e: OutreachEvent, generated: readonly OutreachEvent[]): boolean {
  if (e.source !== PAGE_SEND_SOURCE || e.kind !== 'sent') return false;
  const t = eventTime(e);
  const emails = new Set((e.counterpartyEmails ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (t == null || !emails.size) return false;
  const subj = normSubject(e.subject);
  return generated.some((g) => {
    if (g.kind !== 'sent' || normSubject(g.subject) !== subj) return false;
    const tg = eventTime(g);
    if (tg == null || Math.abs(tg - t) > DEDUPE_WINDOW_MS) return false;
    return (g.counterpartyEmails ?? []).some((x) => emails.has(x.trim().toLowerCase()));
  });
}

/**
 * Generated + manual events, de-duplicated by id. Generated events win on id collisions
 * (a manual event can never shadow pipeline data). Emails sent from the page are dropped once the
 * pipeline has imported the same email from the mailbox (see `isDuplicatePageSend`).
 */
export function mergeEvents(generated: readonly OutreachEvent[], manual: readonly OutreachEvent[]): OutreachEvent[] {
  const sentGenerated = generated.filter((g) => g.kind === 'sent');
  const kept = sentGenerated.length ? manual.filter((m) => !isDuplicatePageSend(m, sentGenerated)) : manual;
  return dedupeById([...generated, ...kept]);
}

export type DateRange = '7d' | '30d' | '90d' | 'all';
export const DATE_RANGES: readonly { id: DateRange; label: string; days: number | null }[] = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];
const DAY = 86_400_000;

/** Inclusive lower bound (epoch ms) of a range relative to `now`, or null for "all". */
export function rangeStart(range: DateRange, now: number): number | null {
  const r = DATE_RANGES.find((x) => x.id === range);
  if (!r || r.days == null) return null;
  return now - r.days * DAY;
}

/**
 * Keeps events with start <= date (inclusive). There is no upper bound, so events dated slightly
 * in the future (clock skew) are never silently dropped. With "all", every event is kept, including
 * ones with an unparseable date; with a bounded range those are excluded (their date is unknown).
 */
export function filterByRange(events: readonly OutreachEvent[], range: DateRange, now: number): OutreachEvent[] {
  const start = rangeStart(range, now);
  if (start == null) return events.slice();
  return events.filter((e) => {
    const t = eventTime(e);
    return t != null && t >= start;
  });
}

let counter = 0;
export function newManualId(now = Date.now()): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `manual:${now.toString(36)}-${counter.toString(36)}-${rand}`;
}

/**
 * Parses an import file: either an array of events or an object with an `events` array.
 * Returns valid events and the number of rejected entries.
 */
export function parseImport(text: string): { events: OutreachEvent[]; rejected: number; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { events: [], rejected: 0, error: 'File is not valid JSON.' };
  }
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { events?: unknown }).events)
      ? (data as { events: unknown[] }).events
      : null;
  if (!arr) return { events: [], rejected: 0, error: 'Expected an array of events or an object with an "events" array.' };
  const events: OutreachEvent[] = [];
  let rejected = 0;
  for (const r of arr) {
    const e = sanitizeEvent(r);
    if (e && eventTime(e) != null) events.push({ ...e, source: manualSource(e.source) });
    else rejected++;
  }
  return { events, rejected };
}
