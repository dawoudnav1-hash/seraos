// Invariants that must hold for whatever the pipeline drops into src/data (no exact numbers —
// the data is regenerated). Guards against contract drift breaking the app silently.
import { describe, expect, it } from 'vitest';
import accountsRaw from '../data/accounts.json';
import outreachRaw from '../data/outreach.json';
import { normalizeAccounts, normalizeOutreach } from './data';
import { buildAccountRows, buildContactRows, sectionCounts } from './filters';
import { computeDashboardStats } from './stats';
import { buildEventIndex } from './status';

describe('generated data in src/data', () => {
  const a = normalizeAccounts(accountsRaw);
  const o = normalizeOutreach(outreachRaw);

  it('matches the contract without normalisation warnings', () => {
    expect(a.warnings).toEqual([]);
    expect(o.warnings).toEqual([]);
    expect(a.accounts.length).toBe((accountsRaw as unknown[]).length);
  });

  it('has unique account and contact ids', () => {
    const contactIds = a.accounts.flatMap((x) => x.contacts.map((c) => c.id));
    expect(new Set(contactIds).size).toBe(contactIds.length);
    expect(new Set(a.accounts.map((x) => x.id)).size).toBe(a.accounts.length);
  });

  it('section counts add up and every stat is computable', () => {
    const index = buildEventIndex(a.accounts, o.outreach.events);
    const counts = sectionCounts(buildAccountRows(a.accounts, index));
    expect(counts.firm + counts.services + counts.internal + counts.solo).toBe(counts.all);
    expect(buildContactRows(a.accounts, index).length).toBe(a.accounts.reduce((n, x) => n + x.contacts.length, 0));
    for (const range of ['7d', '30d', '90d', 'all'] as const) {
      const s = computeDashboardStats({ accounts: a.accounts, events: o.outreach.events, range, now: Date.now() });
      expect(s.sent).toBeGreaterThanOrEqual(0);
      expect(s.accountsTouched).toBeLessThanOrEqual(s.totalAccounts);
      expect(s.contactsReached).toBeLessThanOrEqual(s.totalContacts);
      expect(s.funnel.map((f) => f.count)).toEqual([...s.funnel.map((f) => f.count)].sort((x, y) => y - x));
      // By-city rows partition the accounts and the matched events
      for (const k of ['accounts', 'contacts', 'accountsContacted', 'accountsNotContacted', 'sent', 'replies', 'meetings'] as const) {
        expect(s.byCity.reduce((n, r) => n + r[k], 0)).toBe(s.byCityTotal[k]);
      }
      expect(s.byCityTotal.accounts).toBe(s.totalAccounts);
    }
  });
});
