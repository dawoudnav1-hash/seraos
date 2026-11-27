import { describe, expect, it } from 'vitest';
import { dedupeById, filterByRange, mergeEvents, parseImport, rangeStart, sanitizeEvent } from './events';
import { formatRate } from './format';
import { computeDashboardStats, safeRate, weekStartUTC, weeklySeries } from './stats';
import { account, contact, ev } from './testUtils';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

describe('empty data', () => {
  it('computes zeros and a null reply rate without throwing', () => {
    const s = computeDashboardStats({ accounts: [], events: [], range: 'all', now: NOW });
    expect(s.sent).toBe(0);
    expect(s.seen).toBe(0);
    expect(s.replies).toBe(0);
    expect(s.replyRate).toBeNull();
    expect(formatRate(s.replyRate)).toBe('—');
    expect(s.accountsTouched).toBe(0);
    expect(s.totalAccounts).toBe(0);
    expect(s.totalContacts).toBe(0);
    expect(s.hasSeenTracking).toBe(false);
    expect(s.funnel.map((f) => f.count)).toEqual([0, 0, 0, 0, 0]);
    expect(s.recent).toEqual([]);
    expect(s.weekly).toEqual([]);
    expect(s.channels.every((c) => c.replyRate === null)).toBe(true);
  });
  it('accounts with zero contacts and zero events', () => {
    const s = computeDashboardStats({ accounts: [account('a')], events: [], range: '30d', now: NOW });
    expect(s.totalAccounts).toBe(1);
    expect(s.coverage.accountsWithoutContacts).toBe(1);
    expect(s.byType[0]!.replyRate).toBeNull();
  });
});

describe('dedupe & merge', () => {
  it('drops duplicate ids keeping the first', () => {
    const a = ev('sent', { id: 'x', source: 'gen' });
    const b = ev('reply', { id: 'x', source: 'manual' });
    expect(dedupeById([a, b])).toEqual([a]);
  });
  it('merge: generated + manual, generated wins on collision, duplicates counted once', () => {
    const g1 = ev('sent', { id: 'g1' });
    const g1dup = ev('sent', { id: 'g1' });
    const m1 = ev('sent', { id: 'm1', source: 'manual' });
    const mCollide = ev('meeting', { id: 'g1', source: 'manual' });
    const merged = mergeEvents([g1, g1dup], [m1, mCollide]);
    expect(merged.map((e) => e.id)).toEqual(['g1', 'm1']);
    expect(merged[0]!.kind).toBe('sent');
    const s = computeDashboardStats({ accounts: [], events: merged, range: 'all', now: NOW });
    expect(s.sent).toBe(2);
    expect(s.meetings).toBe(0);
  });
  it('manual events count in stats exactly like generated ones', () => {
    const c = contact('c1', { email: 'a@b.com' });
    const gen = [ev('sent', { id: 'g', contactId: 'c1', channel: 'email' })];
    const man = [ev('reply', { id: 'm', contactId: 'c1', channel: 'email', source: 'manual' })];
    const s = computeDashboardStats({ accounts: [account('a', [c])], events: mergeEvents(gen, man), range: 'all', now: NOW });
    expect(s.sent).toBe(1);
    expect(s.replies).toBe(1);
    expect(s.replyRate).toBe(1);
    expect(s.funnel.find((f) => f.key === 'replied')!.count).toBe(1);
  });
});

