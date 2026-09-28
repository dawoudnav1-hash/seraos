import { describe, expect, it } from 'vitest';
import type { Txn } from '@/lib/engine/types';
import {
  agingBucket,
  normalizeIdentifier,
  normalizeText,
  reconcile,
  referenceSimilarity,
} from '@/lib/engine/matching';
import {
  bankVsGl,
  creditCardVsGl,
  glVsSubledger,
  reconciliationSummary,
  stripePayoutsVsBank,
} from '@/lib/engine/reconcile';

/** Minimal txn builder — every test supplies only the fields it cares about. */
function mkTxn(id: string, date: string, amountCents: number, opts: Partial<Omit<Txn, 'id' | 'date' | 'amountCents'>> = {}, system = 'test'): Txn {
  return {
    id,
    date,
    amountCents,
    description: opts.description ?? id,
    reference: opts.reference,
    counterparty: opts.counterparty,
    account: opts.account,
    currency: opts.currency,
    source: { system, id },
  };
}

describe('normalization', () => {
  it('strips prefixes, punctuation and leading zeros from identifiers', () => {
    expect(normalizeIdentifier('CHK-001042')).toBe('1042');
    expect(normalizeIdentifier('0001042')).toBe('1042');
    expect(normalizeIdentifier('  chk# 001042  ')).toBe('1042');
    expect(normalizeIdentifier(undefined)).toBe('');
  });

  it('lowercases, strips punctuation and collapses whitespace in text', () => {
    expect(normalizeText('  Best Buy -- Laptop!!  ')).toBe('best buy laptop');
    expect(normalizeText(undefined)).toBe('');
  });

  it('reference similarity is 1 for identical normalized text and 0 when one side is empty', () => {
    expect(referenceSimilarity('Acme Corp', 'ACME CORP')).toBe(1);
    expect(referenceSimilarity('Acme Corp', '')).toBe(0);
  });
});

describe('aging buckets', () => {
  const asOf = '2026-06-30';
  it.each([
    ['2026-06-30', 'Current'],
    ['2026-06-15', '1-30'],
    ['2026-05-15', '31-60'],
    ['2026-04-15', '61-90'],
    ['2026-01-15', '91-180'],
    ['2025-08-01', '181-365'],
    ['2024-01-01', '365+'],
  ] as const)('buckets %s relative to asOf as %s', (date, bucket) => {
    expect(agingBucket(date, asOf)).toBe(bucket);
  });
});

