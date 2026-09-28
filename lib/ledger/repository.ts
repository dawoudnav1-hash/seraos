/**
 * The read API agents use to answer questions from the warehouse instead of
 * calling QuickBooks/Xero. Every returned row carries a `SourceRef` back to
 * the provider record it came from — "no source, not allowed" applies to
 * reads too. Functions take a Drizzle db instance typed generically so both
 * the PGlite (local/dev) and node-postgres (server) drivers work unchanged.
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { IsoDate, SourceRef, Txn } from '@/lib/engine/types';
import * as schema from './schema';
import type { LedgerDb } from './sink';

function accountRef(provider: string, externalId: string, label?: string): SourceRef {
  return { system: provider, id: externalId, label };
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export interface ChartAccount {
  id: string;
  externalId: string;
  code: string | null;
  name: string;
  providerType: string;
  ontologySubtype: string | null;
  class: string | null;
  normalBalance: 'debit' | 'credit' | null;
  active: boolean;
  parentAccountId: string | null;
  source: SourceRef;
}

export async function chartOfAccounts(db: LedgerDb, companyId: string): Promise<ChartAccount[]> {
  const rows = await db
    .select()
    .from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.companyId, companyId))
    .orderBy(asc(schema.ledgerAccounts.code), asc(schema.ledgerAccounts.name));
  return rows.map((r) => ({
    id: r.id,
    externalId: r.externalId,
    code: r.code,
    name: r.name,
    providerType: r.providerType,
    ontologySubtype: r.ontologySubtype,
    class: r.class,
    normalBalance: r.normalBalance as 'debit' | 'credit' | null,
    active: r.active,
    parentAccountId: r.parentAccountId,
    source: accountRef(r.provider, r.externalId, r.name),
  }));
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountId: string;
  code: string | null;
  name: string;
  class: string | null;
  debitCents: number;
  creditCents: number;
  netCents: number;
  source: SourceRef;
}

export interface TrialBalance {
  asOf: IsoDate;
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
}

export async function trialBalance(db: LedgerDb, companyId: string, asOf: IsoDate): Promise<TrialBalance> {
  const lineSums = db
    .select({
      accountId: schema.ledgerLines.accountId,
      debitCents: sql<number>`sum(${schema.ledgerLines.debitCents})`.as('debit_cents'),
      creditCents: sql<number>`sum(${schema.ledgerLines.creditCents})`.as('credit_cents'),
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .where(and(eq(schema.ledgerEntries.companyId, companyId), lte(schema.ledgerEntries.date, asOf)))
    .groupBy(schema.ledgerLines.accountId)
    .as('line_sums');

  const rows = await db
    .select({
      accountId: schema.ledgerAccounts.id,
      code: schema.ledgerAccounts.code,
      name: schema.ledgerAccounts.name,
      class: schema.ledgerAccounts.class,
      provider: schema.ledgerAccounts.provider,
      externalId: schema.ledgerAccounts.externalId,
      debitCents: sql<number>`coalesce(${lineSums.debitCents}, 0)`,
      creditCents: sql<number>`coalesce(${lineSums.creditCents}, 0)`,
    })
    .from(schema.ledgerAccounts)
    .leftJoin(lineSums, eq(lineSums.accountId, schema.ledgerAccounts.id))
    .where(eq(schema.ledgerAccounts.companyId, companyId))
    .orderBy(asc(schema.ledgerAccounts.code), asc(schema.ledgerAccounts.name));

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  const tbRows: TrialBalanceRow[] = rows.map((r) => {
    const debitCents = Number(r.debitCents);
    const creditCents = Number(r.creditCents);
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;
    return {
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      class: r.class,
      debitCents,
      creditCents,
      netCents: debitCents - creditCents,
      source: accountRef(r.provider, r.externalId, r.name),
    };
  });

  return {
    asOf,
    rows: tbRows,
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
  };
}

// ---------------------------------------------------------------------------
// General ledger
// ---------------------------------------------------------------------------

export interface GeneralLedgerLine {
  entryId: string;
  entryExternalId: string;
  date: IsoDate;
  accountId: string;
  memo: string | null;
  description: string | null;
  debitCents: number;
  creditCents: number;
  runningBalanceCents: number;
  source: SourceRef;
}

export async function generalLedger(
  db: LedgerDb,
  companyId: string,
  opts: { accountIds?: string[]; from?: IsoDate; to?: IsoDate } = {},
): Promise<GeneralLedgerLine[]> {
  const conditions = [eq(schema.ledgerEntries.companyId, companyId)];
  if (opts.accountIds?.length) conditions.push(inArray(schema.ledgerLines.accountId, opts.accountIds));
  if (opts.from) conditions.push(gte(schema.ledgerEntries.date, opts.from));
  if (opts.to) conditions.push(lte(schema.ledgerEntries.date, opts.to));

  const rows = await db
    .select({
      entryId: schema.ledgerEntries.id,
      entryExternalId: schema.ledgerEntries.externalId,
      provider: schema.ledgerEntries.provider,
      date: schema.ledgerEntries.date,
      memo: schema.ledgerEntries.memo,
      accountId: schema.ledgerLines.accountId,
      lineNo: schema.ledgerLines.lineNo,
      description: schema.ledgerLines.description,
      debitCents: schema.ledgerLines.debitCents,
      creditCents: schema.ledgerLines.creditCents,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .where(and(...conditions))
    .orderBy(asc(schema.ledgerLines.accountId), asc(schema.ledgerEntries.date), asc(schema.ledgerLines.lineNo));

  const running = new Map<string, number>();
  return rows.map((r) => {
    const prev = running.get(r.accountId) ?? 0;
    const next = prev + r.debitCents - r.creditCents;
    running.set(r.accountId, next);
    return {
      entryId: r.entryId,
      entryExternalId: r.entryExternalId,
      date: r.date,
      accountId: r.accountId,
      memo: r.memo,
      description: r.description,
      debitCents: r.debitCents,
      creditCents: r.creditCents,
      runningBalanceCents: next,
      source: accountRef(r.provider, r.entryExternalId, r.memo ?? undefined),
    };
  });
}

// ---------------------------------------------------------------------------
// Period balances (feeds flux / reasonableness)
// ---------------------------------------------------------------------------

export interface PeriodBalance {
  period: string;
  openingCents: number;
  debitsCents: number;
  creditsCents: number;
  closingCents: number;
  source: 'computed' | 'provider';
}

export async function balancesByPeriod(
  db: LedgerDb,
  companyId: string,
  accountId: string,
  periods: number,
): Promise<PeriodBalance[]> {
  const rows = await db
    .select()
    .from(schema.ledgerAccountBalances)
    .where(
      and(
        eq(schema.ledgerAccountBalances.companyId, companyId),
        eq(schema.ledgerAccountBalances.accountId, accountId),
      ),
    )
    .orderBy(asc(schema.ledgerAccountBalances.period));
  const tail = rows.slice(Math.max(0, rows.length - periods));
  return tail.map((r) => ({
    period: r.period,
    openingCents: r.openingCents,
    debitsCents: r.debitsCents,
    creditsCents: r.creditsCents,
    closingCents: r.closingCents,
    source: r.source as 'computed' | 'provider',
  }));
}

/** On-demand activity for one account/period, computed straight from lines (no materialization). */
export async function accountActivity(
  db: LedgerDb,
  companyId: string,
  accountId: string,
  period: string,
): Promise<{ period: string; debitsCents: number; creditsCents: number; netCents: number }> {
  const { from, to } = periodRange(period);
  const [row] = await db
    .select({
      debitsCents: sql<number>`coalesce(sum(${schema.ledgerLines.debitCents}), 0)`,
      creditsCents: sql<number>`coalesce(sum(${schema.ledgerLines.creditCents}), 0)`,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .where(
      and(
        eq(schema.ledgerEntries.companyId, companyId),
        eq(schema.ledgerLines.accountId, accountId),
        gte(schema.ledgerEntries.date, from),
        lte(schema.ledgerEntries.date, to),
      ),
    );
  const debitsCents = Number(row?.debitsCents ?? 0);
  const creditsCents = Number(row?.creditsCents ?? 0);
  return { period, debitsCents, creditsCents, netCents: debitsCents - creditsCents };
}

// ---------------------------------------------------------------------------
// Bank rec: bank side and GL side
// ---------------------------------------------------------------------------

export async function bankTransactions(
  db: LedgerDb,
  companyId: string,
  opts: { bankAccountId?: string; status?: string; from?: IsoDate; to?: IsoDate } = {},
): Promise<Txn[]> {
  const conditions = [eq(schema.ledgerBankTransactions.companyId, companyId)];
  if (opts.bankAccountId) conditions.push(eq(schema.ledgerBankTransactions.bankAccountId, opts.bankAccountId));
  if (opts.status) conditions.push(eq(schema.ledgerBankTransactions.status, opts.status));
  if (opts.from) conditions.push(gte(schema.ledgerBankTransactions.date, opts.from));
  if (opts.to) conditions.push(lte(schema.ledgerBankTransactions.date, opts.to));

  const rows = await db
    .select()
    .from(schema.ledgerBankTransactions)
    .where(and(...conditions))
    .orderBy(asc(schema.ledgerBankTransactions.date));

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amountCents,
    description: r.description,
    counterparty: r.counterparty ?? undefined,
    reference: r.reference ?? undefined,
    account: r.bankAccountId,
    source: accountRef(r.provider, r.externalId, r.description),
  }));
}