describe('date range filtering', () => {
  it('7d boundary is inclusive at exactly now-7d and excludes 1ms earlier', () => {
    const start = rangeStart('7d', NOW)!;
    expect(start).toBe(NOW - 7 * DAY);
    const onEdge = ev('sent', { date: iso(start) });
    const justBefore = ev('sent', { date: iso(start - 1) });
    const future = ev('sent', { date: iso(NOW + DAY) });
    const kept = filterByRange([onEdge, justBefore, future], '7d', NOW).map((e) => e.id);
    expect(kept).toEqual([onEdge.id, future.id]);
  });
  it('30d / 90d windows', () => {
    const d29 = ev('sent', { date: iso(NOW - 29 * DAY) });
    const d31 = ev('sent', { date: iso(NOW - 31 * DAY) });
    const d89 = ev('sent', { date: iso(NOW - 89 * DAY) });
    const d91 = ev('sent', { date: iso(NOW - 91 * DAY) });
    const all = [d29, d31, d89, d91];
    expect(filterByRange(all, '30d', NOW)).toEqual([d29]);
    expect(filterByRange(all, '90d', NOW)).toEqual([d29, d31, d89]);
    expect(filterByRange(all, 'all', NOW)).toEqual(all);
  });
  it('invalid dates are kept only for "all"', () => {
    const bad = ev('sent', { date: 'garbage' });
    expect(filterByRange([bad], 'all', NOW)).toHaveLength(1);
    expect(filterByRange([bad], '90d', NOW)).toHaveLength(0);
    const s = computeDashboardStats({ accounts: [], events: [bad], range: 'all', now: NOW });
    expect(s.sent).toBe(1);
    expect(s.undatedEvents).toBe(1);
  });
  it('stats respect the range', () => {
    const events = [ev('sent', { date: iso(NOW - 2 * DAY) }), ev('sent', { date: iso(NOW - 40 * DAY) })];
    expect(computeDashboardStats({ accounts: [], events, range: '7d', now: NOW }).sent).toBe(1);
    expect(computeDashboardStats({ accounts: [], events, range: 'all', now: NOW }).sent).toBe(2);
  });
});

describe('reply rate', () => {
  it('denominator is unique contacts messaged, not message count', () => {
    const c1 = contact('c1', { email: 'one@x.com' });
    const c2 = contact('c2', { email: 'two@x.com' });
    const events = [
      ev('sent', { contactId: 'c1', channel: 'email' }),
      ev('sent', { contactId: 'c1', channel: 'email' }), // follow-up to the same person
      ev('sent', { contactId: 'c1', channel: 'email' }),
      ev('sent', { counterpartyEmails: ['TWO@x.com'], channel: 'email' }), // matched by email only
      ev('reply', { contactId: 'c1', channel: 'email' }),
      ev('reply', { contactId: 'c1', channel: 'email' }), // same person replies twice
    ];
    const s = computeDashboardStats({ accounts: [account('a', [c1, c2])], events, range: 'all', now: NOW });
    expect(s.sent).toBe(4);
    expect(s.messagedPeople).toBe(2);
    expect(s.replies).toBe(2);
    expect(s.repliedPeople).toBe(1);
    expect(s.replyRate).toBe(0.5);
    expect(formatRate(s.replyRate)).toBe('50%');
  });
  it('unmatched recipients are de-duplicated by email / name', () => {
    const events = [
      ev('sent', { counterpartyEmails: ['x@unknown.com'], channel: 'email' }),
      ev('sent', { counterpartyEmails: ['X@Unknown.com'], channel: 'email' }),
      ev('connection_sent', { personName: 'Pat Smith' }),
      ev('message_sent', { personName: 'pat smith' }),
      ev('sent', {}),
    ];
    const s = computeDashboardStats({ accounts: [], events, range: 'all', now: NOW });
    expect(s.messagedPeople).toBe(3);
    expect(s.unmatchedEvents).toBe(5);
  });
  it('reply rate never exceeds 100%: repliers we never messaged are not in the numerator', () => {
    const c1 = contact('c1', { email: 'one@x.com' });
    const c2 = contact('c2', { email: 'two@x.com' });
    const events = [
      ev('sent', { contactId: 'c1', channel: 'email' }),
      ev('reply', { contactId: 'c1', channel: 'email' }),
      ev('reply', { counterpartyEmails: ['stranger@x.com'], channel: 'email' }),
      ev('reply', { personName: 'Li Wei', channel: 'linkedin' }),
    ];
    const s = computeDashboardStats({ accounts: [account('a', [c1, c2])], events, range: 'all', now: NOW });
    expect(s.replies).toBe(3);
    expect(s.repliedPeople).toBe(3);
    expect(s.messagedPeople).toBe(1);
    expect(s.replyRate).toBe(1);
    const only = computeDashboardStats({ accounts: [account('a', [c1, c2])], events: [events[0]!, events[2]!, events[3]!], range: 'all', now: NOW });
    expect(only.replyRate).toBe(0);
  });
  it('divide-by-zero gives null and renders as —', () => {
    expect(safeRate(3, 0)).toBeNull();
    expect(safeRate(0, 0)).toBeNull();
    expect(safeRate(1, 4)).toBe(0.25);
    const s = computeDashboardStats({ accounts: [], events: [ev('reply')], range: 'all', now: NOW });
    expect(s.replies).toBe(1);
    expect(s.replyRate).toBeNull();
    expect(formatRate(s.replyRate)).toBe('—');
  });
});

