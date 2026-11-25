// Contacted / not-contacted filtering and city / state location features.
import { describe, expect, it } from 'vitest';
import accountsFixture from '../__fixtures__/accounts.json';
import outreachFixture from '../__fixtures__/outreach.json';
import { normalizeAccounts, normalizeOutreach } from './data';
import { mergeEvents } from './events';
import {
  DEFAULT_ACCOUNT_FILTERS,
  DEFAULT_CONTACT_FILTERS,
  UNKNOWN,
  accountHaystack,
  buildAccountRows,
  buildContactRows,
  cityDisplay,
  cityOptions,
  citySortKey,
  citySubtitle,
  compareSortValues,
  contactedCounts,
  filterAccountRows,
  filterContactRows,
  locationSelectOptions,
  normalizeOutreach as normalizeOutreachFilter,
  outreachSelectValue,
  sectionCounts,
  stateOptions,
  withContacted,
  withOutreachStatus,
  withoutOutreach,
  withState,
  type AccountFilters,
} from './filters';
import { OTHER_CITIES, computeByCity, computeDashboardStats, type CityRow } from './stats';
import { buildEventIndex } from './status';
import { account, ev } from './testUtils';
import type { OutreachEvent } from '../types';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const { accounts } = normalizeAccounts(accountsFixture);
const { outreach } = normalizeOutreach(outreachFixture);

function setup(manual: OutreachEvent[] = []) {
  const events = mergeEvents(outreach.events, manual);
  const index = buildEventIndex(accounts, events);
  return { events, index, accountRows: buildAccountRows(accounts, index), contactRows: buildContactRows(accounts, index) };
}
const ids = (rows: readonly { account: { id: string } }[]) => rows.map((r) => r.account.id).sort();
const contactIds = (rows: readonly { contact: { id: string } }[]) => rows.map((r) => r.contact.id).sort();
const manual = (extra: Partial<OutreachEvent>) => ev('sent', { id: `manual-${Math.random()}`, source: 'manual', channel: 'email', ...extra });

describe('contacted / not contacted — accounts', () => {
  it('splits accounts by derived status; the two halves add up to All', () => {
    const { accountRows } = setup();
    const nc = filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, contacted: 'not_contacted' });
    const c = filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, contacted: 'contacted' });
    expect(ids(nc)).toEqual(['harbourline-ventures', 'zephyr-logistics']);
    // kowhai is contacted through an email-only event; outback through a connection request
    expect(ids(c)).toEqual(['kowhai-partners', 'ledgerline-advisory', 'mia-chen-bookkeeping', 'northwind-payroll', 'outback-gear', 'quokka-ai', 'saltbush-skincare']);
    expect(contactedCounts(accountRows)).toEqual({ all: 9, contacted: 7, not_contacted: 2 });
  });

  it('a manual event turns a not-contacted account Contacted (counts move by exactly one)', () => {
    const before = contactedCounts(setup().accountRows);
    const { accountRows } = setup([manual({ accountId: 'harbourline-ventures', kind: 'connection_sent', channel: 'linkedin' })]);
    expect(contactedCounts(accountRows)).toEqual({ all: 9, contacted: before.contacted + 1, not_contacted: before.not_contacted - 1 });
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, contacted: 'not_contacted' }))).toEqual(['zephyr-logistics']);
  });

  it('combines with the section tab counts, search and city', () => {
    const { accountRows } = setup();
    const nc = filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, contacted: 'not_contacted' });
    expect(sectionCounts(nc)).toEqual({ all: 2, firm: 0, services: 0, internal: 2, solo: 0 });
    const sydney = filterAccountRows(accountRows, withoutOutreach({ ...DEFAULT_ACCOUNT_FILTERS, city: 'Sydney' }));
    expect(contactedCounts(sydney)).toEqual({ all: 3, contacted: 2, not_contacted: 1 });
  });

  it('a detailed status narrows within Contacted', () => {
    const { accountRows } = setup();
    const f = withOutreachStatus(DEFAULT_ACCOUNT_FILTERS, 'replied');
    expect(f.contacted).toBe('contacted');
    expect(ids(filterAccountRows(accountRows, f))).toEqual(['ledgerline-advisory', 'saltbush-skincare']);
  });
});