/** The GL side of a bank rec: an account's lines over a date range, as `Txn`s. */
export async function ledgerTxnsForAccount(
  db: LedgerDb,
  companyId: string,
  accountId: string,
  range: { from: IsoDate; to: IsoDate },
): Promise<Txn[]> {
  const rows = await db
    .select({
      entryId: schema.ledgerEntries.id,
      entryExternalId: schema.ledgerEntries.externalId,
      provider: schema.ledgerEntries.provider,
      date: schema.ledgerEntries.date,
      memo: schema.ledgerEntries.memo,
      description: schema.ledgerLines.description,
      debitCents: schema.ledgerLines.debitCents,
      creditCents: schema.ledgerLines.creditCents,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .where(
      and(
        eq(schema.ledgerEntries.companyId, companyId),
        eq(schema.ledgerLines.accountId, accountId),
        gte(schema.ledgerEntries.date, range.from),
        lte(schema.ledgerEntries.date, range.to),
      ),
    )
    .orderBy(asc(schema.ledgerEntries.date));

  return rows.map((r) => ({
    id: `${r.entryId}`,
    date: r.date,
    amountCents: r.debitCents - r.creditCents,
    description: r.description ?? r.memo ?? '',
    account: accountId,
    source: accountRef(r.provider, r.entryExternalId, r.memo ?? undefined),
  }));
}

// ---------------------------------------------------------------------------
// Open AR/AP with aging
// ---------------------------------------------------------------------------

export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

export interface OpenDocument {
  id: string;
  externalId: string;
  number: string | null;
  contactId: string | null;
  date: IsoDate;
  dueDate: IsoDate | null;
  totalCents: number;
  balanceCents: number;
  ageDays: number;
  bucket: AgingBucket;
  source: SourceRef;
}

function ageBucket(ageDays: number): AgingBucket {
  if (ageDays <= 0) return 'current';
  if (ageDays <= 30) return '1-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

export async function openDocuments(
  db: LedgerDb,
  companyId: string,
  kind: 'invoice' | 'bill' | 'credit_note' | 'payment',
  asOf: IsoDate,
): Promise<{ asOf: IsoDate; documents: OpenDocument[]; totalsByBucket: Record<AgingBucket, number> }> {
  const rows = await db
    .select()
    .from(schema.ledgerDocuments)
    .where(
      and(
        eq(schema.ledgerDocuments.companyId, companyId),
        eq(schema.ledgerDocuments.kind, kind),
        sql`${schema.ledgerDocuments.balanceCents} <> 0`,
        lte(schema.ledgerDocuments.date, asOf),
      ),
    )
    .orderBy(asc(schema.ledgerDocuments.dueDate));

  const totalsByBucket: Record<AgingBucket, number> = {
    current: 0,
    '1-30': 0,
    '31-60': 0,
    '61-90': 0,
    '90+': 0,
  };
  const documents = rows.map((r) => {
    const dueOrDocDate = r.dueDate ?? r.date;
    const ageDays = daysBetween(dueOrDocDate, asOf);
    const bucket = ageBucket(ageDays);
    totalsByBucket[bucket] += r.balanceCents;
    return {
      id: r.id,
      externalId: r.externalId,
      number: r.number,
      contactId: r.contactId,
      date: r.date,
      dueDate: r.dueDate,
      totalCents: r.totalCents,
      balanceCents: r.balanceCents,
      ageDays,
      bucket,
      source: accountRef(r.provider, r.externalId, r.number ?? undefined),
    };
  });
  return { asOf, documents, totalsByBucket };
}

// ---------------------------------------------------------------------------
// Contact spend
// ---------------------------------------------------------------------------

export interface ContactSpend {
  contactId: string;
  externalId: string;
  name: string;
  netCents: number;
  source: SourceRef;
}

export async function contactSpend(
  db: LedgerDb,
  companyId: string,
  range: { from: IsoDate; to: IsoDate },
  kind: 'vendor' | 'customer' | 'employee' | 'other',
): Promise<ContactSpend[]> {
  const rows = await db
    .select({
      contactId: schema.ledgerContacts.id,
      externalId: schema.ledgerContacts.externalId,
      provider: schema.ledgerContacts.provider,
      name: schema.ledgerContacts.name,
      debitCents: sql<number>`coalesce(sum(${schema.ledgerLines.debitCents}), 0)`,
      creditCents: sql<number>`coalesce(sum(${schema.ledgerLines.creditCents}), 0)`,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .innerJoin(schema.ledgerContacts, eq(schema.ledgerContacts.id, schema.ledgerLines.contactId))
    .where(
      and(
        eq(schema.ledgerEntries.companyId, companyId),
        eq(schema.ledgerContacts.kind, kind),
        gte(schema.ledgerEntries.date, range.from),
        lte(schema.ledgerEntries.date, range.to),
      ),
    )
    .groupBy(schema.ledgerContacts.id, schema.ledgerContacts.externalId, schema.ledgerContacts.provider, schema.ledgerContacts.name);

  return rows
    .map((r) => ({
      contactId: r.contactId,
      externalId: r.externalId,
      name: r.name,
      netCents: Number(r.debitCents) - Number(r.creditCents),
      source: accountRef(r.provider, r.externalId, r.name),
    }))
    .sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));
}

// ---------------------------------------------------------------------------
// Recompute materialized balances
// ---------------------------------------------------------------------------

function periodOf(date: IsoDate): string {
  return date.slice(0, 7);
}

function periodRange(period: string): { from: IsoDate; to: IsoDate } {
  const [y, m] = period.split('-').map(Number);
  const from = `${period}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${period}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/** Rebuilds `ledger_account_balances` for every account from `fromPeriod` ('YYYY-MM') onward. */
export async function recomputeBalances(db: LedgerDb, companyId: string, fromPeriod: string): Promise<number> {
  const { from: fromDate } = periodRange(fromPeriod);

  const accounts = await db
    .select({ id: schema.ledgerAccounts.id })
    .from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.companyId, companyId));

  const allLines = await db
    .select({
      accountId: schema.ledgerLines.accountId,
      date: schema.ledgerEntries.date,
      debitCents: schema.ledgerLines.debitCents,
      creditCents: schema.ledgerLines.creditCents,
    })
    .from(schema.ledgerLines)
    .innerJoin(schema.ledgerEntries, eq(schema.ledgerEntries.id, schema.ledgerLines.entryId))
    .where(eq(schema.ledgerEntries.companyId, companyId));

  let written = 0;
  for (const { id: accountId } of accounts) {
    const lines = allLines.filter((l) => l.accountId === accountId);
    let opening = 0;
    for (const l of lines) {
      if (l.date < fromDate) opening += l.debitCents - l.creditCents;
    }
    const byPeriod = new Map<string, { debitsCents: number; creditsCents: number }>();
    for (const l of lines) {
      if (l.date < fromDate) continue;
      const p = periodOf(l.date);
      const agg = byPeriod.get(p) ?? { debitsCents: 0, creditsCents: 0 };
      agg.debitsCents += l.debitCents;
      agg.creditsCents += l.creditCents;
      byPeriod.set(p, agg);
    }
    const periodsSorted = [...byPeriod.keys()].sort();
    let running = opening;
    for (const period of periodsSorted) {
      const agg = byPeriod.get(period)!;
      const closing = running + agg.debitsCents - agg.creditsCents;
      await db
        .insert(schema.ledgerAccountBalances)
        .values({
          companyId,
          accountId,
          period,
          openingCents: running,
          debitsCents: agg.debitsCents,
          creditsCents: agg.creditsCents,
          closingCents: closing,
          source: 'computed',
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.ledgerAccountBalances.companyId,
            schema.ledgerAccountBalances.accountId,
            schema.ledgerAccountBalances.period,
          ],
          set: {
            openingCents: running,
            debitsCents: agg.debitsCents,
            creditsCents: agg.creditsCents,
            closingCents: closing,
            source: 'computed',
            computedAt: new Date(),
          },
        });
      written += 1;
      running = closing;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Period close
// ---------------------------------------------------------------------------

export async function periodStatus(db: LedgerDb, companyId: string, period: string): Promise<'open' | 'closed'> {
  const [row] = await db
    .select({ status: schema.ledgerPeriods.status })
    .from(schema.ledgerPeriods)
    .where(and(eq(schema.ledgerPeriods.companyId, companyId), eq(schema.ledgerPeriods.period, period)));
  return (row?.status as 'open' | 'closed') ?? 'open';
}

export async function closePeriod(db: LedgerDb, companyId: string, period: string): Promise<void> {
  await db
    .insert(schema.ledgerPeriods)
    .values({ companyId, period, status: 'closed', closedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.ledgerPeriods.companyId, schema.ledgerPeriods.period],
      set: { status: 'closed', closedAt: new Date() },
    });
}
