import type { Account, AccountType, OutreachEvent } from '../types';
import {
  type Channel,
  type DateRange,
  CHANNELS,
  compareEventsDesc,
  eventTime,
  filterByRange,
  isSeenEvent,
  isSentEvent,
  rangeStart,
} from './events';
import { type EventIndex, buildEventIndex, normEmail, statusRank } from './status';

/** a / b, or null when the denominator is 0 (rendered as "—"). */
export function safeRate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Stable key for "who" an event is with, used for unique-people counts:
 * matched contact → first counterparty email → person name → the event itself.
 */
export function recipientKey(e: OutreachEvent, index: EventIndex): string {
  const cids = index.eventContacts.get(e.id);
  if (cids && cids.length) return 'c:' + [...cids].sort()[0];
  const em = e.counterpartyEmails?.map(normEmail).find(Boolean);
  if (em) return 'e:' + em;
  const name = e.personName?.trim().toLowerCase();
  if (name) return 'n:' + name;
  return 'ev:' + e.id;
}

export interface Tally {
  /** Messages sent = sent + message_sent + connection_sent */
  sent: number;
  /** Seen = opened + message_seen + any event with seenFlag === true */
  seen: number;
  /** reply events */
  replies: number;
  /** unique people messaged (denominator of reply rate) */
  messagedPeople: number;
  /** unique people who replied */
  repliedPeople: number;
  /** repliedPeople / messagedPeople, null when nobody was messaged */
  replyRate: number | null;
  connectionsSent: number;
  connectionsAccepted: number;
  meetings: number;
}

export function tally(events: readonly OutreachEvent[], index: EventIndex): Tally {
  let sent = 0,
    seen = 0,
    replies = 0,
    connectionsSent = 0,
    connectionsAccepted = 0,
    meetings = 0;
  const messaged = new Set<string>();
  const replied = new Set<string>();
  for (const e of events) {
    if (isSentEvent(e)) {
      sent++;
      messaged.add(recipientKey(e, index));
    }
    if (isSeenEvent(e)) seen++;
    if (e.kind === 'reply') {
      replies++;
      replied.add(recipientKey(e, index));
    }
    if (e.kind === 'connection_sent') connectionsSent++;
    if (e.kind === 'connection_accepted') connectionsAccepted++;
    if (e.kind === 'meeting') meetings++;
  }
  return {
    sent,
    seen,
    replies,
    messagedPeople: messaged.size,
    repliedPeople: replied.size,
    replyRate: safeRate(replied.size, messaged.size),
    connectionsSent,
    connectionsAccepted,
    meetings,
  };
}

export interface ChannelRow extends Tally {
  channel: Channel;
}

export interface BreakdownRow extends Tally {
  key: string;
  label: string;
  accounts: number;
  contacts: number;
  accountsTouched: number;
}

export interface WeekBucket {
  /** epoch ms of Monday 00:00 UTC */
  weekStart: number;
  sentEmail: number;
  sentLinkedin: number;
  repliesEmail: number;
  repliesLinkedin: number;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
}

export interface Coverage {
  totalContacts: number;
  withEmail: number;
  withVerifiedEmail: number;
  withCautionEmail: number;
  withLinkedin: number;
  likelyLeft: number;
  totalAccounts: number;
  accountsWithoutContacts: number;
  accountsWithoutEmail: number;
}

export interface DashboardStats extends Tally {
  range: DateRange;
  eventsInRange: number;
  sentEmail: number;
  sentLinkedin: number;
  /** false when NO event in the whole dataset carries seen/open information */
  hasSeenTracking: boolean;
  accountsTouched: number;
  totalAccounts: number;
  contactsReached: number;
  totalContacts: number;
  unmatchedEvents: number;
  undatedEvents: number;
  channels: ChannelRow[];
  byType: BreakdownRow[];
  bySegment: BreakdownRow[];
  funnel: FunnelStage[];
  weekly: WeekBucket[];
  recent: OutreachEvent[];
  coverage: Coverage;
  index: EventIndex;
}