describe('contacted toggle and Outreach select share one consistent state', () => {
  const base: AccountFilters = DEFAULT_ACCOUNT_FILTERS;
  it('picking "Not contacted" in the select moves the toggle and never stores it as a status', () => {
    const f = withOutreachStatus(base, 'not_contacted');
    expect(f).toMatchObject({ contacted: 'not_contacted', status: '' });
    expect(outreachSelectValue(f)).toBe('not_contacted');
  });
  it('a contacted+ status forces the toggle to Contacted; leaving Contacted clears the status', () => {
    const seen = withOutreachStatus(withContacted(base, 'not_contacted'), 'seen');
    expect(seen).toMatchObject({ contacted: 'contacted', status: 'seen' });
    expect(withContacted(seen, 'contacted')).toMatchObject({ contacted: 'contacted', status: 'seen' });
    expect(withContacted(seen, 'all')).toMatchObject({ contacted: 'all', status: '' });
    expect(withContacted(seen, 'not_contacted')).toMatchObject({ contacted: 'not_contacted', status: '' });
  });
  it('"Any" keeps Contacted but leaves Not contacted', () => {
    expect(withOutreachStatus({ ...base, contacted: 'contacted', status: 'seen' }, '')).toMatchObject({ contacted: 'contacted', status: '' });
    expect(withOutreachStatus({ ...base, contacted: 'not_contacted' }, '')).toMatchObject({ contacted: 'all', status: '' });
  });
  it('normalises contradictory persisted state', () => {
    expect(normalizeOutreachFilter({ ...base, contacted: 'not_contacted', status: 'meeting' })).toMatchObject({ contacted: 'contacted', status: 'meeting' });
    expect(normalizeOutreachFilter({ ...base, contacted: 'all', status: 'not_contacted' })).toMatchObject({ contacted: 'not_contacted', status: '' });
  });
});

describe('contacted / not contacted — contacts', () => {
  it('a contact is contacted when ITS status is not "Not contacted"', () => {
    const { contactRows } = setup();
    const c = filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, contacted: 'contacted' });
    expect(contactIds(c)).toEqual([
      'c-kowhai-1',
      'c-ledgerline-1',
      'c-ledgerline-2',
      'c-mia-1',
      'c-northwind-1',
      'c-northwind-2',
      'c-outback-1',
      'c-quokka-1',
      'c-saltbush-1',
    ]);
    // ledgerline is a contacted account, but its third contact has never been reached
    const nc = filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, contacted: 'not_contacted' });
    expect(contactIds(nc)).toContain('c-ledgerline-3');
    expect(c.length + nc.length).toBe(contactRows.length);
    expect(contactedCounts(contactRows)).toEqual({ all: contactRows.length, contacted: 9, not_contacted: contactRows.length - 9 });
  });

  it('manual events (by contactId or by email) make exactly that contact Contacted', () => {
    const before = contactedCounts(setup().contactRows);
    const { contactRows } = setup([
      manual({ accountId: 'ledgerline-advisory', contactId: 'c-ledgerline-3' }),
      manual({ counterpartyEmails: ['AISHA.KARIM@northwindpayroll.example.com'] }),
    ]);
    expect(contactedCounts(contactRows).contacted).toBe(before.contacted + 2);
    const nc = contactIds(filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, contacted: 'not_contacted' }));
    expect(nc).not.toContain('c-ledgerline-3');
    expect(nc).not.toContain('c-northwind-4');
    expect(nc).toContain('c-northwind-3');
  });

  it('combines with section, city and state', () => {
    const { contactRows } = setup();
    const f = { ...DEFAULT_CONTACT_FILTERS, section: 'firm' as const, city: 'Melbourne', contacted: 'not_contacted' as const };
    expect(contactIds(filterContactRows(contactRows, f))).toEqual(['c-ledgerline-3']);
    expect(filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, state: 'NSW' }).length).toBe(6);
  });
});

