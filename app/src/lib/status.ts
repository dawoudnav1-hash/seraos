import type { Account, Contact, OutreachEvent } from '../types';
import { compareEventsDesc, eventTime, isSeenEvent } from './events';

/** Derived outreach status, in ascending precedence. */
export type OutreachStatus = 'not_contacted' | 'contacted' | 'seen' | 'replied' | 'meeting';

export const STATUS_ORDER: readonly OutreachStatus[] = ['not_contacted', 'contacted', 'seen', 'replied', 'meeting'];
export const STATUS_LABEL: Record<OutreachStatus, string> = {
  not_contacted: 'Not contacted',
  contacted: 'Contacted',
  seen: 'Seen',
  replied: 'Replied',
  meeting: 'Meeting',
};

export function statusRank(s: OutreachStatus): number {
  return STATUS_ORDER.indexOf(s);
}

/** "Contacted" in the broad sense: any matched event (sent, connection, seen, replied, meeting). */
export function isContacted(s: OutreachStatus): boolean {
  return s !== 'not_contacted';
}

/** The status a single event implies on its own. */
export function eventStatus(e: OutreachEvent): OutreachStatus {
  if (e.kind === 'meeting') return 'meeting';
  if (e.kind === 'reply') return 'replied';
  if (isSeenEvent(e)) return 'seen';
  // sent / message_sent / connection_sent / connection_accepted all mean we reached out.
  return 'contacted';
}

/** Highest-precedence status across events: Meeting > Replied > Seen > Contacted > Not contacted. */
export function deriveStatus(events: readonly OutreachEvent[]): OutreachStatus {
  let best = 0;
  for (const e of events) {
    const r = statusRank(eventStatus(e));
    if (r > best) best = r;
    if (best === STATUS_ORDER.length - 1) break;
  }
  return STATUS_ORDER[best] ?? 'not_contacted';
}

export function normEmail(e: unknown): string {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

export interface EntityActivity {
  events: OutreachEvent[]; // newest first
  status: OutreachStatus;
  lastTouch: number | null; // epoch ms of newest dated event
}

export const EMPTY_ACTIVITY: EntityActivity = Object.freeze({
  events: [],
  status: 'not_contacted',
  lastTouch: null,
}) as EntityActivity;

export interface EventIndex {
  byContact: Map<string, EntityActivity>;
  byAccount: Map<string, EntityActivity>;
  /** event id → ids of contacts it belongs to */
  eventContacts: Map<string, string[]>;
  /** event id → ids of (known) accounts it belongs to */
  eventAccounts: Map<string, string[]>;
  contactById: Map<string, Contact>;
  accountById: Map<string, Account>;
  contactAccount: Map<string, string>;
  /** events that matched neither a known account nor a known contact */
  unmatched: OutreachEvent[];
}

/**
 * Resolves which contacts / accounts every event belongs to.
 *  - Contact: `contactId` matches a known contact; otherwise any `counterpartyEmails` entry equals a
 *    contact's email (case-insensitive). An email shared by several contacts matches all of them.
 *  - Account: `accountId` matches a known account, plus the account of every matched contact.
 */
export function buildEventIndex(accounts: readonly Account[], events: readonly OutreachEvent[]): EventIndex {
  const contactById = new Map<string, Contact>();
  const accountById = new Map<string, Account>();
  const contactAccount = new Map<string, string>();
  const contactsByEmail = new Map<string, string[]>();

  for (const a of accounts) {
    if (!accountById.has(a.id)) accountById.set(a.id, a);
    for (const c of a.contacts) {
      if (contactById.has(c.id)) continue;
      contactById.set(c.id, c);
      contactAccount.set(c.id, a.id);
      const em = normEmail(c.email);
      if (em) {
        const list = contactsByEmail.get(em);
        if (list) list.push(c.id);
        else contactsByEmail.set(em, [c.id]);
      }
    }
  }

  const contactEvents = new Map<string, OutreachEvent[]>();
  const accountEvents = new Map<string, OutreachEvent[]>();
  const eventContacts = new Map<string, string[]>();
  const eventAccounts = new Map<string, string[]>();
  const unmatched: OutreachEvent[] = [];

  const push = (m: Map<string, OutreachEvent[]>, k: string, e: OutreachEvent) => {
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };

  for (const e of events) {
    let cids: string[] = [];
    if (e.contactId && contactById.has(e.contactId)) {
      cids = [e.contactId];
    } else if (e.counterpartyEmails && e.counterpartyEmails.length) {
      const set = new Set<string>();
      for (const em of e.counterpartyEmails) {
        for (const id of contactsByEmail.get(normEmail(em)) ?? []) set.add(id);
      }
      cids = [...set];
    }
    const aids = new Set<string>();
    if (e.accountId && accountById.has(e.accountId)) aids.add(e.accountId);
    for (const cid of cids) {
      const aid = contactAccount.get(cid);
      if (aid) aids.add(aid);
    }
    eventContacts.set(e.id, cids);
    eventAccounts.set(e.id, [...aids]);
    for (const cid of cids) push(contactEvents, cid, e);
    for (const aid of aids) push(accountEvents, aid, e);
    if (!cids.length && !aids.size) unmatched.push(e);
  }

  const toActivity = (m: Map<string, OutreachEvent[]>) => {
    const out = new Map<string, EntityActivity>();
    for (const [k, evs] of m) {
      evs.sort(compareEventsDesc);
      let last: number | null = null;
      for (const ev of evs) {
        const t = eventTime(ev);
        if (t != null && (last == null || t > last)) last = t;
      }
      out.set(k, { events: evs, status: deriveStatus(evs), lastTouch: last });
    }
    return out;
  };

  return {
    byContact: toActivity(contactEvents),
    byAccount: toActivity(accountEvents),
    eventContacts,
    eventAccounts,
    contactById,
    accountById,
    contactAccount,
    unmatched,
  };
}

export function accountActivity(index: EventIndex, accountId: string): EntityActivity {
  return index.byAccount.get(accountId) ?? EMPTY_ACTIVITY;
}
export function contactActivity(index: EventIndex, contactId: string): EntityActivity {
  return index.byContact.get(contactId) ?? EMPTY_ACTIVITY;
}

/** Primary / finance first, likely-left last, then by name. */
export function sortContacts(contacts: readonly Contact[]): Contact[] {
  const score = (c: Contact) =>
    (c.likelyLeft ? 100 : 0) + (c.isPrimary ? 0 : 10) + ((c.roleType ?? '').toLowerCase() === 'finance' ? 0 : 1);
  return contacts
    .map((c, i) => ({ c, i }))
    .sort((x, y) => score(x.c) - score(y.c) || (x.c.name ?? '').localeCompare(y.c.name ?? '') || x.i - y.i)
    .map((x) => x.c);
}
