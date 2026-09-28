/**
 * The demo-data path: when no ledger is connected, uploaded CSVs/fixtures
 * populate a 'manual' company through the exact same `LedgerSink` the
 * QuickBooks/Xero sync writes through, so every downstream reader (agents,
 * `lib/ledger/repository.ts`) sees one shape regardless of where data came from.
 */
import { PostgresLedgerSink, type LedgerDb } from './sink';
import type { WhAccount, WhBankTxn, WhEntry } from './types';

function manualCompanyId(client: string, companyName: string): string {
  const slug = `${client}-${companyName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `manual-${slug}`;
}

export interface ImportManualData {
  accounts: WhAccount[];
  entries: WhEntry[];
  bankTransactions?: WhBankTxn[];
}

export interface ImportManualResult {
  companyId: string;
  accounts: number;
  entries: number;
  bankTransactions: number;
}

/**
 * Idempotent: re-running with the same `client`/`companyName` upserts into the
 * same manual company rather than creating a duplicate one every time.
 */
export async function importManual(
  db: LedgerDb,
  meta: { client: string; companyName: string; baseCurrency?: string; fiscalYearStartMonth?: number },
  data: ImportManualData,
): Promise<ImportManualResult> {
  const sink = new PostgresLedgerSink(db);
  const companyId = manualCompanyId(meta.client, meta.companyName);

  await sink.upsertCompany({
    id: companyId,
    client: meta.client,
    provider: 'manual',
    externalId: companyId,
    name: meta.companyName,
    baseCurrency: meta.baseCurrency ?? 'USD',
    fiscalYearStartMonth: meta.fiscalYearStartMonth ?? 1,
  });

  const accounts = await sink.upsertAccounts(companyId, data.accounts);
  const entries = await sink.upsertEntries(companyId, data.entries);
  const bankTransactions = data.bankTransactions
    ? await sink.upsertBankTransactions(companyId, data.bankTransactions)
    : 0;

  return { companyId, accounts, entries, bankTransactions };
}
