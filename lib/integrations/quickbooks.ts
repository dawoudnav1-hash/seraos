/**
 * QuickBooks Online client: OAuth wiring, the SQL-like Query API with
 * pagination, the JournalReport/TrialBalance reports, Change Data Capture
 * for incremental sync, and posting a JournalEntry.
 *
 * Endpoints confirmed against Intuit's own docs/blog via search (network
 * access to developer.intuit.com itself was blocked from this sandbox):
 * authorize URL, token URL, `com.intuit.quickbooks.accounting` scope,
 * sandbox/production API base URLs, STARTPOSITION/MAXRESULTS paging, the
 * CDC endpoint and response envelope, and the JournalEntry Line shape
 * (DetailType/PostingType/AccountRef). Anything else below is my best
 * understanding and is flagged `// Verify:` inline — see the README.
 */

import type { Cents, JournalEntry, JournalEntryType, SourceRef, Txn } from '@/lib/engine/types';
import {
  exchangeCodeForToken,
  getEncryptionKey,
  IntegrationConfigError,
  isExpired,
  refreshAccessToken,
  signState,
  verifyState,
  encryptTokens,
  decryptTokens,
  type OAuthClientConfig,
  type TokenSet,
} from './oauth';
import { fetchWithBackoff, readJsonOrThrow, ProviderHttpError } from './http';
import { centsToDollars, dollarsToCents, nowIso, type FetchLike } from './util';
import type { Connection } from './store';
import type { WhAccount, WhContact, WhDocument, WhEntry, WhLine } from './sink';
import type { Approval } from './posting-types';

export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
// Verify: Intuit's own examples use this same host for revoke; the exact path
// has moved before (v1 vs v2). Confirm against the current OAuth2 API docs.
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
// Verify: 75 is the current floor/default minor version per Intuit's August
// 2025 deprecation notice; confirm it hasn't moved again before shipping.
export const QBO_MINOR_VERSION = 75;

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'sandbox' | 'production';
}

export function getQboConfig(env = process.env): QboConfig {
  const missing: string[] = [];
  if (!env.QBO_CLIENT_ID) missing.push('QBO_CLIENT_ID');
  if (!env.QBO_CLIENT_SECRET) missing.push('QBO_CLIENT_SECRET');
  if (!env.QBO_REDIRECT_URI) missing.push('QBO_REDIRECT_URI');
  if (!env.QBO_ENVIRONMENT) missing.push('QBO_ENVIRONMENT');
  if (missing.length) {
    throw new IntegrationConfigError(`Missing QuickBooks env vars: ${missing.join(', ')}.`);
  }
  const environment = env.QBO_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  return {
    clientId: env.QBO_CLIENT_ID!,
    clientSecret: env.QBO_CLIENT_SECRET!,
    redirectUri: env.QBO_REDIRECT_URI!,
    environment,
  };
}

function oauthConfig(cfg: QboConfig): OAuthClientConfig {
  return { clientId: cfg.clientId, clientSecret: cfg.clientSecret, tokenUrl: QBO_TOKEN_URL };
}

