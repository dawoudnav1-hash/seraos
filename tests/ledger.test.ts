import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_MIGRATIONS } from '@/lib/ledger/ddl';
import { importManual } from '@/lib/ledger/import';
import {
  balancesByPeriod,
  bankTransactions,
  chartOfAccounts,
  closePeriod,
  contactSpend,
  generalLedger,
  ledgerTxnsForAccount,
  openDocuments,
  periodStatus,
  recomputeBalances,
  trialBalance,
} from '@/lib/ledger/repository';
import * as schema from '@/lib/ledger/schema';
import { InMemoryLedgerSink, PostgresLedgerSink, type LedgerDb } from '@/lib/ledger/sink';
import {
  UnbalancedEntryError,
  UnknownReferenceError,
  type WhAccount,
  type WhBankTxn,
  type WhCompany,
  type WhContact,
  type WhDocument,
  type WhEntry,
} from '@/lib/ledger/types';

async function freshDb(): Promise<{ pg: PGlite; db: LedgerDb }> {
  const pg = new PGlite();
  for (const m of LEDGER_MIGRATIONS) await pg.exec(m.sql);
  const db = drizzle(pg, { schema }) as unknown as LedgerDb;
  return { pg, db };
}

function company(overrides: Partial<WhCompany> = {}): WhCompany {
  return {
    id: 'co-1',
    client: 'acme-co',
    provider: 'quickbooks',
    externalId: 'qbo-1',
    name: 'Acme Inc',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    ...overrides,
  };
}

function account(externalId: string, overrides: Partial<WhAccount> = {}): WhAccount {
  return {
    externalId,
    code: null,
    name: `Account ${externalId}`,
    providerType: 'Bank',
    providerSubtype: null,
    currency: 'USD',
    active: true,
    parentExternalId: null,
    currentBalanceCents: null,
    updatedAt: null,
    ...overrides,
  };
}

function contact(externalId: string, overrides: Partial<WhContact> = {}): WhContact {
  return {
    externalId,
    kind: 'vendor',
    name: `Contact ${externalId}`,
    email: null,
    active: true,
    ...overrides,
  };
}

function entry(externalId: string, overrides: Partial<WhEntry> = {}): WhEntry {
  return {
    externalId,
    sourceType: 'journal_entry',
    number: null,
    date: '2026-01-15',
    memo: null,
    currency: 'USD',
    status: 'posted',
    updatedAt: null,
    lines: [],
    ...overrides,
  };
}

/** Standard chart: 1000 Bank (asset), 4000 Revenue, 5000 Expense/AP-ish accounts. */
const CHART = [
  account('1000', { name: 'Checking', providerType: 'Bank' }),
  account('4000', { name: 'Revenue', providerType: 'Income' }),
  account('5000', { name: 'Expense', providerType: 'Expense' }),
];

describe('lib/ledger DDL', () => {
  it('applies twice without error (idempotent CREATE TABLE/INDEX)', async () => {
    const { pg } = await freshDb();
    for (const m of LEDGER_MIGRATIONS) await pg.exec(m.sql);
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ledger_%'`,
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(
      [
        'ledger_account_balances',
        'ledger_accounts',
        'ledger_bank_transactions',
        'ledger_companies',
        'ledger_contacts',
        'ledger_documents',
        'ledger_entries',
        'ledger_lines',
        'ledger_periods',
        'ledger_sync_state',
      ].sort(),
    );
  });
});