export const TYPE_LABEL: Record<AccountType, string> = {
  firm: 'Accounting & advisory firms',
  internal: 'Internal finance teams',
  solo: '1-person',
};
export const TYPE_ORDER: readonly AccountType[] = ['firm', 'internal', 'solo'];

export const SEGMENT_ORDER: readonly string[] = [
  'Accounting & advisory',
  'SaaS',
  'CPG / Ecom / D2C',
  'AI startup',
  'VC / Accelerator',
  'Other',
];

/** Canonical segment order first, then any unknown segments alphabetically, blank last. */
export function compareSegments(a: string, b: string): number {
  const ia = SEGMENT_ORDER.indexOf(a);
  const ib = SEGMENT_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export function segmentOf(a: Account): string {
  return typeof a.segment === 'string' && a.segment.trim() ? a.segment.trim() : 'Unclassified';
}

const DAY = 86_400_000;
/** Monday 00:00 UTC of the week containing t. */
export function weekStartUTC(t: number): number {
  const d = new Date(t);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - diff * DAY;
}

export const MAX_WEEKS = 52;

export function weeklySeries(events: readonly OutreachEvent[], range: DateRange, now: number): WeekBucket[] {
  const times: number[] = [];
  for (const e of events) {
    const t = eventTime(e);
    if (t != null) times.push(t);
  }
  const start = rangeStart(range, now);
  if (!times.length && start == null) return [];
  let first = start != null ? weekStartUTC(start) : weekStartUTC(Math.min(...times));
  const last = weekStartUTC(Math.max(now, ...times));
  if ((last - first) / (7 * DAY) + 1 > MAX_WEEKS) first = last - (MAX_WEEKS - 1) * 7 * DAY;
  const buckets = new Map<number, WeekBucket>();
  for (let w = first; w <= last; w += 7 * DAY) {
    buckets.set(w, { weekStart: w, sentEmail: 0, sentLinkedin: 0, repliesEmail: 0, repliesLinkedin: 0 });
  }
  for (const e of events) {
    const t = eventTime(e);
    if (t == null) continue;
    const b = buckets.get(weekStartUTC(t));
    if (!b) continue;
    if (isSentEvent(e)) {
      if (e.channel === 'linkedin') b.sentLinkedin++;
      else b.sentEmail++;
    } else if (e.kind === 'reply') {
      if (e.channel === 'linkedin') b.repliesLinkedin++;
      else b.repliesEmail++;
    }
  }
  return [...buckets.values()];
}

export function computeCoverage(accounts: readonly Account[]): Coverage {
  let totalContacts = 0,
    withEmail = 0,
    withVerifiedEmail = 0,
    withCautionEmail = 0,
    withLinkedin = 0,
    likelyLeft = 0,
    accountsWithoutContacts = 0,
    accountsWithoutEmail = 0;
  for (const a of accounts) {
    if (!a.contacts.length) accountsWithoutContacts++;
    let anyEmail = false;
    for (const c of a.contacts) {
      totalContacts++;
      const hasEmail = !!normEmail(c.email);
      if (hasEmail) {
        withEmail++;
        anyEmail = true;
        if (c.emailRisk === 'ok') withVerifiedEmail++;
        else if (c.emailRisk === 'caution') withCautionEmail++;
      }
      if (typeof c.linkedin === 'string' && c.linkedin.trim()) withLinkedin++;
      if (c.likelyLeft) likelyLeft++;
    }
    if (!anyEmail) accountsWithoutEmail++;
  }
  return {
    totalContacts,
    withEmail,
    withVerifiedEmail,
    withCautionEmail,
    withLinkedin,
    likelyLeft,
    totalAccounts: accounts.length,
    accountsWithoutContacts,
    accountsWithoutEmail,
  };
}

function breakdown(
  accounts: readonly Account[],
  events: readonly OutreachEvent[],
  index: EventIndex,
  keyOf: (a: Account) => string,
  labelOf: (k: string) => string,
  order: (a: string, b: string) => number,
): BreakdownRow[] {
  const groups = new Map<string, { accounts: Account[]; accountIds: Set<string> }>();
  for (const a of accounts) {
    const k = keyOf(a);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { accounts: [], accountIds: new Set() }));
    g.accounts.push(a);
    g.accountIds.add(a.id);
  }
  const rows: BreakdownRow[] = [];
  for (const [k, g] of groups) {
    const evs = events.filter((e) => (index.eventAccounts.get(e.id) ?? []).some((id) => g.accountIds.has(id)));
    let touched = 0;
    let contacts = 0;
    for (const a of g.accounts) {
      contacts += a.contacts.length;
      if (index.byAccount.has(a.id)) touched++;
    }
    rows.push({ key: k, label: labelOf(k), accounts: g.accounts.length, contacts, accountsTouched: touched, ...tally(evs, index) });
  }
  return rows.sort((a, b) => order(a.key, b.key));
}