describe('kind semantics', () => {
  it('sent / seen / accepted / meetings / channel split', () => {
    const events = [
      ev('sent', { channel: 'email' }),
      ev('sent', { channel: 'email', seenFlag: true }),
      ev('opened', { channel: 'email' }),
      ev('connection_sent', { channel: 'linkedin' }),
      ev('message_sent', { channel: 'linkedin' }),
      ev('message_seen', { channel: 'linkedin' }),
      ev('connection_accepted', { channel: 'linkedin' }),
      ev('meeting', { channel: 'email' }),
    ];
    const s = computeDashboardStats({ accounts: [], events, range: 'all', now: NOW });
    expect(s.sent).toBe(4);
    expect(s.sentEmail).toBe(2);
    expect(s.sentLinkedin).toBe(2);
    expect(s.seen).toBe(3);
    expect(s.hasSeenTracking).toBe(true);
    expect(s.connectionsSent).toBe(1);
    expect(s.connectionsAccepted).toBe(1);
    expect(s.meetings).toBe(1);
    const email = s.channels.find((c) => c.channel === 'email')!;
    const li = s.channels.find((c) => c.channel === 'linkedin')!;
    expect([email.sent, email.seen]).toEqual([2, 2]);
    expect([li.sent, li.seen]).toEqual([2, 1]);
  });
  it('hasSeenTracking is false when no event carries open/seen info', () => {
    const s = computeDashboardStats({ accounts: [], events: [ev('sent'), ev('reply')], range: 'all', now: NOW });
    expect(s.seen).toBe(0);
    expect(s.hasSeenTracking).toBe(false);
  });
});

