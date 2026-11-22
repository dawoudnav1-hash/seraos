import { describe, expect, it } from 'vitest';
import accountsFixture from '../__fixtures__/accounts.json';
import outreachFixture from '../__fixtures__/outreach.json';
import { csvCell, toCsv } from './csv';
import { normalizeAccounts, normalizeOutreach } from './data';
import { mergeEvents } from './events';
import {
  DEFAULT_ACCOUNT_FILTERS,
  buildAccountRows,
  buildContactRows,
  compareSortValues,
  filterAccountRows,
  filterContactRows,
  DEFAULT_CONTACT_FILTERS,
  moneyValue,
  leadingNumber,
  sectionCounts,
} from './filters';
import { mailtoHref, safeUrl } from './links';
import { computeDashboardStats } from './stats';
import { buildEventIndex } from './status';

describe('safeUrl', () => {
  it('allows only http(s) (and mailto when asked)', () => {
    expect(safeUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(safeUrl('stepone.life')).toBe('https://stepone.life/');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,hi')).toBeUndefined();
    expect(safeUrl('mailto:a@b.com')).toBeUndefined();
    expect(safeUrl('mailto:a@b.com', true)).toBe('mailto:a@b.com');
    expect(safeUrl('')).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
    expect(safeUrl(42)).toBeUndefined();
    expect(mailtoHref('a@b.com')).toBe('mailto:a@b.com');
    expect(mailtoHref('not-an-email')).toBeUndefined();
    expect(mailtoHref('a@b.com?bcc=x@y.com')).toBeUndefined();
  });
});

describe('csv', () => {
  it('escapes quotes, commas, newlines and formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
});

describe('normalizeAccounts', () => {
  it('survives garbage and missing fields', () => {
    expect(normalizeAccounts(undefined).accounts).toEqual([]);
    expect(normalizeAccounts({}).accounts).toEqual([]);
    const { accounts, warnings } = normalizeAccounts([
      null,
      { id: 'a', name: 'A', type: 'firm' },
      { id: 'a', name: 'dup' },
      { name: 'No id', contacts: [{ name: 'X' }, { id: 'c1', name: 'Y' }, { id: 'c1', name: 'Y dup' }], signalScore: '4' },
    ]);
    expect(accounts.map((a) => a.id)).toEqual(['a', 'account-3']);
    expect(accounts[0]!.contacts).toEqual([]);
    expect(accounts[0]!.sources).toEqual([]);
    expect(accounts[1]!.contacts.map((c) => c.id)).toEqual(['account-3--contact-0', 'c1']);
    expect(accounts[1]!.signalScore).toBe(4);
    expect(accounts[1]!.type).toBe('internal');
    expect(warnings.length).toBe(3);
  });
  it('keeps the optional research fields and drops malformed ones', () => {
    const { accounts } = normalizeAccounts([
      {
        id: 'x',
        name: 'X',
        type: 'solo',
        fitScore: 9,
        sourceUrls: ['https://a.com', 5, ''],
        services: ['tax', 'BAS'],
        whyFit: 'Because',
        signalSource: 'Exa web research',
        otherAttioIds: ['rec_2'],
        otherDomains: 'not-an-array',
        flags: '⚠ Verify first',
      },
    ]);
    const a = accounts[0]!;
    expect(a.fitScore).toBe(5);
    expect(a.sourceUrls).toEqual(['https://a.com']);
    expect(a.services).toEqual(['tax', 'BAS']);
    expect(a.whyFit).toBe('Because');
    expect(a.signalSource).toBe('Exa web research');
    expect(a.otherAttioIds).toEqual(['rec_2']);
    expect(a.otherDomains).toBeUndefined();
    expect(a.flags).toBe('⚠ Verify first');
  });
  it('normalizeOutreach handles missing parts', () => {
    expect(normalizeOutreach(null).outreach.events).toEqual([]);
    const r = normalizeOutreach({ events: [{ id: 'x' }], sources: [{ name: 'S' }, 5] });
    expect(r.outreach.events).toEqual([]);
    expect(r.outreach.sources).toEqual([{ name: 'S', detail: '' }]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('fixture data end-to-end', () => {
  const { accounts } = normalizeAccounts(accountsFixture);
  const { outreach } = normalizeOutreach(outreachFixture);
  const index = buildEventIndex(accounts, outreach.events);

  it('loads every fixture account/event', () => {
    expect(accounts.length).toBe((accountsFixture as unknown[]).length);
    expect(outreach.events.length).toBe(outreachFixture.events.length);
  });
  it('email-only event matches the Kōwhai contact case-insensitively', () => {
    expect(index.eventContacts.get('ev-011')).toEqual(['c-kowhai-1']);
    expect(index.byAccount.get('kowhai-partners')?.status).toBe('contacted');
  });
  it('fully unmatched event is reported', () => {
    expect(index.unmatched.map((e) => e.id)).toEqual(['ev-012']);
  });
  it('section counts and search (accent-folded, contact emails)', () => {
    const rows = buildAccountRows(accounts, index);
    expect(sectionCounts(rows)).toEqual({ all: 9, firm: 2, internal: 5, solo: 2 });
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'zoe nguyen' }).map((r) => r.account.id)).toEqual([
      'kowhai-partners',
    ]);
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'grace@saltbush' })).toHaveLength(1);
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, query: 'NETSUITE close' }).map((r) => r.account.id)).toContain('northwind-payroll');
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, status: 'meeting' }).map((r) => r.account.id)).toEqual([
      'northwind-payroll',
    ]);
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, minSignal: 4 }).length).toBe(3);
    expect(filterAccountRows(rows, { ...DEFAULT_ACCOUNT_FILTERS, hasEmail: 'no' }).map((r) => r.account.id).sort()).toEqual([
      'harbourline-ventures',
      'outback-gear',
      'zephyr-logistics',
    ]);
  });
  it('contact rows + filters', () => {
    const rows = buildContactRows(accounts, index);
    expect(rows.length).toBe(accounts.reduce((n, a) => n + a.contacts.length, 0));
    expect(filterContactRows(rows, { ...DEFAULT_CONTACT_FILTERS, section: 'firm' }).length).toBe(5);
    expect(filterContactRows(rows, { ...DEFAULT_CONTACT_FILTERS, emailRisk: 'caution' }).length).toBe(4);
  });
  it('dashboard numbers for fixtures', () => {
    const s = computeDashboardStats({ accounts, events: mergeEvents(outreach.events, []), range: 'all', now: Date.parse('2026-11-22T12:00:00Z') });
    expect(s.sent).toBe(11);
    expect(s.replies).toBe(2);
    expect(s.meetings).toBe(1);
    expect(s.seen).toBe(2);
  });
});

describe('sorting helpers', () => {
  it('empty values last in both directions', () => {
    const vals = [3, null, 1, undefined, 2];
    expect([...vals].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual([1, 2, 3, null, undefined]);
    expect([...vals].sort((a, b) => compareSortValues(a, b, 'desc')).slice(0, 3)).toEqual([3, 2, 1]);
    expect(['b', '', 'a'].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual(['a', 'b', '']);
  });
  it('parses numbers from text', () => {
    expect(leadingNumber('1,200 staff')).toBe(1200);
    expect(leadingNumber('51-200')).toBe(51);
    expect(leadingNumber(undefined)).toBeNull();
    expect(moneyValue('A$35M')).toBe(35e6);
    expect(moneyValue('~A$6–8M')).toBe(6);
    expect(moneyValue('$500k')).toBe(500e3);
    expect(moneyValue('Bootstrapped')).toBeNull();
  });
});