describe('city / state filters', () => {
  it('city filter, incl. Unknown', () => {
    const { accountRows } = setup();
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, city: 'Melbourne' }))).toEqual(['ledgerline-advisory', 'saltbush-skincare']);
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, city: UNKNOWN }))).toEqual(['outback-gear']);
    expect(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, city: 'Atlantis' })).toEqual([]);
  });

  it('city filter drives the section tab counts', () => {
    const { accountRows } = setup();
    expect(sectionCounts(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, city: 'Sydney' }))).toEqual({ all: 3, firm: 0, services: 0, internal: 3, solo: 0 });
  });

  it('state filter, incl. accounts with no state (e.g. a New Zealand city)', () => {
    const { accountRows } = setup();
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, state: 'NSW' }))).toEqual(['harbourline-ventures', 'northwind-payroll', 'quokka-ai']);
    const nz = account('pure-mama', [], { city: 'Tauranga' });
    const rows = buildAccountRows([...accounts, nz], buildEventIndex([...accounts, nz], []));
    expect(ids(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, state: UNKNOWN }))).toEqual(['outback-gear', 'pure-mama']);
    expect(ids(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, city: 'Tauranga' }))).toEqual(['pure-mama']);
  });

  it('changing the state clears a city outside that state', () => {
    const f = { ...DEFAULT_ACCOUNT_FILTERS, city: 'Melbourne' };
    expect(withState(f, 'VIC', accounts).city).toBe('Melbourne');
    expect(withState(f, 'NSW', accounts)).toMatchObject({ state: 'NSW', city: '' });
    expect(withState(f, '', accounts).city).toBe('Melbourne');
  });

  it('city options: most common first, ties by name, Unknown last; weights and state scoping', () => {
    expect(cityOptions(accounts)).toEqual([
      { value: 'Sydney', count: 3 },
      { value: 'Melbourne', count: 2 },
      { value: 'Adelaide', count: 1 },
      { value: 'Brisbane', count: 1 },
      { value: 'Perth', count: 1 },
      { value: UNKNOWN, count: 1 },
    ]);
    // counted by contacts (Adelaide's only account has none, so it is not listed)
    const byContacts = cityOptions(accounts, (a) => a.contacts.length);
    expect(byContacts[0]).toEqual({ value: 'Sydney', count: 6 });
    expect(byContacts.map((o) => o.value)).not.toContain('Adelaide');
    expect(cityOptions(accounts, undefined, 'VIC')).toEqual([{ value: 'Melbourne', count: 2 }]);
    expect(stateOptions(accounts).map((o) => o.value)).toEqual(['NSW', 'VIC', 'QLD', 'WA', 'SA', UNKNOWN]);
    const opts = locationSelectOptions(cityOptions(accounts), 'Atlantis', 'All', 'Unknown');
    expect(opts[0]).toEqual({ value: '', label: 'All' });
    expect(opts.find((o) => o.value === UNKNOWN)?.label).toBe('Unknown (1)');
    expect(opts.at(-1)).toEqual({ value: 'Atlantis', label: 'Atlantis (0)' });
  });
});

describe('city display and sort', () => {
  it('shows suburb + state as secondary text; a city without a state shows just the city', () => {
    const a = accounts.find((x) => x.id === 'ledgerline-advisory')!;
    expect(citySubtitle(a)).toBe('Richmond, VIC');
    expect(cityDisplay(a)).toBe('Melbourne (Richmond, VIC)');
    const nz = account('nz', [], { city: 'Tauranga' });
    expect(citySubtitle(nz)).toBe('');
    expect(cityDisplay(nz)).toBe('Tauranga');
    expect(cityDisplay(account('none'))).toBe('');
  });

  it('sorts by city then suburb, unknown cities last in both directions', () => {
    const list = [account('u'), account('mr', [], { city: 'Melbourne', suburb: 'Richmond' }), account('t', [], { city: 'Tauranga' }), account('a', [], { city: 'Adelaide' }), account('m', [], { city: 'Melbourne' })];
    const sortIds = (dir: 'asc' | 'desc') => [...list].sort((x, y) => compareSortValues(citySortKey(x), citySortKey(y), dir)).map((x) => x.id);
    expect(sortIds('asc')).toEqual(['a', 'm', 'mr', 't', 'u']);
    expect(sortIds('desc')).toEqual(['t', 'mr', 'm', 'a', 'u']);
  });
});

describe('search matches city, suburb and state', () => {
  it('accounts', () => {
    const { accountRows } = setup();
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'surry hills' }))).toEqual(['quokka-ai']);
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'Collingwood' }))).toEqual(['saltbush-skincare']);
    expect(ids(filterAccountRows(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'mawson' }))).toEqual(['zephyr-logistics']);
    const syn = [account('t', [], { city: 'Hobart', state: 'TAS' }), account('v', [], { city: 'Geelong', state: 'VIC' })];
    expect(accountHaystack(syn[0]!)).toContain('tas');
    const rows = buildAccountRows(syn, buildEventIndex(syn, []));
    expect(ids(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'TAS' }))).toEqual(['t']);
  });
  it('contacts (by their account’s location)', () => {
    const { contactRows } = setup();
    expect(contactIds(filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, query: 'fremantle' }))).toEqual(['c-mia-1']);
    expect(contactIds(filterContactRows(contactRows, { ...DEFAULT_CONTACT_FILTERS, query: 'richmond' }))).toEqual(['c-ledgerline-1', 'c-ledgerline-2', 'c-ledgerline-3']);
  });
});

