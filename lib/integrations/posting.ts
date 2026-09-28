/**
 * The one door a JournalEntry goes through to actually post: refuses
 * anything that isn't provably safe (approvals, balance, sourcing, account
 * mapping) and is idempotent on `je.idempotencyKey` — posting the same key
 * twice returns the first result and never calls the provider API again.
 */

import type { JournalEntry } from '@/lib/engine/types';
import type { Approval, Approver } from './posting-types';
import { getConnectionStore, type Connection, type Provider } from './store';
import * as quickbooks from './quickbooks';
import * as xero from './xero';
import { nowIso, type FetchLike } from './util';

export type { Approval, Approver };

export type PostingRefusalCode =
  | 'not_connected'
  | 'insufficient_approvals'
  | 'duplicate_approver'
  | 'unbalanced'
  | 'missing_source'
  | 'unmapped_account';

export class PostingRefusedError extends Error {
  readonly code: PostingRefusalCode;

  constructor(code: PostingRefusalCode, message: string) {
    super(message);
    this.name = 'PostingRefusedError';
    this.code = code;
  }
}

export interface PostingResult {
  externalId: string;
  provider: Provider;
  postedAt: string;
  idempotencyKey: string;
}

export interface PostingLedger {
  get(provider: Provider, idempotencyKey: string): Promise<PostingResult | null>;
  put(result: PostingResult): Promise<void>;
}

function ledgerKey(provider: Provider, idempotencyKey: string): string {
  return `${provider}:${idempotencyKey}`;
}

export class InMemoryPostingLedger implements PostingLedger {
  private readonly rows = new Map<string, PostingResult>();

  async get(provider: Provider, idempotencyKey: string): Promise<PostingResult | null> {
    return this.rows.get(ledgerKey(provider, idempotencyKey)) ?? null;
  }

  async put(result: PostingResult): Promise<void> {
    this.rows.set(ledgerKey(result.provider, result.idempotencyKey), result);
  }
}

let ledger: PostingLedger = new InMemoryPostingLedger();

/** Swap the backing ledger — the lead's Postgres `ledger_postings` implementation calls this once at startup. */
export function setPostingLedger(next: PostingLedger): void {
  ledger = next;
}

export function getPostingLedger(): PostingLedger {
  return ledger;
}

// ---------------------------------------------------------------------------
// Validation — every one of these is a hard refusal, never a warning
// ---------------------------------------------------------------------------

function validateApprovers(approval: Approval): void {
  if (approval.approvers.length < 2) {
    throw new PostingRefusedError(
      'insufficient_approvals',
      `Journal entries need at least 2 approvers; got ${approval.approvers.length}.`,
    );
  }
  const distinct = new Set(approval.approvers.map((a) => a.name.trim().toLowerCase()));
  if (distinct.size < 2) {
    throw new PostingRefusedError('duplicate_approver', 'The same approver cannot count twice.');
  }
}

function validateBalance(je: JournalEntry): void {
  let debit = 0;
  let credit = 0;
  for (const line of je.lines) {
    debit += line.debitCents;
    credit += line.creditCents;
  }
  if (debit !== credit) {
    throw new PostingRefusedError(
      'unbalanced',
      `Entry does not balance: debits ${debit} cents vs credits ${credit} cents.`,
    );
  }
}

function validateSources(je: JournalEntry): void {
  const unsourced = je.lines.find((line) => line.sources.length === 0);
  if (unsourced) {
    throw new PostingRefusedError('missing_source', `Line "${unsourced.description}" has no source — not allowed.`);
  }
}

function validateAccountMapping(je: JournalEntry, accountMap: Record<string, string>): void {
  const unmapped = je.lines.find((line) => !accountMap[line.account]);
  if (unmapped) {
    throw new PostingRefusedError(
      'unmapped_account',
      `Account "${unmapped.account}" has no mapping to a provider account.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Account mapping: our COA code -> the provider's account id/code, built
// from whatever accounts the provider currently has (QBO by AcctNum, Xero
// by Code — both map through `code`, since that's the field a chart of
// accounts and a provider account agree on).
// ---------------------------------------------------------------------------

async function buildAccountMap(
  provider: Provider,
  conn: Connection,
  fetchImpl?: FetchLike,
): Promise<{ map: Record<string, string>; connection: Connection }> {
  if (provider === 'quickbooks') {
    const { accounts, connection } = await quickbooks.getAccounts(conn, undefined, fetchImpl);
    const map: Record<string, string> = {};
    for (const a of accounts) if (a.code) map[a.code] = a.id;
    return { map, connection };
  }
  const { accounts, connection } = await xero.getAccounts(conn, undefined, fetchImpl);
  const map: Record<string, string> = {};
  for (const a of accounts) if (a.code) map[a.code] = a.code;
  return { map, connection };
}

// ---------------------------------------------------------------------------
// postJournalEntry
// ---------------------------------------------------------------------------

export interface PostJournalEntryArgs {
  provider: Provider;
  client: string;
  je: JournalEntry;
  approval: Approval;
}

export interface PostJournalEntryDeps {
  fetchImpl?: FetchLike;
}

export async function postJournalEntry(
  args: PostJournalEntryArgs,
  deps: PostJournalEntryDeps = {},
): Promise<PostingResult> {
  // Cheap, provider-independent checks first.
  validateApprovers(args.approval);
  validateBalance(args.je);
  validateSources(args.je);

  // Idempotency: a repeat of the same key never touches the network again.
  const existing = await ledger.get(args.provider, args.je.idempotencyKey);
  if (existing) return existing;

  let conn = await getConnectionStore().get(args.provider, args.client);
  if (!conn || conn.status !== 'connected') {
    throw new PostingRefusedError('not_connected', `No connected ${args.provider} account for client ${args.client}.`);
  }

  const mapped = await buildAccountMap(args.provider, conn, deps.fetchImpl);
  conn = mapped.connection;
  validateAccountMapping(args.je, mapped.map);

  const posted =
    args.provider === 'quickbooks'
      ? await quickbooks.createJournalEntry(conn, args.je, args.approval, mapped.map, undefined, deps.fetchImpl)
      : await xero.createManualJournal(conn, args.je, args.approval, mapped.map, undefined, deps.fetchImpl);

  if (posted.connection.updatedAt !== conn.updatedAt) {
    await getConnectionStore().put(posted.connection);
  }

  const result: PostingResult = {
    externalId: posted.externalId,
    provider: args.provider,
    postedAt: nowIso(),
    idempotencyKey: args.je.idempotencyKey,
  };
  await ledger.put(result);
  return result;
}

// Exported for tests that want to exercise validation directly without a connection.
export const _validate = { validateApprovers, validateBalance, validateSources, validateAccountMapping };
