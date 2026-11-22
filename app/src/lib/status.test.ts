import { describe, expect, it } from 'vitest';
import { buildEventIndex, deriveStatus, eventStatus, sortContacts } from './status';
import { account, contact, ev } from './testUtils';

describe('deriveStatus precedence', () => {
  it('is not_contacted with no events', () => {
    expect(deriveStatus([])).toBe('not_contacted');
  });
  it('Meeting > Replied > Seen > Contacted', () => {
    expect(deriveStatus([ev('sent')])).toBe('contacted');
    expect(deriveStatus([ev('connection_sent')])).toBe('contacted');
    expect(deriveStatus([ev('connection_accepted')])).toBe('contacted');
    expect(deriveStatus([ev('message_sent')])).toBe('contacted');
    expect(deriveStatus([ev('sent'), ev('opened')])).toBe('seen');
    expect(deriveStatus([ev('message_seen'), ev('sent')])).toBe('seen');
    expect(deriveStatus([ev('sent', { seenFlag: true })])).toBe('seen');
    expect(deriveStatus([ev('sent', { seenFlag: false })])).toBe('contacted');
    expect(deriveStatus([ev('reply'), ev('opened'), ev('sent')])).toBe('replied');
    expect(deriveStatus([ev('sent'), ev('meeting'), ev('reply'), ev('opened')])).toBe('meeting');
  });
  it('order of events does not matter', () => {
    const evs = [ev('meeting'), ev('sent'), ev('reply')];
    expect(deriveStatus(evs)).toBe(deriveStatus([...evs].reverse()));
  });
  it('eventStatus maps single events', () => {
    expect(eventStatus(ev('reply'))).toBe('replied');
    expect(eventStatus(ev('opened'))).toBe('seen');
    expect(eventStatus(ev('meeting'))).toBe('meeting');
  });
});

describe('buildEventIndex matching', () => {
  const c1 = contact('c1', { email: 'Jane.Doe@Acme.com' });
  const c2 = contact('c2', { email: 'bob@acme.com' });
  const c3 = contact('c3');
  const a1 = account('a1', [c1, c2]);
  const a2 = account('a2', [c3]);

  it('matches by contactId', () => {
    const e = ev('sent', { contactId: 'c3' });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.eventContacts.get(e.id)).toEqual(['c3']);
    expect(idx.eventAccounts.get(e.id)).toEqual(['a2']);
    expect(idx.byAccount.get('a2')?.status).toBe('contacted');
  });

  it('matches only by email, case-insensitively', () => {
    const e = ev('reply', { channel: 'email', counterpartyEmails: ['  jane.doe@ACME.com '] });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.eventContacts.get(e.id)).toEqual(['c1']);
    expect(idx.eventAccounts.get(e.id)).toEqual(['a1']);
    expect(idx.byContact.get('c1')?.status).toBe('replied');
    expect(idx.byContact.get('c2')).toBeUndefined();
  });

  it('falls back to email when contactId is unknown', () => {
    const e = ev('sent', { contactId: 'ghost', counterpartyEmails: ['bob@acme.com'] });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.eventContacts.get(e.id)).toEqual(['c2']);
  });

  it('contactId wins over a conflicting email', () => {
    const e = ev('sent', { contactId: 'c3', counterpartyEmails: ['bob@acme.com'] });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.eventContacts.get(e.id)).toEqual(['c3']);
  });

  it('accountId without contact attributes to the account only', () => {
    const e = ev('sent', { accountId: 'a1', counterpartyEmails: ['nobody@acme.com'] });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.eventContacts.get(e.id)).toEqual([]);
    expect(idx.eventAccounts.get(e.id)).toEqual(['a1']);
    expect(idx.byAccount.get('a1')?.status).toBe('contacted');
    expect(idx.byContact.size).toBe(0);
    expect(idx.unmatched).toHaveLength(0);
  });

  it('events with no accountId/contactId/email are unmatched and do not crash', () => {
    const e = ev('sent', {});
    const e2 = ev('reply', { accountId: 'unknown-account' });
    const idx = buildEventIndex([a1, a2], [e, e2]);
    expect(idx.unmatched.map((x) => x.id)).toEqual([e.id, e2.id]);
    expect(idx.byAccount.size).toBe(0);
  });

  it('account gets events via its contact even if accountId is missing', () => {
    const e = ev('meeting', { contactId: 'c2' });
    const idx = buildEventIndex([a1, a2], [e]);
    expect(idx.byAccount.get('a1')?.status).toBe('meeting');
  });

  it('lastTouch is the newest dated event; undated events are tolerated', () => {
    const idx = buildEventIndex(
      [a1],
      [
        ev('sent', { contactId: 'c1', date: '2026-01-01T00:00:00Z' }),
        ev('sent', { contactId: 'c1', date: 'not a date' }),
        ev('reply', { contactId: 'c1', date: '2026-03-01T00:00:00Z' }),
      ],
    );
    const act = idx.byContact.get('c1')!;
    expect(act.lastTouch).toBe(Date.parse('2026-03-01T00:00:00Z'));
    expect(act.events[0]!.kind).toBe('reply');
    expect(act.events[2]!.date).toBe('not a date');
  });

  it('handles empty input', () => {
    const idx = buildEventIndex([], []);
    expect(idx.byAccount.size).toBe(0);
    expect(idx.unmatched).toEqual([]);
  });
});

describe('sortContacts', () => {
  it('primary/finance first, likely-left last', () => {
    const list = [
      contact('left', { name: 'A', likelyLeft: true, isPrimary: true, roleType: 'Finance' }),
      contact('exec', { name: 'B', roleType: 'Executive' }),
      contact('fin', { name: 'C', roleType: 'Finance' }),
      contact('prim', { name: 'D', isPrimary: true, roleType: 'Executive' }),
    ];
    expect(sortContacts(list).map((c) => c.id)).toEqual(['prim', 'fin', 'exec', 'left']);
  });
});