describe('PostgresLedgerSink — upserts are idempotent', () => {
  let db: LedgerDb;
  let sink: PostgresLedgerSink;

  beforeEach(async () => {
    ({ db } = await freshDb());
    sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
  });

  it('upsertCompany: same id twice updates in place, one row', async () => {
    await sink.upsertCompany(company({ name: 'Acme Inc (renamed)' }));
    const rows = await db.select().from(schema.ledgerCompanies);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme Inc (renamed)');
  });

  it('upsertAccounts: same externalId twice → one row, updated fields', async () => {
    await sink.upsertAccounts('co-1', [account('1000', { name: 'Checking' })]);
    await sink.upsertAccounts('co-1', [account('1000', { name: 'Checking (renamed)', code: '1000' })]);
    const rows = await db.select().from(schema.ledgerAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Checking (renamed)');
    expect(rows[0].code).toBe('1000');
    expect(rows[0].provider).toBe('quickbooks');
  });

  it('upsertContacts: same externalId twice → one row, updated fields', async () => {
    await sink.upsertContacts('co-1', [contact('v1', { name: 'Vendor One' })]);
    await sink.upsertContacts('co-1', [contact('v1', { name: 'Vendor One LLC' })]);
    const rows = await db.select().from(schema.ledgerContacts);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Vendor One LLC');
  });

  it('resolves parentExternalId to an internal parentAccountId, even when the parent appears later in the same batch', async () => {
    await sink.upsertAccounts('co-1', [
      account('1010', { name: 'Checking Sub', parentExternalId: '1000' }),
      account('1000', { name: 'Checking Parent' }),
    ]);
    const rows = await db.select().from(schema.ledgerAccounts);
    const parent = rows.find((r) => r.externalId === '1000')!;
    const child = rows.find((r) => r.externalId === '1010')!;
    expect(child.parentAccountId).toBe(parent.id);
  });

  it('infers class/normalBalance from providerType', async () => {
    await sink.upsertAccounts('co-1', CHART);
    const rows = await db.select().from(schema.ledgerAccounts);
    const bank = rows.find((r) => r.externalId === '1000')!;
    const revenue = rows.find((r) => r.externalId === '4000')!;
    const expense = rows.find((r) => r.externalId === '5000')!;
    expect([bank.class, bank.normalBalance]).toEqual(['asset', 'debit']);
    expect([revenue.class, revenue.normalBalance]).toEqual(['revenue', 'credit']);
    expect([expense.class, expense.normalBalance]).toEqual(['expense', 'debit']);
  });
});

describe('PostgresLedgerSink — entries and lines', () => {
  let db: LedgerDb;
  let sink: PostgresLedgerSink;

  beforeEach(async () => {
    ({ db } = await freshDb());
    sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    await sink.upsertAccounts('co-1', CHART);
    await sink.upsertContacts('co-1', [contact('v1')]);
  });

  it('refuses an entry whose lines do not balance, and writes nothing for it', async () => {
    const bad = entry('je-1', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 100, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: null, debitCents: 0, creditCents: 50, dimensions: {} },
      ],
    });
    await expect(sink.upsertEntries('co-1', [bad])).rejects.toBeInstanceOf(UnbalancedEntryError);
    const rows = await db.select().from(schema.ledgerEntries);
    expect(rows).toHaveLength(0);
  });

  it('refuses a batch if any entry in it is unbalanced, leaving the good entries unwritten too', async () => {
    const good = entry('je-good', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 100, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: null, debitCents: 0, creditCents: 100, dimensions: {} },
      ],
    });
    const bad = entry('je-bad', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 10, creditCents: 0, dimensions: {} },
      ],
    });
    await expect(sink.upsertEntries('co-1', [good, bad])).rejects.toBeInstanceOf(UnbalancedEntryError);
    const rows = await db.select().from(schema.ledgerEntries);
    expect(rows).toHaveLength(0);
  });

  it('refuses an entry that references an unknown account', async () => {
    const bad = entry('je-1', {
      lines: [
        { lineNo: 1, accountExternalId: 'nope', contactExternalId: null, description: null, debitCents: 100, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: null, debitCents: 0, creditCents: 100, dimensions: {} },
      ],
    });
    await expect(sink.upsertEntries('co-1', [bad])).rejects.toBeInstanceOf(UnknownReferenceError);
  });

  it('upserting the same entry externalId twice replaces its lines rather than accumulating them', async () => {
    const v1 = entry('je-1', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: 'v1', debitCents: 100, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: 'v1', debitCents: 0, creditCents: 100, dimensions: {} },
      ],
    });
    await sink.upsertEntries('co-1', [v1]);
    const v2 = entry('je-1', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: 'v1', description: 'v2', debitCents: 250, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '5000', contactExternalId: 'v1', description: 'v2', debitCents: 0, creditCents: 250, dimensions: {} },
      ],
    });
    await sink.upsertEntries('co-1', [v2]);

    const entryRows = await db.select().from(schema.ledgerEntries);
    expect(entryRows).toHaveLength(1);
    const lineRows = await db.select().from(schema.ledgerLines);
    expect(lineRows).toHaveLength(2);
    expect(lineRows.every((l) => l.description === 'v2')).toBe(true);
    expect(lineRows.map((l) => l.debitCents).sort()).toEqual([0, 250]);
  });
});

