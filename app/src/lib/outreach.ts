import type { Account, Contact, Dossier, DraftEmail, OutreachEvent, ResearchData } from '../types';
import { eventTime } from './events';
import { compareByRating, matchesGrades, matchesLocation, inSection, type LocationFilter, type Section } from './filters';
import { type EntityActivity, type EventIndex, EMPTY_ACTIVITY, normEmail, sortContacts } from './status';
import type { Grade } from '../types';

/**
 * Outreach queues (the Outreach view):
 *  - "First touch": accounts with no outreach event at all that have at least one emailable contact.
 *  - "Follow-ups due": contacts we emailed, whose next sequence step is due (first touch → follow-up 1
 *    `gap1` days after the last send → follow-up 2 `gap2` days after follow-up 1 → sequence complete),
 *    with no reply / meeting from their account since the first email.
 * Contacts are never queued when they have no email, are flagged "likely left", carry "Do not contact" in
 * their notes, or an email to them bounced (an event snippet containing "Bounced").
 */

export const DAY_MS = 86_400_000;

/** Which email of the sequence a draft is for. */
export type DraftStep = 'first' | 'followUp' | 'followUp2';
export type QueueKind = 'first' | 'followUp';

export const STEP_LABEL: Record<DraftStep, string> = {
  first: 'First touch',
  followUp: 'Follow-up 1 of 2',
  followUp2: 'Follow-up 2 of 2',
};

export interface SequenceSettings {
  /** days after the first email before follow-up 1 is due */
  gap1: number;
  /** days after follow-up 1 before follow-up 2 is due */
  gap2: number;
}
export const DEFAULT_SEQUENCE: SequenceSettings = { gap1: 5, gap2: 7 };
export const GAP_OPTIONS: readonly number[] = [3, 5, 7, 10, 14];

/* ---------------- contact eligibility ---------------- */

export function isDoNotContact(c: Pick<Contact, 'notes'>): boolean {
  return /do not contact/i.test(c.notes ?? '');
}

/** An event about this contact says an email bounced. */
export function hasBounced(activity: EntityActivity): boolean {
  return activity.events.some((e) => /bounced/i.test(e.snippet ?? ''));
}

/** Has an email and is not flagged likely-left / do-not-contact. */
export function isEmailable(c: Contact): boolean {
  return !!normEmail(c.email) && !c.likelyLeft && !isDoNotContact(c);
}

/** Why a contact must not be emailed, or null. */
export function contactBlockReason(c: Contact, activity: EntityActivity = EMPTY_ACTIVITY): string | null {
  if (!normEmail(c.email)) return 'No email address';
  if (isDoNotContact(c)) return 'Marked “Do not contact”';
  if (c.likelyLeft) return 'Flagged as likely left the company';
  if (hasBounced(activity)) return 'An earlier email to this address bounced';
  return null;
}

/* ---------------- sequence ---------------- */

/** Email `sent` events with a valid date, oldest first. */
export function emailSends(activity: EntityActivity): OutreachEvent[] {
  return activity.events
    .filter((e) => e.kind === 'sent' && e.channel === 'email' && eventTime(e) != null)
    .sort((a, b) => (eventTime(a) ?? 0) - (eventTime(b) ?? 0));
}

/** Number of follow-ups already sent: every send after the first, or a lone send whose subject starts "Re:". */
export function followUpsSent(sends: readonly OutreachEvent[]): number {
  if (!sends.length) return 0;
  if (sends.length === 1) return /^\s*re:/i.test(sends[0]!.subject ?? '') ? 1 : 0;
  return sends.length - 1;
}

/** The next follow-up step after these sends, or null when the sequence is complete (or nothing was sent). */
export function nextFollowUpStep(sends: readonly OutreachEvent[]): 'followUp' | 'followUp2' | null {
  if (!sends.length) return null;
  const n = followUpsSent(sends);
  return n === 0 ? 'followUp' : n === 1 ? 'followUp2' : null;
}

/* ---------------- queue items ---------------- */

export interface QueueItem {
  /** stable row key */
  key: string;
  queue: QueueKind;
  step: DraftStep;
  account: Account;
  /** default recipient */
  contact: Contact;
  /** recipients the To picker offers */
  contacts: Contact[];
  dossier?: Dossier;
  /** follow-ups: emails already sent to the contact, oldest first */
  sends: OutreachEvent[];
  /** follow-ups: whole days since the last send */
  daysSince?: number;
}

export interface QueueOptions extends SequenceSettings {
  now: number;
}

/** Contact ids of this account that can be emailed now, best first. */
export function eligibleContacts(a: Account, index: EventIndex): Contact[] {
  return sortContacts(a.contacts).filter((c) => isEmailable(c) && !hasBounced(index.byContact.get(c.id) ?? EMPTY_ACTIVITY));
}

