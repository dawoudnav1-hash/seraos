/**
 * Where synced books land. The contract and implementations live in the
 * ledger warehouse (lib/ledger); this module only holds which sink the sync
 * writes to, so tests can swap in the in-memory one.
 */
import { InMemoryLedgerSink } from '@/lib/ledger/sink';
import type { LedgerSink } from '@/lib/ledger/types';

export type { LedgerSink, WhAccount, WhBankTxn, WhCompany, WhContact, WhDocument, WhEntry, WhLine } from '@/lib/ledger/types';
export { InMemoryLedgerSink } from '@/lib/ledger/sink';

let sink: LedgerSink = new InMemoryLedgerSink();

/** Point the sync at a sink — the app uses the Postgres warehouse. */
export function setLedgerSink(next: LedgerSink): void {
  sink = next;
}

export function getLedgerSink(): LedgerSink {
  return sink;
}