describe('repository reads', () => {
  let db: LedgerDb;
  let sink: PostgresLedgerSink;

  beforeEach(async () => {
    ({ db } = await freshDb());
    sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    await sink.upsertAccounts('co-1', CHART);
    await sink.upsertEntries('co-1', [
      entry('je-jan', {
        date: '2026-01-10',
        lines: [
          { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: 'deposit', debitCents: 100_000, creditCents: 0, dimensions: {} },
          { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: 'sale', debitCents: 0, creditCents: 100_000, dimensions: {} },
        ],
      }),
      entry('je-feb', {
        date: '2026-02-05',
        lines: [
          { lineNo: 1, accountExternalId: '5000', contactExternalId: null, description: 'rent', debitCents: 20_000, creditCents: 0, dimensions: {} },
          { lineNo: 2, accountExternalId: '1000', contactExternalId: null, description: 'rent paid', debitCents: 0, creditCents: 20_000, dimensions: {} },
        ],
      }),
    ]);
  });

  it('chartOfAccounts returns every account with a SourceRef', async () => {
    const rows = await chartOfAccounts(db, 'co-1');
    expect(rows).toHaveLength(3);
    const bank = rows.find((r) => r.externalId === '1000')!;
    expect(bank.source).toEqual({ system: 'quickbooks', id: '1000', label: 'Checking' });
  });

  it('trialBalance totals debits and credits equal, and as-of a date excludes later activity', async () => {
    const tb = await trialBalance(db, 'co-1', '2026-12-31');
    expect(tb.totalDebitCents).toBe(tb.totalCreditCents);
    expect(tb.balanced).toBe(true);
    const bank = tb.rows.find((r) => r.code === null && r.name === 'Checking')!;
    expect(bank.netCents).toBe(100_000 - 20_000);

    const janOnly = await trialBalance(db, 'co-1', '2026-01-31');
    expect(janOnly.totalDebitCents).toBe(100_000);
    expect(janOnly.totalDebitCents).toBe(janOnly.totalCreditCents);
  });

  it('generalLedger returns lines in date order with a running balance per account', async () => {
    const all = await generalLedger(db, 'co-1', {});
    expect(all.length).toBe(4); // 2 lines per entry, 2 entries
    // Running balance on the bank account: +100000, then -20000 = 80000.
    const bankRows = all
      .filter((l) => l.description === 'deposit' || l.description === 'rent paid')
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(bankRows.map((l) => l.runningBalanceCents)).toEqual([100_000, 80_000]);
  });

  it('generalLedger filters by from/to and accountIds', async () => {
    const accounts = await chartOfAccounts(db, 'co-1');
    const bankId = accounts.find((a) => a.externalId === '1000')!.id;
    const rows = await generalLedger(db, 'co-1', { accountIds: [bankId], from: '2026-02-01', to: '2026-02-28' });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('rent paid');
  });

  it('recomputeBalances materializes ledger_account_balances (opening+debits-credits=closing) across periods', async () => {
    const written = await recomputeBalances(db, 'co-1', '2026-01');
    expect(written).toBeGreaterThan(0);
    const accounts = await chartOfAccounts(db, 'co-1');
    const bankId = accounts.find((a) => a.externalId === '1000')!.id;
    const periods = await balancesByPeriod(db, 'co-1', bankId, 12);
    expect(periods.map((p) => p.period)).toEqual(['2026-01', '2026-02']);
    expect(periods[0]).toMatchObject({ openingCents: 0, debitsCents: 100_000, creditsCents: 0, closingCents: 100_000 });
    expect(periods[1]).toMatchObject({ openingCents: 100_000, debitsCents: 0, creditsCents: 20_000, closingCents: 80_000 });
  });

  it('balancesByPeriod returns only the trailing N periods, ascending', async () => {
    await recomputeBalances(db, 'co-1', '2026-01');
    const accounts = await chartOfAccounts(db, 'co-1');
    const bankId = accounts.find((a) => a.externalId === '1000')!.id;
    const lastOne = await balancesByPeriod(db, 'co-1', bankId, 1);
    expect(lastOne).toHaveLength(1);
    expect(lastOne[0].period).toBe('2026-02');
  });
});