export interface StatsInput {
  accounts: readonly Account[];
  /** merged (generated + manual), already de-duplicated */
  events: readonly OutreachEvent[];
  range: DateRange;
  now: number;
  recentLimit?: number;
}

export function computeDashboardStats({ accounts, events, range, now, recentLimit = 25 }: StatsInput): DashboardStats {
  const inRange = filterByRange(events, range, now);
  const index = buildEventIndex(accounts, inRange);
  const t = tally(inRange, index);

  let sentEmail = 0,
    sentLinkedin = 0,
    undated = 0;
  for (const e of inRange) {
    if (isSentEvent(e)) {
      if (e.channel === 'linkedin') sentLinkedin++;
      else sentEmail++;
    }
    if (eventTime(e) == null) undated++;
  }

  const channels: ChannelRow[] = CHANNELS.map((ch) => ({
    channel: ch,
    ...tally(
      inRange.filter((e) => e.channel === ch),
      index,
    ),
  }));

  const totalContacts = index.contactById.size;
  let reached = 0;
  const stageCounts = [0, 0, 0, 0]; // contacted+, seen+, replied+, meeting
  for (const [, act] of index.byContact) {
    reached++;
    const r = statusRank(act.status);
    for (let i = 0; i < 4; i++) if (r >= i + 1) stageCounts[i]!++;
  }

  const funnel: FunnelStage[] = [
    { key: 'contacts', label: 'Contacts', count: totalContacts },
    { key: 'messaged', label: 'Messaged', count: stageCounts[0]! },
    { key: 'seen', label: 'Seen', count: stageCounts[1]! },
    { key: 'replied', label: 'Replied', count: stageCounts[2]! },
    { key: 'meeting', label: 'Meeting', count: stageCounts[3]! },
  ];

  const typeKey = (a: Account) => (TYPE_ORDER.includes(a.type) ? a.type : 'other');
  const byType = breakdown(
    accounts,
    inRange,
    index,
    typeKey,
    (k) => TYPE_LABEL[k as AccountType] ?? 'Other',
    (a, b) => {
      const ia = TYPE_ORDER.indexOf(a as AccountType);
      const ib = TYPE_ORDER.indexOf(b as AccountType);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    },
  );
  const bySegment = breakdown(accounts, inRange, index, segmentOf, (k) => k, compareSegments);

  return {
    ...t,
    range,
    eventsInRange: inRange.length,
    sentEmail,
    sentLinkedin,
    hasSeenTracking: events.some(isSeenEvent),
    accountsTouched: index.byAccount.size,
    totalAccounts: index.accountById.size,
    contactsReached: reached,
    totalContacts,
    unmatchedEvents: index.unmatched.length,
    undatedEvents: undated,
    channels,
    byType,
    bySegment,
    funnel,
    weekly: weeklySeries(inRange, range, now),
    recent: inRange.slice().sort(compareEventsDesc).slice(0, recentLimit),
    coverage: computeCoverage(accounts),
    index,
  };
}
