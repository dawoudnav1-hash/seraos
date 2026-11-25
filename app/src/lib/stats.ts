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
import { UNKNOWN, cityOf } from './filters';
import { type EventIndex, accountActivity, buildEventIndex, isContacted, normEmail, statusRank } from './status';

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
  /** unique people who replied AND were messaged in the same set of events (numerator of the reply rate) */
  repliedMessagedPeople: number;
  /** repliedMessagedPeople / messagedPeople (so never above 100%), null when nobody was messaged */
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
  // A reply from someone with no tracked outbound message (e.g. LinkedIn sends aren't importable) must not
  // push the rate above 100% or make "X of Y people messaged" untrue, so only count repliers we also messaged.
  let repliedMessaged = 0;
  for (const k of replied) if (messaged.has(k)) repliedMessaged++;
  return {
    sent,
    seen,
    replies,
    messagedPeople: messaged.size,
    repliedPeople: replied.size,
    repliedMessagedPeople: repliedMessaged,
    replyRate: safeRate(repliedMessaged, messaged.size),
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
  /** accounts with at least one event in the selected range */
  accountsTouched: number;
  /** accounts whose derived status is not "Not contacted", over ALL time (ignores the range) */
  accountsContacted: number;
  /** accounts - accountsContacted (all time) — the same number the Accounts view shows */
  accountsNotContacted: number;
}

/** A row of the dashboard "By city" table. */
export interface CityRow extends Tally {
  /** a city name, OTHER_CITIES, UNKNOWN, or TOTAL */
  key: string;
  label: string;
  /** the cities this row aggregates (one for a city row, many for "Other") */
  cities: string[];
  accounts: number;
  contacts: number;
  /** all time, like BreakdownRow.accountsContacted */
  accountsContacted: number;
  accountsNotContacted: number;
}

export const OTHER_CITIES = '__other__';
export const TOTAL_KEY = '__total__';
export const BY_CITY_TOP = 12;

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
  /** top cities by account count, then "Other", then "Unknown" */
  byCity: CityRow[];
  /** totals for the By-city table (computed independently; equals the sum of byCity) */
  byCityTotal: CityRow;
  /** accounts contacted / not contacted over ALL time (ignores the range) */
  accountsContacted: number;
  accountsNotContacted: number;
  funnel: FunnelStage[];
  weekly: WeekBucket[];
  recent: OutreachEvent[];
  coverage: Coverage;
  index: EventIndex;
}

export const TYPE_LABEL: Record<AccountType, string> = {
  firm: 'Accounting firms',
  services: 'Outsourcing & finance services',
  internal: 'Internal finance teams',
  solo: '1-person',
};
export const TYPE_ORDER: readonly AccountType[] = ['firm', 'services', 'internal', 'solo'];

export const SEGMENT_ORDER: readonly string[] = [
  'Accounting & advisory',
  'Outsourcing for accounting firms',
  'Bookkeeping & BAS',
  'Outsourced CFO & finance',
  'Other financial services',
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
  allTime: EventIndex,
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
    let contacted = 0;
    for (const a of g.accounts) {
      contacts += a.contacts.length;
      if (index.byAccount.has(a.id)) touched++;
      if (isContacted(accountActivity(allTime, a.id).status)) contacted++;
    }
    rows.push({
      key: k,
      label: labelOf(k),
      accounts: g.accounts.length,
      contacts,
      accountsTouched: touched,
      accountsContacted: contacted,
      accountsNotContacted: g.accounts.length - contacted,
      ...tally(evs, index),
    });
  }
  return rows.sort((a, b) => order(a.key, b.key));
}

/**
 * The account an event is attributed to for the By-city table: its own `accountId` when that matched, else the
 * first account it matched. Each event therefore lands in exactly one row, so the rows add up to the total
 * (an event whose email matches contacts at two accounts would otherwise count twice).
 */
export function primaryAccountId(e: OutreachEvent, index: EventIndex): string | undefined {
  const ids = index.eventAccounts.get(e.id) ?? [];
  return e.accountId && ids.includes(e.accountId) ? e.accountId : ids[0];
}

/**
 * Dashboard "By city": the `top` cities by account count (ties by name), then "Other" aggregating the remaining
 * known cities, then "Unknown" (no city). Accounts / Contacts / Contacted / Not contacted are all time; Sent,
 * Replies and Meetings count events in range (`events` + `index` are the in-range ones), each event attributed
 * once via `primaryAccountId`. Unmatched events belong to no city and are excluded from every row and the total.
 */