describe('bank transactions and bank rec', () => {
  let db: LedgerDb;
  let sink: PostgresLedgerSink;

  beforeEach(async () => {
    ({ db } = await freshDb());
    sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    await sink.upsertAccounts('co-1', CHART);
  });

  it('bankTransactions returns rows as Txn[] with a SourceRef, filterable by status', async () => {
    const rows: WhBankTxn[] = [
      { externalId: 'bt-1', bankAccountExternalId: '1000', date: '2026-01-05', amountCents: 5_000, description: 'Stripe payout', counterparty: 'Stripe', reference: null, status: 'unreviewed', categoryAccountExternalId: null },
      { externalId: 'bt-2', bankAccountExternalId: '1000', date: '2026-01-06', amountCents: -2_000, description: 'AWS', counterparty: 'AWS', reference: null, status: 'categorized', categoryAccountExternalId: '5000' },
    ];
    await sink.upsertBankTransactions('co-1', rows);

    const all = await bankTransactions(db, 'co-1', {});
    expect(all).toHaveLength(2);
    expect(all[0].source).toEqual({ system: 'quickbooks', id: 'bt-1', label: 'Stripe payout' });
    expect(all[0].amountCents).toBe(5_000);

    const categorized = await bankTransactions(db, 'co-1', { status: 'categorized' });
    expect(categorized.map((t) => t.id)).toHaveLength(1);
  });

  it('ledgerTxnsForAccount returns the GL side of a bank rec as signed Txn amounts', async () => {
    await sink.upsertEntries('co-1', [
      entry('je-1', {
        date: '2026-01-05',
        lines: [
          { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: 'deposit', debitCents: 5_000, creditCents: 0, dimensions: {} },
          { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: 'sale', debitCents: 0, creditCents: 5_000, dimensions: {} },
        ],
      }),
    ]);
    const accounts = await chartOfAccounts(db, 'co-1');
    const bankId = accounts.find((a) => a.externalId === '1000')!.id;
    const glSide = await ledgerTxnsForAccount(db, 'co-1', bankId, { from: '2026-01-01', to: '2026-01-31' });
    expect(glSide).toHaveLength(1);
    expect(glSide[0].amountCents).toBe(5_000);
  });
});

describe('open documents (AR/AP) with aging', () => {
  it('buckets documents by age and totals each bucket', async () => {
    const { db } = await freshDb();
    const sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    await sink.upsertAccounts('co-1', CHART);
    await sink.upsertContacts('co-1', [contact('cust-1', { kind: 'customer' })]);

    const docs: WhDocument[] = [
      { externalId: 'inv-1', kind: 'invoice', contactExternalId: 'cust-1', number: 'INV-1', date: '2026-01-01', dueDate: '2026-01-01', totalCents: 1_000, balanceCents: 1_000, status: 'open', currency: 'USD' },
      { externalId: 'inv-2', kind: 'invoice', contactExternalId: 'cust-1', number: 'INV-2', date: '2025-12-01', dueDate: '2025-12-01', totalCents: 2_000, balanceCents: 2_000, status: 'open', currency: 'USD' },
      { externalId: 'inv-3', kind: 'invoice', contactExternalId: 'cust-1', number: 'INV-3', date: '2026-02-01', dueDate: '2026-02-25', totalCents: 3_000, balanceCents: 0, status: 'paid', currency: 'USD' },
    ];
    await sink.upsertDocuments('co-1', docs);

    const { documents, totalsByBucket } = await openDocuments(db, 'co-1', 'invoice', '2026-02-28');
    // inv-3 has a zero balance and must not appear as "open".
    expect(documents.map((d) => d.externalId).sort()).toEqual(['inv-1', 'inv-2']);
    const inv1 = documents.find((d) => d.externalId === 'inv-1')!; // due 2026-01-01, 58 days old
    const inv2 = documents.find((d) => d.externalId === 'inv-2')!; // due 2025-12-01, 89 days old
    expect(inv1.bucket).toBe('31-60');
    expect(inv2.bucket).toBe('61-90');
    expect(totalsByBucket['31-60']).toBe(1_000);
    expect(totalsByBucket['61-90']).toBe(2_000);
    expect(inv2.ageDays).toBeGreaterThan(inv1.ageDays);
  });
});

describe('contact spend', () => {
  it('aggregates net GL activity per contact, filtered by contact kind and date range', async () => {
    const { db } = await freshDb();
    const sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    await sink.upsertAccounts('co-1', CHART);
    await sink.upsertContacts('co-1', [contact('v1', { kind: 'vendor', name: 'Office Depot' })]);
    await sink.upsertEntries('co-1', [
      entry('bill-1', {
        date: '2026-01-10',
        lines: [
          { lineNo: 1, accountExternalId: '5000', contactExternalId: 'v1', description: 'supplies', debitCents: 4_000, creditCents: 0, dimensions: {} },
          { lineNo: 2, accountExternalId: '1000', contactExternalId: 'v1', description: 'paid', debitCents: 0, creditCents: 4_000, dimensions: {} },
        ],
      }),
    ]);
    const spend = await contactSpend(db, 'co-1', { from: '2026-01-01', to: '2026-01-31' }, 'vendor');
    expect(spend).toHaveLength(1);
    expect(spend[0].name).toBe('Office Depot');
    expect(spend[0].netCents).toBe(0); // debit 4000 (expense) + debit 0 (bank credited) → net across both lines is 0
  });
});

