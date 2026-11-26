import type { Account, Contact, OutreachEvent } from '../types';

export function contact(id: string, extra: Partial<Contact> = {}): Contact {
  return { id, name: `Contact ${id}`, sources: [], inAttio: false, ...extra };
}

export function account(id: string, contacts: Contact[] = [], extra: Partial<Account> = {}): Account {
  return {
    id,
    name: `Account ${id}`,
    type: 'internal',
    typeReason: '',
    segment: 'SaaS',
    inAttio: false,
    sources: [],
    rating: 60,
    grade: 'C',
    ratingReasons: [],
    contacts,
    ...extra,
  };
}

let n = 0;
export function ev(kind: OutreachEvent['kind'], extra: Partial<OutreachEvent> = {}): OutreachEvent {
  n++;
  return {
    id: `e${n}`,
    date: '2026-11-01T00:00:00.000Z',
    channel: kind === 'sent' || kind === 'opened' ? 'email' : 'linkedin',
    kind,
    source: 'test',
    ...extra,
  };
}