describe('reconcile — matching strategies', () => {
  it('strategy 1: matches on exact normalized identifier regardless of date', () => {
    const a = [mkTxn('A1', '2026-01-05', 10000, { reference: 'CHK-001042', description: 'Vendor payment' })];
    const b = [mkTxn('B1', '2026-01-07', 10000, { reference: '0001042', description: 'Vendor payment' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ matchType: 'one_to_one', sourceAIds: ['A1'], sourceBIds: ['B1'], confidence: 100, matchingBasis: ['exact_identifier'] });
    expect(result.exceptions).toHaveLength(0);
  });

  it('strategy 2: matches on exact amount + same date when identifiers differ', () => {
    const a = [mkTxn('A2', '2026-01-10', 5000, { description: 'Office supplies', reference: 'XYZ1' })];
    const b = [mkTxn('B2', '2026-01-10', 5000, { description: 'Office supplies purchase', reference: 'ABC2' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches[0]).toMatchObject({ matchType: 'one_to_one', confidence: 95, matchingBasis: ['exact_amount_date'] });
  });

  it('strategy 6: matches on reference similarity when amount and date both differ slightly', () => {
    const a = [mkTxn('A3', '2026-01-15', 7500, { reference: 'INV-2026-00551', description: 'Consulting fee' })];
    const b = [mkTxn('B3', '2026-01-20', 7499, { reference: 'INV-2026-0551', description: 'Consulting services' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchingBasis).toEqual(['reference_similarity']);
    expect(result.matches[0].confidence).toBe(90);
    expect(result.matches[0].variance.amount).toBe(1);
  });

  it('strategy 8: one-to-many group aggregation — one A record against a subset sum of B', () => {
    const a = [mkTxn('A4', '2026-02-01', 30000, { description: 'Payroll batch', reference: 'PR-0298' })];
    const b = [
      mkTxn('B4a', '2026-02-01', 10000, { description: 'Payroll dept 1' }),
      mkTxn('B4b', '2026-02-02', 10000, { description: 'Payroll dept 2' }),
      mkTxn('B4c', '2026-02-03', 10000, { description: 'Payroll dept 3' }),
    ];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0];
    expect(m.matchType).toBe('one_to_many');
    expect(m.sourceAIds).toEqual(['A4']);
    expect(m.sourceBIds).toEqual(['B4a', 'B4b', 'B4c']);
    expect(m.matchingBasis).toEqual(['group_aggregation']);
    expect(result.exceptions).toHaveLength(0);
  });

  it('strategy 8: many-to-one group aggregation — many A records against one B record', () => {
    const a = [
      mkTxn('A5a', '2026-03-01', 15000, { description: 'Client payment partial 1' }),
      mkTxn('A5b', '2026-03-02', 15000, { description: 'Client payment partial 2' }),
    ];
    const b = [mkTxn('B5', '2026-03-03', 30000, { description: 'Deposit batch', reference: 'DEP-77' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0];
    expect(m.matchType).toBe('many_to_one');
    expect(m.sourceAIds).toEqual(['A5a', 'A5b']);
    expect(m.sourceBIds).toEqual(['B5']);
  });

  it('never uses a record in more than one match', () => {
    // A5a/A5b could each be tried against B5 individually before the group
    // pass; assert every id from every match is unique across the run.
    const a = [
      mkTxn('A5a', '2026-03-01', 15000),
      mkTxn('A5b', '2026-03-02', 15000),
      mkTxn('A5c', '2026-03-02', 15000),
    ];
    const b = [mkTxn('B5', '2026-03-03', 30000)];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    const usedA = result.matches.flatMap((m) => m.sourceAIds);
    const usedB = result.matches.flatMap((m) => m.sourceBIds);
    expect(new Set(usedA).size).toBe(usedA.length);
    expect(new Set(usedB).size).toBe(usedB.length);
    expect(result.validation.noDuplicateUse).toBe(true);
  });

  it('accounts for every input id exactly once across matches and exceptions', () => {
    const a = [mkTxn('A1', '2026-01-05', 10000, { reference: 'CHK-1' }), mkTxn('A2', '2026-01-06', 4000)];
    const b = [mkTxn('B1', '2026-01-05', 10000, { reference: 'CHK-1' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.validation.totalsVerified).toBe(true);
    expect(result.validation.mathVerified).toBe(true);
    expect(result.validation.auditTrailComplete).toBe(true);
    const accounted = new Set([...result.matches.flatMap((m) => [...m.sourceAIds, ...m.sourceBIds]), ...result.exceptions.map((e) => e.id)]);
    expect(accounted).toEqual(new Set(['A1', 'A2', 'B1']));
  });
});

describe('reconcile — duplicates', () => {
  it('finds duplicates on one side by matching normalized reference', () => {
    const b = [
      mkTxn('B6a', '2026-04-01', 2000, { reference: 'DUP-100', description: 'dup test' }),
      mkTxn('B6b', '2026-04-01', 2000, { reference: 'DUP-100', description: 'dup test 2' }),
    ];
    const result = reconcile([], b, 'bank_vs_gl', 'USD');
    expect(result.duplicates).toContainEqual({ side: 'B', ids: ['B6a', 'B6b'], amountCents: 2000, confidence: 0.95, reason: 'same_reference' });
  });

  it('finds duplicates on one side by amount + counterparty + date window when no reference is present', () => {
    const a = [
      mkTxn('A7a', '2026-05-01', 5500, { counterparty: 'Acme Corp' }),
      mkTxn('A7b', '2026-05-02', 5500, { counterparty: 'Acme Corp' }),
    ];
    const result = reconcile(a, [], 'bank_vs_gl', 'USD');
    expect(result.duplicates).toContainEqual({ side: 'A', ids: ['A7a', 'A7b'], amountCents: 5500, confidence: 0.8, reason: 'same_amount_counterparty_date_window' });
  });
});

describe('reconcile — exception categories', () => {
  it('Missing from Source B: a record with no counterpart at all, but with reference evidence', () => {
    const a = [mkTxn('MFB1', '2026-01-01', 9999, { reference: 'REF-1' })];
    const result = reconcile(a, [], 'bank_vs_gl', 'USD');
    expect(result.exceptions[0]).toMatchObject({ id: 'MFB1', side: 'A', category: 'Missing from Source B' });
  });

  it('Missing from Source A: a record with no counterpart at all, but with reference evidence', () => {
    const b = [mkTxn('MFA1', '2026-01-01', 9999, { reference: 'REF-2' })];
    const result = reconcile([], b, 'bank_vs_gl', 'USD');
    expect(result.exceptions[0]).toMatchObject({ id: 'MFA1', side: 'B', category: 'Missing from Source A' });
  });

  it('Insufficient Evidence: a leftover record with neither reference nor counterparty', () => {
    const a = [mkTxn('IE1', '2026-12-01', 333, { description: 'misc adjustment' })];
    const result = reconcile(a, [], 'bank_vs_gl', 'USD');
    expect(result.exceptions[0]).toMatchObject({ id: 'IE1', category: 'Insufficient Evidence' });
  });

  it('Currency Difference: same amount, mismatched currency, too far apart to auto-match', () => {
    const a = [mkTxn('ACUR', '2026-07-01', 100000, { currency: 'USD', description: 'Domestic wire payment' })];
    const b = [mkTxn('BCUR', '2026-07-20', 100000, { currency: 'EUR', description: 'International deposit conversion' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(0);
    expect(result.exceptions.find((e) => e.id === 'ACUR')).toMatchObject({ category: 'Currency Difference' });
    expect(result.exceptions.find((e) => e.id === 'BCUR')).toMatchObject({ category: 'Currency Difference' });
  });

  it('Date Difference: the leftover of a same-amount pair, once its twin matched a different date', () => {
    const a = [
      mkTxn('DA1', '2026-09-01', 8800, { reference: 'PO-4471' }),
      mkTxn('DA2', '2026-09-15', 8800, { description: 'unrelated widget order' }),
    ];
    const b = [mkTxn('DB1', '2026-09-01', 8800, { reference: 'PO-4471' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sourceAIds).toEqual(['DA1']);
    expect(result.exceptions.find((e) => e.id === 'DA2')).toMatchObject({ category: 'Date Difference' });
  });

  it('Reference Mismatch: the leftover of a same-amount, same-date pair, once its twin matched by reference', () => {
    const a = [
      mkTxn('RA1', '2026-10-01', 15500, { reference: 'INV-9001' }),
      mkTxn('RA2', '2026-10-01', 15500, { reference: 'INV-XYZZY', description: 'separate charge' }),
    ];
    const b = [mkTxn('RB1', '2026-10-01', 15500, { reference: 'INV-9001' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    expect(result.exceptions.find((e) => e.id === 'RA2')).toMatchObject({ category: 'Reference Mismatch' });
  });

  it('Manual Review Required: an exact duplicate that loses the 1:1 matching race', () => {
    const a = [
      mkTxn('MA1', '2026-11-01', 6600, { reference: 'CHK-3009' }),
      mkTxn('MA2', '2026-11-01', 6600, { reference: 'CHK-3009' }),
    ];
    const b = [mkTxn('MB1', '2026-11-01', 6600, { reference: 'CHK-3009' })];
    const result = reconcile(a, b, 'bank_vs_gl', 'USD');
    expect(result.matches).toHaveLength(1);
    expect(result.exceptions.find((e) => e.id === 'MA2')).toMatchObject({ category: 'Manual Review Required' });
    expect(result.duplicates).toContainEqual({ side: 'A', ids: ['MA1', 'MA2'], amountCents: 6600, confidence: 0.95, reason: 'same_reference' });
  });
});

describe('reconcile — determinism', () => {
  it('produces identical output for the same input across repeated calls', () => {
    const a = [
      mkTxn('A1', '2026-01-05', 10000, { reference: 'CHK-1' }),
      mkTxn('A2', '2026-01-06', 4000, { description: 'foo bar' }),
      mkTxn('A3', '2026-02-01', 30000, { description: 'Payroll batch' }),
    ];
    const b = [
      mkTxn('B1', '2026-01-05', 10000, { reference: 'CHK-1' }),
      mkTxn('B2', '2026-02-01', 10000, { description: 'Payroll dept 1' }),
      mkTxn('B3', '2026-02-02', 10000, { description: 'Payroll dept 2' }),
      mkTxn('B4', '2026-02-03', 10000, { description: 'Payroll dept 3' }),
    ];
    const first = reconcile(a, b, 'bank_vs_gl', 'USD');
    const second = reconcile(structuredClone(a), structuredClone(b), 'bank_vs_gl', 'USD');
    expect(second).toEqual(first);
  });
});

describe('reconcile.ts — named configurations', () => {
  it('bankVsGl reconciles a simple bank line against a GL line', () => {
    const result = bankVsGl(
      [mkTxn('BANK1', '2026-01-05', 12500, { reference: 'CHK-9981' }, 'bank')],
      [mkTxn('GL1', '2026-01-05', 12500, { reference: '009981' }, 'gl')],
      'USD',
    );
    expect(result.summary.status).toBe('reconciled');
    expect(result.matches[0].confidence).toBe(100);
  });

  it('creditCardVsGl allows a wider date tolerance for statement posting lag', () => {
    const result = creditCardVsGl(
      [mkTxn('CC1', '2026-01-10', 4599, {}, 'card')],
      [mkTxn('GL2', '2026-01-14', 4599, {}, 'gl')],
      'USD',
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchingBasis).toEqual(['amount_date_tolerance']);
  });

  it('glVsSubledger ties out GL detail to subledger detail exactly', () => {
    const result = glVsSubledger(
      [mkTxn('GL3', '2026-01-01', 250000, { reference: 'AR-001' }, 'gl')],
      [mkTxn('SL1', '2026-01-01', 250000, { reference: 'AR-001' }, 'subledger')],
      'USD',
    );
    expect(result.summary.reconciliationType).toBe('gl_vs_subledger');
    expect(result.matches[0].confidence).toBe(100);
  });

  it('stripePayoutsVsBank: a payout equals charges minus fees minus refunds, matched many-to-one, fees classified as Bank Fee', () => {
    // Gross charges 50000 + 20000, minus a 2050 fee and a 5000 refund nets to
    // 62950 — the exact bank deposit amount.
    const stripeTxns = [
      mkTxn('CH1', '2026-01-02', 50000, { description: 'charge' }, 'stripe'),
      mkTxn('CH2', '2026-01-02', 20000, { description: 'charge' }, 'stripe'),
      mkTxn('FEE1', '2026-01-02', -2050, { description: 'stripe fee' }, 'stripe'),
      mkTxn('RF1', '2026-01-02', -5000, { description: 'refund' }, 'stripe'),
    ];
    const bankTxns = [mkTxn('DEP1', '2026-01-04', 62950, { description: 'Stripe payout' }, 'bank')];
    const result = stripePayoutsVsBank(stripeTxns, bankTxns, 'USD');
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0];
    expect(m.matchType).toBe('many_to_one');
    expect(m.sourceAIds.sort()).toEqual(['CH1', 'CH2', 'FEE1', 'RF1']);
    expect(m.variance.category).toBe('Bank Fee');
    expect(result.metrics.bankFeeVariance).toBeGreaterThan(0);
  });
});

describe('reconciliationSummary', () => {
  it('reconciles to zero once deposits in transit and outstanding checks are applied', () => {
    // Book side (A = GL) has one item the bank hasn't cleared yet (a deposit in
    // transit) and one outstanding check; the bank side (B) has one fee the
    // books haven't recorded. Everything else matches exactly.
    const gl = [
      mkTxn('GL-DEP', '2026-01-30', 50000, { description: 'Deposit not yet cleared', reference: 'DEP-INTRANSIT-1' }, 'gl'),
      mkTxn('GL-CHK', '2026-01-28', -12000, { description: 'Outstanding check 4471', reference: 'CHK-4471' }, 'gl'),
      mkTxn('GL-M1', '2026-01-15', 30000, { reference: 'REF-M1' }, 'gl'),
    ];
    const bank = [
      mkTxn('BANK-M1', '2026-01-15', 30000, { reference: 'REF-M1' }, 'bank'),
      mkTxn('BANK-FEE', '2026-01-31', -1500, { description: 'Monthly service fee', reference: 'FEE-JAN26' }, 'bank'),
    ];
    const result = bankVsGl(gl, bank, 'USD');
    // glBalance and statementBalance are constructed so that the unmatched
    // items are exactly what separates them: statement = gl - deposit-in-transit
    // + outstanding-check + bank-only fee.
    const glBalance = 500000;
    const statementBalance = glBalance - 50000 + 12000 - 1500;
    const summary = reconciliationSummary(result, { glBalance, statementBalance });
    expect(summary.depositsInTransitCents).toBe(50000);
    expect(summary.outstandingChecksCents).toBe(12000);
    expect(summary.adjustedBankBalanceCents).toBe(summary.adjustedBookBalanceCents);
    expect(summary.differenceCents).toBe(0);
    expect(summary.reconciles).toBe(true);
  });

  it('does not reconcile when an item is left unexplained', () => {
    const gl = [mkTxn('GL-A', '2026-01-01', 1000, { reference: 'REF-A' }, 'gl')];
    const bank = [mkTxn('BANK-A', '2026-01-01', 1000, { reference: 'REF-A' }, 'bank')];
    const result = bankVsGl(gl, bank, 'USD');
    const summary = reconciliationSummary(result, { glBalance: 500000, statementBalance: 499000 });
    expect(summary.reconciles).toBe(false);
    expect(summary.differenceCents).not.toBe(0);
  });
});