describe('sync cursor', () => {
  it('round-trips: null before the first sync, then the stored cursor after', async () => {
    const { db } = await freshDb();
    const sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());

    expect(await sink.getSyncCursor('co-1', 'accounts')).toBeNull();
    await sink.setSyncCursor('co-1', 'accounts', 'cursor-abc', 3);
    expect(await sink.getSyncCursor('co-1', 'accounts')).toBe('cursor-abc');

    await sink.setSyncCursor('co-1', 'accounts', 'cursor-def', 7);
    expect(await sink.getSyncCursor('co-1', 'accounts')).toBe('cursor-def');
    const rows = await db.select().from(schema.ledgerSyncState);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowsUpserted).toBe(7);
  });
});

describe('period close', () => {
  it('defaults to open, and closePeriod marks it closed', async () => {
    const { db } = await freshDb();
    const sink = new PostgresLedgerSink(db);
    await sink.upsertCompany(company());
    expect(await periodStatus(db, 'co-1', '2026-01')).toBe('open');
    await closePeriod(db, 'co-1', '2026-01');
    expect(await periodStatus(db, 'co-1', '2026-01')).toBe('closed');
  });
});

describe('importManual', () => {
  it('populates a manual company through the sink, and is idempotent on re-import', async () => {
    const { db } = await freshDb();
    const data = {
      accounts: CHART,
      entries: [
        entry('je-1', {
          lines: [
            { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 500, creditCents: 0, dimensions: {} },
            { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: null, debitCents: 0, creditCents: 500, dimensions: {} },
          ],
        }),
      ],
      bankTransactions: [
        { externalId: 'bt-1', bankAccountExternalId: '1000', date: '2026-01-01', amountCents: 500, description: 'seed', counterparty: null, reference: null, status: 'unreviewed', categoryAccountExternalId: null } satisfies WhBankTxn,
      ],
    };
    const first = await importManual(db, { client: 'demo-co', companyName: 'Demo Co' }, data);
    expect(first).toMatchObject({ accounts: 3, entries: 1, bankTransactions: 1 });

    const second = await importManual(db, { client: 'demo-co', companyName: 'Demo Co' }, data);
    expect(second.companyId).toBe(first.companyId);

    const companies = await db.select().from(schema.ledgerCompanies);
    expect(companies).toHaveLength(1);
    expect(companies[0].provider).toBe('manual');
    const tb = await trialBalance(db, first.companyId, '2026-12-31');
    expect(tb.balanced).toBe(true);
  });
});

describe('InMemoryLedgerSink behaves like PostgresLedgerSink on a shared scenario', () => {
  it('produces the same balance behavior for the same fixture, including rejecting unbalanced entries', async () => {
    const { db } = await freshDb();
    const pgSink = new PostgresLedgerSink(db);
    const memSink = new InMemoryLedgerSink();

    for (const sink of [pgSink, memSink]) {
      await sink.upsertCompany(company());
      await sink.upsertAccounts('co-1', CHART);
    }

    const goodEntry = entry('je-1', {
      lines: [
        { lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 750, creditCents: 0, dimensions: {} },
        { lineNo: 2, accountExternalId: '4000', contactExternalId: null, description: null, debitCents: 0, creditCents: 750, dimensions: {} },
      ],
    });
    for (const sink of [pgSink, memSink]) {
      await expect(sink.upsertEntries('co-1', [goodEntry])).resolves.toBe(1);
    }

    const badEntry = entry('je-2', {
      lines: [{ lineNo: 1, accountExternalId: '1000', contactExternalId: null, description: null, debitCents: 10, creditCents: 0, dimensions: {} }],
    });
    for (const sink of [pgSink, memSink]) {
      await expect(sink.upsertEntries('co-1', [badEntry])).rejects.toBeInstanceOf(UnbalancedEntryError);
    }

    const tb = await trialBalance(db, 'co-1', '2026-12-31');
    const memEntries = memSink.listEntries('co-1');
    expect(memEntries).toHaveLength(1); // je-2 was refused in both
    const memDebit = memEntries.flatMap((e) => e.lines).reduce((s, l) => s + l.debitCents, 0);
    expect(memDebit).toBe(tb.totalDebitCents);
  });
});