describe('dashboard By city', () => {
  const sum = (rows: CityRow[], k: keyof CityRow) => rows.reduce((n, r) => n + (r[k] as number), 0);
  const KEYS = ['accounts', 'contacts', 'accountsContacted', 'accountsNotContacted', 'sent', 'replies', 'meetings', 'seen'] as const;

  it('top N, then "Other", then "Unknown"; rows add up to the total', () => {
    const { events, index } = setup();
    const { rows, total } = computeByCity(accounts, events, index, index, 2);
    expect(rows.map((r) => r.key)).toEqual(['Sydney', 'Melbourne', OTHER_CITIES, UNKNOWN]);
    const other = rows[2]!;
    expect(other.cities).toEqual(['Adelaide', 'Brisbane', 'Perth']);
    expect(other.label).toBe('Other (3 cities)');
    expect(other).toMatchObject({ accounts: 3, accountsContacted: 2, accountsNotContacted: 1, contacts: 3 });
    expect(rows[0]).toMatchObject({ key: 'Sydney', accounts: 3, accountsContacted: 2, accountsNotContacted: 1, contacts: 6, sent: 4, meetings: 1 }); // northwind 3 + quokka 1
    expect(rows[3]).toMatchObject({ key: UNKNOWN, label: 'Unknown', accounts: 1, accountsContacted: 1, contacts: 1 });
    for (const k of KEYS) expect(sum(rows, k), k).toBe(total[k]);
    expect(total.accounts).toBe(accounts.length);
    expect(total.contacts).toBe(accounts.reduce((n, a) => n + a.contacts.length, 0));
  });

  it('dashboard totals: every matched event counted once, unmatched left out', () => {
    const s = computeDashboardStats({ accounts, events: outreach.events, range: 'all', now: NOW });
    expect(s.byCity.map((r) => r.key)).toEqual(['Sydney', 'Melbourne', 'Adelaide', 'Brisbane', 'Perth', UNKNOWN]); // < 12 cities: no Other row
    for (const k of KEYS) expect(sum(s.byCity, k), k).toBe(s.byCityTotal[k]);
    expect(s.byCityTotal.sent).toBe(s.sent - 1); // ev-012 matches no account
    expect(s.byCityTotal.replies).toBe(s.replies);
    expect(s.accountsNotContacted).toBe(2);
    expect(s.byCityTotal.accountsContacted).toBe(s.accountsTouched); // with range All, contacted == touched
  });

  it('an event matching accounts in two cities is counted once (under its own accountId)', () => {
    const a1 = account('a1', [], { city: 'Melbourne' });
    const a2 = account('a2', [{ id: 'c2', name: 'X', email: 'x@y.com', sources: [], inAttio: false }], { city: 'Sydney' });
    const e = ev('sent', { accountId: 'a1', counterpartyEmails: ['x@y.com'], channel: 'email' });
    const s = computeDashboardStats({ accounts: [a1, a2], events: [e], range: 'all', now: NOW });
    expect(s.byCity.find((r) => r.key === 'Melbourne')!.sent).toBe(1);
    expect(s.byCity.find((r) => r.key === 'Sydney')!.sent).toBe(0);
    expect(s.byCity.find((r) => r.key === 'Sydney')!.accountsContacted).toBe(1); // but both accounts are contacted
    expect(s.byCityTotal.sent).toBe(1);
  });

  it('Contacted / Not contacted ignore the range; activity respects it', () => {
    const all = computeDashboardStats({ accounts, events: outreach.events, range: 'all', now: NOW });
    const week = computeDashboardStats({ accounts, events: outreach.events, range: '7d', now: NOW });
    expect(week.byCityTotal.accountsContacted).toBe(all.byCityTotal.accountsContacted);
    expect(week.byType.map((r) => r.accountsNotContacted)).toEqual(all.byType.map((r) => r.accountsNotContacted));
    expect(week.byCityTotal.sent).toBeLessThan(all.byCityTotal.sent);
    expect(week.accountsTouched).toBeLessThan(week.byCityTotal.accountsContacted);
    for (const k of KEYS) expect(sum(week.byCity, k), k).toBe(week.byCityTotal[k]);
  });
});

describe('normalisation of location fields', () => {
  it('trims city fields and upper-cases the state', () => {
    const { accounts: a } = normalizeAccounts([{ id: 'x', name: 'X', city: ' Gold Coast ', suburb: 'Burleigh Heads', state: 'qld ', cityBasis: 'Web research (Exa)' }, { id: 'y', name: 'Y', city: '  ', state: 7 }]);
    expect(a[0]).toMatchObject({ city: 'Gold Coast', suburb: 'Burleigh Heads', state: 'QLD', cityBasis: 'Web research (Exa)' });
    expect(a[1]!.city).toBeUndefined();
    expect(a[1]!.state).toBe('7'); // numbers are coerced to text like every other string field
  });
});