export function buildFirstTouchQueue(accounts: readonly Account[], index: EventIndex, research: ResearchData): QueueItem[] {
  const out: QueueItem[] = [];
  for (const a of accounts) {
    if ((index.byAccount.get(a.id) ?? EMPTY_ACTIVITY).events.length) continue;
    const contacts = eligibleContacts(a, index);
    if (!contacts.length) continue;
    const dossier = research[a.id];
    const draftFor = dossier?.drafts.first?.contactId;
    const contact = contacts.find((c) => c.id === draftFor) ?? contacts[0]!;
    out.push({ key: `first:${a.id}`, queue: 'first', step: 'first', account: a, contact, contacts, dossier, sends: [] });
  }
  return out;
}

export function buildFollowUpQueue(accounts: readonly Account[], index: EventIndex, research: ResearchData, opts: QueueOptions): QueueItem[] {
  const out: QueueItem[] = [];
  for (const a of accounts) {
    const accountEvents = (index.byAccount.get(a.id) ?? EMPTY_ACTIVITY).events;
    if (!accountEvents.length) continue;
    for (const c of a.contacts) {
      if (!isEmailable(c)) continue;
      const act = index.byContact.get(c.id) ?? EMPTY_ACTIVITY;
      if (hasBounced(act)) continue;
      const sends = emailSends(act);
      const step = nextFollowUpStep(sends);
      if (!step) continue;
      const first = eventTime(sends[0]!)!;
      const last = eventTime(sends[sends.length - 1]!)!;
      const gap = step === 'followUp' ? opts.gap1 : opts.gap2;
      const daysSince = Math.floor((opts.now - last) / DAY_MS);
      if (opts.now - last < gap * DAY_MS) continue;
      const answered = accountEvents.some((e) => {
        if (e.kind !== 'reply' && e.kind !== 'meeting') return false;
        const t = eventTime(e);
        return t == null || t >= first;
      });
      if (answered) continue;
      out.push({
        key: `${step}:${a.id}:${c.id}`,
        queue: 'followUp',
        step,
        account: a,
        contact: c,
        contacts: [c],
        dossier: research[a.id],
        sends,
        daysSince,
      });
    }
  }
  return out;
}

export interface QueueFilter extends LocationFilter {
  section: Section;
  grades: Grade[];
}

export function filterQueue(items: readonly QueueItem[], f: QueueFilter): QueueItem[] {
  return items.filter((i) => inSection(i, f.section) && matchesLocation(i.account, f) && matchesGrades(i.account, f.grades));
}

/** Grade / rating first, then accounts with research, then signal / fit, then the longest-waiting follow-up. */
export function compareQueueItems(x: QueueItem, y: QueueItem): number {
  const score = (i: QueueItem) => Math.max(i.account.signalScore ?? 0, i.account.fitScore ?? 0);
  return (
    compareByRating(x.account, y.account) ||
    Number(!!y.dossier) - Number(!!x.dossier) ||
    score(y) - score(x) ||
    (y.daysSince ?? 0) - (x.daysSince ?? 0) ||
    x.account.name.localeCompare(y.account.name) ||
    x.contact.name.localeCompare(y.contact.name)
  );
}

export function sortQueue(items: readonly QueueItem[]): QueueItem[] {
  return [...items].sort(compareQueueItems);
}

/** "Up next": every follow-up due, then the best `firstTouchLimit` first touches (both already sorted). */
export function upNextItems(followUps: readonly QueueItem[], firstTouches: readonly QueueItem[], firstTouchLimit = 10): QueueItem[] {
  return [...followUps, ...firstTouches.slice(0, firstTouchLimit)];
}

/* ---------------- drafts ---------------- */

export function dossierDraft(dossier: Dossier | undefined, step: DraftStep): DraftEmail | null {
  if (!dossier) return null;
  return (step === 'first' ? dossier.drafts.first : step === 'followUp' ? dossier.drafts.followUp : dossier.drafts.followUp2) ?? null;
}

/** The dossier's draft for this step when it was written for this contact. */
export function researchDraftFor(item: Pick<QueueItem, 'dossier' | 'step'>, contactId: string): DraftEmail | null {
  const d = dossierDraft(item.dossier, item.step);
  return d && d.contactId === contactId ? d : null;
}

/** Where a draft came from: the dossier, Claude (from research claims / from CRM notes), or typed by hand. */
export type DraftOrigin = 'research' | 'claude-research' | 'claude-crm' | 'manual';

export interface StoredDraft {
  subject: string;
  body: string;
  claimIds: string[];
  origin: DraftOrigin;
  /** the owner changed it after it was drafted */
  edited: boolean;
  updatedAt: string;
}
export type DraftStore = Record<string, StoredDraft>;
export const DRAFTS_KEY = 'seraos.drafts.v1';

export function draftKey(step: DraftStep, contactId: string): string {
  return `${step}:${contactId}`;
}

const ORIGINS: readonly DraftOrigin[] = ['research', 'claude-research', 'claude-crm', 'manual'];