describe('accounts / contacts / funnel / breakdowns', () => {
  const c1 = contact('c1', { email: 'c1@a.com', emailRisk: 'ok', linkedin: 'https://linkedin.com/in/c1' });
  const c2 = contact('c2', { email: 'c2@a.com', emailRisk: 'caution' });
  const c3 = contact('c3', { emailRisk: 'none', likelyLeft: true });
  const accounts = [
    account('firm1', [c1], { type: 'firm', segment: 'Accounting & advisory' }),
    account('int1', [c2, c3], { type: 'internal', segment: 'SaaS' }),
    account('solo1', [], { type: 'solo', segment: 'Other' }),
  ];
  const events = [
    ev('sent', { contactId: 'c1', channel: 'email' }),
    ev('reply', { contactId: 'c1', channel: 'email' }),
    ev('meeting', { contactId: 'c1', channel: 'email' }),
    ev('sent', { accountId: 'int1', counterpartyEmails: ['someone-else@a.com'], channel: 'email' }),
    ev('connection_sent', { contactId: 'c2' }),
    ev('sent', { counterpartyEmails: ['stranger@nowhere.com'], channel: 'email' }),
  ];
  const s = computeDashboardStats({ accounts, events, range: 'all', now: NOW });

  it('touched / reached', () => {
    expect(s.accountsTouched).toBe(2);
    expect(s.totalAccounts).toBe(3);
    expect(s.contactsReached).toBe(2);
    expect(s.totalContacts).toBe(3);
    expect(s.unmatchedEvents).toBe(1);
  });
  it('funnel is monotone and uses derived status', () => {
    expect(s.funnel.map((f) => [f.key, f.count])).toEqual([
      ['contacts', 3],
      ['messaged', 2],
      ['seen', 1],
      ['replied', 1],
      ['meeting', 1],
    ]);
  });
  it('breakdown by type and segment', () => {
    expect(s.byType.map((r) => r.key)).toEqual(['firm', 'internal', 'solo']);
    const firm = s.byType[0]!;
    expect([firm.accounts, firm.contacts, firm.accountsTouched, firm.sent, firm.replies, firm.meetings]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(firm.replyRate).toBe(1);
    const internal = s.byType[1]!;
    expect([internal.sent, internal.messagedPeople, internal.replyRate]).toEqual([2, 2, 0]);
    expect(s.byType[2]!.replyRate).toBeNull();
    expect(s.bySegment.map((r) => r.key)).toEqual(['Accounting & advisory', 'SaaS', 'Other']);
  });
  it('coverage', () => {
    expect(s.coverage).toMatchObject({
      totalContacts: 3,
      withEmail: 2,
      withVerifiedEmail: 1,
      withCautionEmail: 1,
      withLinkedin: 1,
      likelyLeft: 1,
      accountsWithoutContacts: 1,
      accountsWithoutEmail: 1,
    });
  });
  it('recent feed is newest first and limited', () => {
    const many = Array.from({ length: 40 }, (_, i) => ev('sent', { date: iso(NOW - i * 1000) }));
    const r = computeDashboardStats({ accounts: [], events: many, range: 'all', now: NOW }).recent;
    expect(r).toHaveLength(25);
    expect(r[0]!.id).toBe(many[0]!.id);
  });
});

describe('weekly series', () => {
  it('weeks start on Monday UTC and gaps are zero-filled', () => {
    expect(new Date(weekStartUTC(Date.parse('2026-11-22T12:00:00Z'))).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(weekStartUTC(Date.parse('2026-11-16T00:00:00Z'))).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    const events = [
      ev('sent', { channel: 'email', date: '2026-11-02T10:00:00Z' }),
      ev('reply', { channel: 'linkedin', date: '2026-11-17T10:00:00Z' }),
      ev('message_sent', { channel: 'linkedin', date: '2026-11-18T10:00:00Z' }),
    ];
    const w = weeklySeries(events, 'all', NOW);
    expect(w.map((b) => new Date(b.weekStart).toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(w[0]).toMatchObject({ sentEmail: 1, sentLinkedin: 0 });
    expect(w[1]).toMatchObject({ sentEmail: 0, repliesEmail: 0 });
    expect(w[2]).toMatchObject({ sentLinkedin: 1, repliesLinkedin: 1 });
  });
  it('caps very long ranges at 52 weeks', () => {
    const w = weeklySeries([ev('sent', { date: '2020-01-01T00:00:00Z' })], 'all', NOW);
    expect(w).toHaveLength(52);
  });
});

describe('event validation / import', () => {
  it('sanitizeEvent rejects bad shapes', () => {
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent({ id: 'a', date: 'x', channel: 'fax', kind: 'sent', source: 's' })).toBeNull();
    expect(sanitizeEvent({ id: 'a', date: 'x', channel: 'email', kind: 'poke', source: 's' })).toBeNull();
    expect(sanitizeEvent({ date: 'x', channel: 'email', kind: 'sent' })).toBeNull();
    expect(sanitizeEvent({ id: 'a', date: '2026-01-01', channel: 'email', kind: 'sent', counterpartyEmails: 'no' })).toEqual({
      id: 'a',
      date: '2026-01-01',
      channel: 'email',
      kind: 'sent',
      source: 'unknown',
    });
  });
  it('parseImport accepts arrays or {events}, rejects junk, forces source=manual', () => {
    const good = { id: 'm1', date: '2026-11-01T00:00:00Z', channel: 'email', kind: 'sent', source: 'x' };
    expect(parseImport('not json').error).toBeTruthy();
    expect(parseImport('{"foo":1}').error).toBeTruthy();
    const r1 = parseImport(JSON.stringify([good, { id: 'bad' }, { ...good, id: 'm2', date: 'nope' }]));
    expect(r1.events.map((e) => e.id)).toEqual(['m1']);
    expect(r1.events[0]!.source).toBe('manual');
    expect(r1.rejected).toBe(2);
    const r2 = parseImport(JSON.stringify({ events: [good] }));
    expect(r2.events).toHaveLength(1);
  });
});