export function apiBaseUrl(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(client: string, cfg: QboConfig = getQboConfig()): string {
  const state = signState({ provider: 'quickbooks', client });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: QBO_SCOPE,
    state,
  });
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`;
}

export interface QboCallbackInput {
  code: string;
  state: string;
  realmId: string;
}

/** Verifies `state`, exchanges the code, and returns a ready-to-store Connection. */
export async function handleCallback(
  input: QboCallbackInput,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<Connection> {
  const payload = verifyState(input.state);
  if (payload.provider !== 'quickbooks') throw new IntegrationConfigError('State was signed for a different provider.');
  const tokens = await exchangeCodeForToken(oauthConfig(cfg), input.code, cfg.redirectUri, fetchImpl);
  const at = nowIso();
  return {
    provider: 'quickbooks',
    client: payload.client,
    externalId: input.realmId,
    tokensEnc: encryptTokens(tokens),
    status: 'connected',
    scopes: [QBO_SCOPE],
    connectedAt: at,
    updatedAt: at,
    lastSyncAt: null,
  };
}

export async function revokeConnection(
  conn: Connection,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const tokens = decryptTokens(conn.tokensEnc);
  // Verify: revoke takes a JSON body {"token": "<refresh_token>"} with Basic
  // client auth, per Intuit's OAuth2 how-to guides. Confirm before relying on it.
  const res = await fetchImpl(QBO_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ token: tokens.refreshToken }),
  });
  if (!res.ok && res.status !== 400) {
    // 400 on an already-revoked token is treated as success — disconnect must not get stuck.
    await readJsonOrThrow(res, QBO_REVOKE_URL);
  }
}

// ---------------------------------------------------------------------------
// Authenticated request: proactive refresh, refresh-on-401-once, 429 backoff
// ---------------------------------------------------------------------------

export interface QboRequestResult {
  json: any;
  connection: Connection;
}

async function refreshConnection(
  conn: Connection,
  cfg: QboConfig,
  fetchImpl: FetchLike,
): Promise<{ tokens: TokenSet; connection: Connection }> {
  const current = decryptTokens(conn.tokensEnc);
  const tokens = await refreshAccessToken(oauthConfig(cfg), current.refreshToken, fetchImpl);
  const connection: Connection = { ...conn, tokensEnc: encryptTokens(tokens), updatedAt: nowIso() };
  return { tokens, connection };
}

export async function qboRequest(
  conn: Connection,
  path: string,
  init: { method?: string; body?: string; extraQuery?: Record<string, string> } = {},
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<QboRequestResult> {
  let connection = conn;
  let tokens = decryptTokens(connection.tokensEnc);
  if (isExpired(tokens)) {
    const refreshed = await refreshConnection(connection, cfg, fetchImpl);
    tokens = refreshed.tokens;
    connection = refreshed.connection;
  }

  const query = new URLSearchParams({ minorversion: String(QBO_MINOR_VERSION), ...init.extraQuery });
  const url = `${apiBaseUrl(cfg.environment)}/v3/company/${connection.externalId}${path}${path.includes('?') ? '&' : '?'}${query.toString()}`;

  const doFetch = (accessToken: string) =>
    fetchWithBackoff(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body,
      },
      { fetchImpl },
    );

  let res = await doFetch(tokens.accessToken);
  if (res.status === 401) {
    const refreshed = await refreshConnection(connection, cfg, fetchImpl);
    tokens = refreshed.tokens;
    connection = refreshed.connection;
    res = await doFetch(tokens.accessToken);
  }
  const json = await readJsonOrThrow(res, url);
  return { json, connection };
}

// ---------------------------------------------------------------------------
// Query API with STARTPOSITION/MAXRESULTS pagination
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

/** Runs `query`, walking STARTPOSITION until a page comes back short of MAXRESULTS. */
export async function queryAll(
  conn: Connection,
  entity: string,
  where: string | null,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ rows: any[]; connection: Connection }> {
  const rows: any[] = [];
  let connection = conn;
  let start = 1;
  for (;;) {
    const clause = where ? ` WHERE ${where}` : '';
    const q = `SELECT * FROM ${entity}${clause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const { json, connection: next } = await qboRequest(
      connection,
      '/query',
      { extraQuery: { query: q } },
      cfg,
      fetchImpl,
    );
    connection = next;
    const page: any[] = json?.QueryResponse?.[entity] ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  return { rows, connection };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface QboAccount {
  id: string;
  code: string | null;
  name: string;
  qboType: string;
  qboSubType: string | null;
  active: boolean;
  currentBalanceCents: Cents;
}

export function normalizeAccount(raw: any): QboAccount {
  return {
    id: String(raw.Id),
    code: raw.AcctNum ?? null,
    name: raw.Name,
    qboType: raw.AccountType,
    qboSubType: raw.AccountSubType ?? null,
    active: raw.Active !== false,
    currentBalanceCents: dollarsToCents(Number(raw.CurrentBalance ?? 0)),
  };
}

export async function getAccounts(
  conn: Connection,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ accounts: QboAccount[]; connection: Connection }> {
  const { rows, connection } = await queryAll(conn, 'Account', null, cfg, fetchImpl);
  return { accounts: rows.map(normalizeAccount), connection };
}

export function accountToWh(a: QboAccount, updatedAt: string | null = null): WhAccount {
  return {
    externalId: a.id,
    code: a.code,
    name: a.name,
    providerType: a.qboType,
    providerSubtype: a.qboSubType,
    currency: null,
    active: a.active,
    parentExternalId: null,
    currentBalanceCents: a.currentBalanceCents,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Transactions (Purchase, Deposit, Transfer, Payment/BillPayment, JournalEntry)
// ---------------------------------------------------------------------------

const TXN_ENTITIES = ['JournalEntry', 'Purchase', 'Deposit', 'Transfer', 'Payment', 'BillPayment'] as const;
export type QboTxnEntity = (typeof TXN_ENTITIES)[number];

/** Best-effort normalization across QBO's several transaction entities, which don't share one shape. */
export function normalizeTxn(entity: QboTxnEntity, raw: any): Txn {
  const amount = Number(raw.TotalAmt ?? raw.Amount ?? 0);
  const source: SourceRef = { system: 'quickbooks', id: String(raw.Id), label: entity };
  return {
    id: String(raw.Id),
    date: raw.TxnDate,
    amountCents: dollarsToCents(amount),
    description: raw.PrivateNote ?? raw.Memo?.value ?? entity,
    counterparty: raw.EntityRef?.name ?? raw.PayeeRef?.name ?? undefined,
    reference: raw.DocNumber ?? undefined,
    currency: raw.CurrencyRef?.value ?? undefined,
    source,
  };
}

export async function getTransactions(
  conn: Connection,
  opts: { sinceDate: string; entities?: readonly QboTxnEntity[] },
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ txns: Txn[]; connection: Connection }> {
  let connection = conn;
  const txns: Txn[] = [];
  for (const entity of opts.entities ?? TXN_ENTITIES) {
    const { rows, connection: next } = await queryAll(
      connection,
      entity,
      `TxnDate >= '${opts.sinceDate}'`,
      cfg,
      fetchImpl,
    );
    connection = next;
    txns.push(...rows.map((r) => normalizeTxn(entity, r)));
  }
  return { txns, connection };
}

// ---------------------------------------------------------------------------
// Reports: TrialBalance, GeneralLedger, JournalReport, and CDC for incremental sync
// ---------------------------------------------------------------------------

export async function getReport(
  conn: Connection,
  reportName: 'TrialBalance' | 'GeneralLedger' | 'JournalReport',
  range: { startDate: string; endDate: string },
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ report: any; connection: Connection }> {
  const { json, connection } = await qboRequest(
    conn,
    `/reports/${reportName}`,
    { extraQuery: { start_date: range.startDate, end_date: range.endDate } },
    cfg,
    fetchImpl,
  );
  return { report: json, connection };
}

/**
 * Walks the {Header, Columns, Rows} shape shared by every QBO report and
 * turns each transaction-level group into a WhEntry with one WhLine per row.
 *
 * Verify: the exact ColType tokens (tx_date, txn_type, doc_num, name, memo,
 * account_name, subt_nat_amount/debt_amt, credit_amt) and whether rows are
 * grouped by a `Group` node per transaction or come back flat with a shared
 * doc/date/type per contiguous run — both patterns exist across QBO reports
 * and I could not confirm JournalReport's specifically. This parser handles
 * both: it prefers `Group` nodes when present, and otherwise buckets
 * consecutive `Data` rows sharing txn_type+doc_num+tx_date into one entry.
 */
export function normalizeJournalReport(report: any): WhEntry[] {
  const columns: any[] = report?.Columns?.Column ?? [];
  const colIndex = (type: string) => columns.findIndex((c) => c.ColType === type);
  const idx = {
    date: colIndex('tx_date'),
    type: colIndex('txn_type'),
    doc: colIndex('doc_num'),
    name: colIndex('name'),
    memo: colIndex('memo'),
    account: colIndex('account_name'),
    debit: columns.findIndex((c) => c.ColType === 'subt_nat_amount' || c.ColType === 'debt_amt'),
    credit: colIndex('credit_amt'),
  };
  const cell = (row: any, i: number): string | undefined => (i >= 0 ? row.ColData?.[i]?.value : undefined);
  const cellId = (row: any, i: number): string | undefined => (i >= 0 ? row.ColData?.[i]?.id : undefined);

  const entriesByKey = new Map<string, WhEntry>();

  const visit = (rows: any[]) => {
    for (const row of rows) {
      if (row.Rows?.Row) {
        // Nested group: recurse (covers the group-per-transaction shape).
        visit(row.Rows.Row);
        continue;
      }
      if (row.type !== 'Data' && !row.ColData) continue;
      const date = cell(row, idx.date) ?? '';
      const type = cell(row, idx.type) ?? 'JournalEntry';
      const doc = cell(row, idx.doc) ?? '';
      const externalId = cellId(row, idx.name) ?? `${type}:${doc}:${date}`;
      const key = `${type}|${doc}|${date}`;
      let entry = entriesByKey.get(key);
      if (!entry) {
        entry = {
          externalId: doc || key,
          sourceType: type,
          number: doc || null,
          date,
          memo: cell(row, idx.memo) ?? null,
          currency: report?.Header?.Currency ?? null,
          status: null,
          updatedAt: null,
          lines: [],
        };
        entriesByKey.set(key, entry);
      }
      const debitStr = cell(row, idx.debit);
      const creditStr = cell(row, idx.credit);
      const debitCents = debitStr ? dollarsToCents(Number(debitStr)) : 0;
      const creditCents = creditStr ? dollarsToCents(Number(creditStr)) : 0;
      if (!debitCents && !creditCents) continue;
      entry.lines.push({
        lineNo: entry.lines.length + 1,
        accountExternalId: cellId(row, idx.account) ?? cell(row, idx.account) ?? '',
        contactExternalId: externalId && externalId !== key ? externalId : null,
        description: cell(row, idx.memo) ?? null,
        debitCents,
        creditCents,
        dimensions: {},
      });
    }
  };
  visit(report?.Rows?.Row ?? []);
  return Array.from(entriesByKey.values()).filter((e) => e.lines.length > 0);
}

export async function getGeneralLedgerEntries(
  conn: Connection,
  range: { startDate: string; endDate: string },
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ entries: WhEntry[]; connection: Connection }> {
  const { report, connection } = await getReport(conn, 'JournalReport', range, cfg, fetchImpl);
  return { entries: normalizeJournalReport(report), connection };
}

// ---------------------------------------------------------------------------
// Contacts (Customer/Vendor/Employee) and open documents (Invoice/Bill)
// ---------------------------------------------------------------------------

export function contactToWh(entity: 'Customer' | 'Vendor' | 'Employee', raw: any): WhContact {
  const kind = entity === 'Customer' ? 'customer' : entity === 'Vendor' ? 'vendor' : 'employee';
  return {
    externalId: String(raw.Id),
    kind,
    name: raw.DisplayName ?? raw.Name ?? `${raw.GivenName ?? ''} ${raw.FamilyName ?? ''}`.trim(),
    email: raw.PrimaryEmailAddr?.Address ?? null,
    active: raw.Active !== false,
  };
}

export async function getContacts(
  conn: Connection,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ contacts: WhContact[]; connection: Connection }> {
  let connection = conn;
  const contacts: WhContact[] = [];
  for (const entity of ['Customer', 'Vendor', 'Employee'] as const) {
    const { rows, connection: next } = await queryAll(connection, entity, null, cfg, fetchImpl);
    connection = next;
    contacts.push(...rows.map((r) => contactToWh(entity, r)));
  }
  return { contacts, connection };
}

export function documentToWh(entity: 'Invoice' | 'Bill', raw: any): WhDocument {
  return {
    externalId: String(raw.Id),
    kind: entity === 'Invoice' ? 'invoice' : 'bill',
    contactExternalId: raw.CustomerRef?.value ?? raw.VendorRef?.value ?? null,
    number: raw.DocNumber ?? null,
    date: raw.TxnDate,
    dueDate: raw.DueDate ?? null,
    totalCents: dollarsToCents(Number(raw.TotalAmt ?? 0)),
    balanceCents: dollarsToCents(Number(raw.Balance ?? 0)),
    status: raw.Balance > 0 ? 'open' : 'paid',
    currency: raw.CurrencyRef?.value ?? null,
  };
}

export async function getOpenDocuments(
  conn: Connection,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ documents: WhDocument[]; connection: Connection }> {
  let connection = conn;
  const documents: WhDocument[] = [];
  for (const entity of ['Invoice', 'Bill'] as const) {
    const { rows, connection: next } = await queryAll(connection, entity, `Balance > '0'`, cfg, fetchImpl);
    connection = next;
    documents.push(...rows.map((r) => documentToWh(entity, r)));
  }
  return { documents, connection };
}

// ---------------------------------------------------------------------------
// Change Data Capture — incremental sync cursor is the changedSince timestamp
// ---------------------------------------------------------------------------

export async function getChangeDataCapture(
  conn: Connection,
  opts: { entities: string[]; changedSince: string },
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ byEntity: Record<string, any[]>; connection: Connection }> {
  const { json, connection } = await qboRequest(
    conn,
    '/cdc',
    { extraQuery: { entities: opts.entities.join(','), changedSince: opts.changedSince } },
    cfg,
    fetchImpl,
  );
  const byEntity: Record<string, any[]> = {};
  const queryResponses: any[] = json?.CDCResponse?.[0]?.QueryResponse ?? [];
  for (const qr of queryResponses) {
    for (const entity of opts.entities) {
      if (qr[entity]) byEntity[entity] = qr[entity];
    }
  }
  return { byEntity, connection };
}

// ---------------------------------------------------------------------------
// Post a JournalEntry
// ---------------------------------------------------------------------------

export function buildJournalEntryPayload(
  je: JournalEntry,
  accountMap: Record<string, string>,
  approval: Approval,
): any {
  const approverNote = `Approved by ${approval.approvers.map((a) => `${a.name} (${a.role})`).join(', ')}.`;
  return {
    TxnDate: je.date,
    // Verify: DocNumber is capped at 21 chars in QBO; je.id may need truncation
    // in a real deployment if ids run longer than that.
    DocNumber: je.id.slice(0, 21),
    PrivateNote: `${je.memo} — ${approverNote}`.slice(0, 4000),
    Line: je.lines.map((line) => ({
      Description: line.description,
      Amount: centsToDollars(line.debitCents > 0 ? line.debitCents : line.creditCents),
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: line.debitCents > 0 ? 'Debit' : 'Credit',
        AccountRef: { value: accountMap[line.account] },
      },
    })),
  };
}

export async function createJournalEntry(
  conn: Connection,
  je: JournalEntry,
  approval: Approval,
  accountMap: Record<string, string>,
  cfg: QboConfig = getQboConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ externalId: string; connection: Connection }> {
  const payload = buildJournalEntryPayload(je, accountMap, approval);
  const { json, connection } = await qboRequest(
    conn,
    '/journalentry',
    { method: 'POST', body: JSON.stringify(payload), extraQuery: { requestid: je.idempotencyKey } },
    cfg,
    fetchImpl,
  );
  return { externalId: String(json.JournalEntry.Id), connection };
}

export const QBO_TXN_ENTITIES = TXN_ENTITIES;
export type { JournalEntryType };
export { ProviderHttpError };
