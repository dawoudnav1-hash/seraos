/**
 * Full-then-incremental sync into the LedgerSink warehouse. Full pull the
 * first time (no stored cursor), incremental after — cursors are per
 * (company, entity) and persisted through the sink itself so a Postgres
 * `LedgerSink` gets incremental sync for free.
 *
 * QBO has no incremental journal-entry feed in the public API, so the GL
 * pull re-runs JournalReport from the last synced date forward (cheap: a
 * date-bounded report, not a full-history re-pull) while Customer/Vendor/
 * Employee changes use Change Data Capture, whose cursor is the
 * `changedSince` timestamp. Xero's Journals feed is natively incremental —
 * its cursor is the last JournalNumber (`offset`).
 */

import { getConnectionStore, type Provider } from './store';
import { getLedgerSink, type LedgerSink, type WhBankTxn } from './sink';
import { IntegrationConfigError } from './oauth';
import * as quickbooks from './quickbooks';
import * as xero from './xero';
import type { FetchLike } from './util';

export interface SyncOptions {
  sink?: LedgerSink;
  fetchImpl?: FetchLike;
  /** Injectable clock for tests. */
  now?: () => Date;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number, now: () => Date): Date {
  return new Date(now().getTime() - days * 24 * 60 * 60 * 1000);
}

export async function syncClient(provider: Provider, client: string, opts: SyncOptions = {}): Promise<Record<string, number>> {
  const conn0 = await getConnectionStore().get(provider, client);
  if (!conn0 || conn0.status !== 'connected') {
    throw new IntegrationConfigError(`No connected ${provider} account for client ${client}.`);
  }
  const sink = opts.sink ?? getLedgerSink();
  const now = opts.now ?? (() => new Date());
  const companyId = `${provider}:${conn0.externalId}`;
  const counts: Record<string, number> = {};
  let conn = conn0;

  await sink.upsertCompany({
    id: companyId,
    client,
    provider,
    externalId: conn.externalId,
    // Verify: a real display name needs QBO's CompanyInfo or Xero's
    // Organisation endpoint, neither wired up yet — externalId stands in.
    name: conn.externalId,
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
  });

  if (provider === 'quickbooks') {
    const accountsRes = await quickbooks.getAccounts(conn, undefined, opts.fetchImpl);
    conn = accountsRes.connection;
    counts.accounts = await sink.upsertAccounts(companyId, accountsRes.accounts.map((a) => quickbooks.accountToWh(a)));

    const contactsRes = await quickbooks.getContacts(conn, undefined, opts.fetchImpl);
    conn = contactsRes.connection;
    counts.contacts = await sink.upsertContacts(companyId, contactsRes.contacts);

    const docsRes = await quickbooks.getOpenDocuments(conn, undefined, opts.fetchImpl);
    conn = docsRes.connection;
    counts.documents = await sink.upsertDocuments(companyId, docsRes.documents);

    const today = isoDate(now());
    const glCursor = await sink.getSyncCursor(companyId, 'journalreport');
    const startDate = glCursor ?? isoDate(daysAgo(90, now));
    const glRes = await quickbooks.getGeneralLedgerEntries(conn, { startDate, endDate: today }, undefined, opts.fetchImpl);
    conn = glRes.connection;
    counts.entries = await sink.upsertEntries(companyId, glRes.entries);
    await sink.setSyncCursor(companyId, 'journalreport', today, counts.entries);

    const cdcCursor = await sink.getSyncCursor(companyId, 'cdc');
    const changedSince = cdcCursor ?? daysAgo(30, now).toISOString();
    const cdcRes = await quickbooks.getChangeDataCapture(
      conn,
      { entities: ['Customer', 'Vendor', 'Employee'], changedSince },
      undefined,
      opts.fetchImpl,
    );
    conn = cdcRes.connection;
    let cdcCount = 0;
    for (const [entity, rows] of Object.entries(cdcRes.byEntity)) {
      const wh = rows.map((r: any) => quickbooks.contactToWh(entity as 'Customer' | 'Vendor' | 'Employee', r));
      cdcCount += await sink.upsertContacts(companyId, wh);
    }
    counts.cdc = cdcCount;
    await sink.setSyncCursor(companyId, 'cdc', now().toISOString(), cdcCount);

    // QBO's public API has no bank-feed "For Review" endpoint (see README) —
    // Purchase/Deposit/Transfer/Payment already land in `entries` via the GL pull.
    counts.bankTransactions = 0;
  } else {
    const accountsRes = await xero.getAccounts(conn, undefined, opts.fetchImpl);
    conn = accountsRes.connection;
    counts.accounts = await sink.upsertAccounts(companyId, accountsRes.accounts);

    const contactsRes = await xero.getContacts(conn, undefined, opts.fetchImpl);
    conn = contactsRes.connection;
    counts.contacts = await sink.upsertContacts(companyId, contactsRes.contacts);

    const journalsCursor = await sink.getSyncCursor(companyId, 'journals');
    const offset = journalsCursor ? Number(journalsCursor) : 0;
    const journalsRes = await xero.getJournals(conn, offset, undefined, opts.fetchImpl);
    conn = journalsRes.connection;
    counts.entries = await sink.upsertEntries(companyId, journalsRes.entries);
    await sink.setSyncCursor(companyId, 'journals', String(journalsRes.nextOffset), counts.entries);

    const bankCursor = await sink.getSyncCursor(companyId, 'bankTransactions');
    const bankRes = await xero.getBankTransactions(conn, { modifiedSince: bankCursor ?? undefined }, undefined, opts.fetchImpl);
    conn = bankRes.connection;
    const whRows: WhBankTxn[] = bankRes.whRows;
    counts.bankTransactions = await sink.upsertBankTransactions(companyId, whRows);
    await sink.setSyncCursor(companyId, 'bankTransactions', now().toISOString(), counts.bankTransactions);

    counts.documents = 0; // Verify: Invoices/Bills not wired for Xero yet — Journals already carries their GL postings.
  }

  if (conn.updatedAt !== conn0.updatedAt) await getConnectionStore().put(conn);
  return counts;
}