export function computeByCity(
  accounts: readonly Account[],
  events: readonly OutreachEvent[],
  index: EventIndex,
  allTime: EventIndex,
  top = BY_CITY_TOP,
): { rows: CityRow[]; total: CityRow } {
  interface Acc {
    cities: Set<string>;
    accounts: number;
    contacts: number;
    contacted: number;
    events: OutreachEvent[];
  }
  const blank = (): Acc => ({ cities: new Set(), accounts: 0, contacts: 0, contacted: 0, events: [] });
  const byCity = new Map<string, Acc>();
  const keyOfAccount = new Map<string, string>();
  for (const a of accounts) {
    const k = cityOf(a) || UNKNOWN;
    keyOfAccount.set(a.id, k);
    let g = byCity.get(k);
    if (!g) byCity.set(k, (g = blank()));
    if (k !== UNKNOWN) g.cities.add(k);
    g.accounts++;
    g.contacts += a.contacts.length;
    if (isContacted(accountActivity(allTime, a.id).status)) g.contacted++;
  }
  const matched: OutreachEvent[] = [];
  for (const e of events) {
    const aid = primaryAccountId(e, index);
    const k = aid ? keyOfAccount.get(aid) : undefined;
    if (k === undefined) continue;
    byCity.get(k)!.events.push(e);
    matched.push(e);
  }

  const known = [...byCity.entries()]
    .filter(([k]) => k !== UNKNOWN)
    .sort((x, y) => y[1].accounts - x[1].accounts || x[0].localeCompare(y[0]));
  const groups: [string, string, Acc][] = known.slice(0, top).map(([k, g]) => [k, k, g]);
  const rest = known.slice(top);
  if (rest.length) {
    const other = blank();
    for (const [k, g] of rest) {
      other.cities.add(k);
      other.accounts += g.accounts;
      other.contacts += g.contacts;
      other.contacted += g.contacted;
      other.events.push(...g.events);
    }
    groups.push([OTHER_CITIES, `Other (${rest.length} ${rest.length === 1 ? 'city' : 'cities'})`, other]);
  }
  const unknown = byCity.get(UNKNOWN);
  if (unknown) groups.push([UNKNOWN, 'Unknown', unknown]);

  const toRow = (key: string, label: string, g: Pick<Acc, 'accounts' | 'contacts' | 'contacted' | 'events'> & { cities: Iterable<string> }): CityRow => ({
    key,
    label,
    cities: [...g.cities].sort(),
    accounts: g.accounts,
    contacts: g.contacts,
    accountsContacted: g.contacted,
    accountsNotContacted: g.accounts - g.contacted,
    ...tally(g.events, index),
  });
  const rows = groups.map(([k, label, g]) => toRow(k, label, g));

  let contacts = 0,
    contacted = 0;
  for (const a of accounts) {
    contacts += a.contacts.length;
    if (isContacted(accountActivity(allTime, a.id).status)) contacted++;
  }
  const total = toRow(TOTAL_KEY, 'Total', { cities: known.map(([k]) => k), accounts: accounts.length, contacts, contacted, events: matched });
  return { rows, total };
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
  // "Contacted / Not contacted" ignore the range (they must match the Accounts view), so they need an all-time index.
  const allTime = range === 'all' ? index : buildEventIndex(accounts, events);
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
    allTime,
    typeKey,
    (k) => TYPE_LABEL[k as AccountType] ?? 'Other',
    (a, b) => {
      const ia = TYPE_ORDER.indexOf(a as AccountType);
      const ib = TYPE_ORDER.indexOf(b as AccountType);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    },
  );
  const bySegment = breakdown(accounts, inRange, index, allTime, segmentOf, (k) => k, compareSegments);
  const byCity = computeByCity(accounts, inRange, index, allTime);

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
    byCity: byCity.rows,
    byCityTotal: byCity.total,
    accountsContacted: byCity.total.accountsContacted,
    accountsNotContacted: byCity.total.accountsNotContacted,
    funnel,
    weekly: weeklySeries(inRange, range, now),
    recent: inRange.slice().sort(compareEventsDesc).slice(0, recentLimit),
    coverage: computeCoverage(accounts),
    index,
  };
}