export function validateDraftStore(raw: unknown): DraftStore {
  const out: DraftStore = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.subject !== 'string' || typeof r.body !== 'string') continue;
    out[k] = {
      subject: r.subject,
      body: r.body,
      claimIds: Array.isArray(r.claimIds) ? r.claimIds.filter((x): x is string => typeof x === 'string') : [],
      origin: ORIGINS.includes(r.origin as DraftOrigin) ? (r.origin as DraftOrigin) : 'manual',
      edited: r.edited === true,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    };
  }
  return out;
}

export interface ResolvedDraft {
  subject: string;
  body: string;
  claimIds: string[];
  origin: DraftOrigin;
  edited: boolean;
}

/** What the composer shows for an item + recipient: the stored draft (edits / Claude), else the research draft. */
export function resolveDraft(item: Pick<QueueItem, 'dossier' | 'step'>, contactId: string, store: DraftStore): ResolvedDraft | null {
  const stored = store[draftKey(item.step, contactId)];
  if (stored) return { subject: stored.subject, body: stored.body, claimIds: stored.claimIds, origin: stored.origin, edited: stored.edited };
  const d = researchDraftFor(item, contactId);
  return d ? { subject: d.subject, body: d.body, claimIds: d.claimIds, origin: 'research', edited: false } : null;
}

/** First line of the body after the greeting ("Hi Alex,"), for previews. */
export function previewLine(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const rest = /^(hi|hello|hey|dear)\b[^,]{0,40},$/i.test(first) ? lines[1] : first;
  const m = /^(hi|hello|hey|dear)\b[^,]{0,40},\s*(.+)$/i.exec(rest ?? '');
  return (m ? m[2] : rest) ?? '';
}

/* ---------------- Hostinger Mail ---------------- */

export const SENT_FOLDER = 'INBOX.Sent';
export const SENDER_ADDRESS = 'dawoud@vertfinance.tech';

/** UID of an email imported from the Hostinger Sent folder ("hostinger:INBOX.Sent:<uid>"), else null. */
export function parseHostingerSentUid(eventId: string | undefined): number | null {
  const m = /^hostinger:INBOX\.Sent:(\d+)$/.exec(eventId ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** `inReplyTo` for a follow-up: the newest earlier email that came from the Hostinger Sent folder. */
export function replyTarget(sends: readonly OutreachEvent[]): { uid: number; folder: string } | null {
  for (let i = sends.length - 1; i >= 0; i--) {
    const uid = parseHostingerSentUid(sends[i]!.id);
    if (uid != null) return { uid, folder: SENT_FOLDER };
  }
  return null;
}

function get(o: unknown, path: readonly string[]): unknown {
  let cur = o;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export interface Mailbox {
  resourceId: string;
  address?: string;
}

/**
 * Mailboxes from an `account_current` payload. Accepts {status, headers, body: {data: {mailboxes}}},
 * {data: {mailboxes}} and {mailboxes}. Prefers `preferAddress`, else the first.
 */
export function pickMailbox(payload: unknown, preferAddress = SENDER_ADDRESS): Mailbox | null {
  const candidates = [get(payload, ['body', 'data', 'mailboxes']), get(payload, ['data', 'mailboxes']), get(payload, ['mailboxes'])];
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) return null;
  const boxes: Mailbox[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (typeof r.resourceId !== 'string' || !r.resourceId) continue;
    boxes.push({ resourceId: r.resourceId, ...(typeof r.address === 'string' ? { address: r.address } : {}) });
  }
  return boxes.find((b) => b.address?.toLowerCase() === preferAddress.toLowerCase()) ?? boxes[0] ?? null;
}

export interface FoundMessage {
  from?: string;
  subject?: string;
  date?: string;
}

/** Messages from a `messages_search` payload, read defensively (several envelope shapes). */
export function searchResults(payload: unknown): FoundMessage[] {
  const candidates = [
    get(payload, ['body', 'data']),
    get(payload, ['body', 'data', 'messages']),
    get(payload, ['body', 'data', 'items']),
    get(payload, ['data']),
    get(payload, ['data', 'messages']),
    get(payload, ['data', 'items']),
    get(payload, ['messages']),
    get(payload, ['items']),
    payload,
  ];
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  const text = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      return text(r.address) ?? text(r.email) ?? text(r.name);
    }
    return undefined;
  };
  return list
    .filter((m) => !!m && typeof m === 'object')
    .map((m) => {
      const r = m as Record<string, unknown>;
      const out: FoundMessage = {};
      const from = text(r.from);
      if (from) out.from = from;
      const subject = text(r.subject);
      if (subject) out.subject = subject;
      const date = text(r.date) ?? text(r.internalDate) ?? text(r.receivedAt);
      if (date) out.date = date;
      return out;
    });
}

/** YYYY-MM-DD (UTC) of an epoch time. */
export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
