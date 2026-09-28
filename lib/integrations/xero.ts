/**
 * Xero client: OAuth wiring (including the tenant discovery step Xero needs
 * that QBO doesn't — the authorization code carries no tenantId, so the
 * callback calls GET /connections to find it), Accounts/Contacts/Bank
 * Transactions, the Journals feed for a full double-entry GL pull, the
 * TrialBalance report, and posting a ManualJournal.
 *
 * Confirmed against Xero's own docs via search (network access to
 * developer.xero.com itself was blocked from this sandbox): the standard
 * auth-code flow's authorize/token URLs, the accounting.transactions /
 * offline_access scopes, the GET /connections shape and xero-tenant-id
 * header, ManualJournal LineAmount sign convention (+debit/-credit),
 * Idempotency-Key support on POST/PUT/PATCH, and Journals paging by
 * `offset` = last JournalNumber (oldest to newest, <=100 per page). Anything
 * else is my best understanding, flagged `// Verify:` inline.
 */

import type { JournalEntry, Txn } from '@/lib/engine/types';
import {
  exchangeCodeForToken,
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
import type { WhAccount, WhBankTxn, WhContact, WhDocument, WhEntry, WhLine } from './sink';
import type { Approval } from './posting-types';

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
// Verify: Xero's identity server (IdentityServer4-based) exposes the standard
// OIDC revocation endpoint at this path; confirm against the current OIDC
// discovery document (https://identity.xero.com/.well-known/openid-configuration).
export const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
// offline_access gets us a refresh token; the rest are the accounting scopes
// this connector reads and writes.
export const XERO_SCOPE =
  'offline_access accounting.transactions accounting.settings accounting.contacts accounting.reports.read accounting.journals.read';

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getXeroConfig(env = process.env): XeroConfig {
  const missing: string[] = [];
  if (!env.XERO_CLIENT_ID) missing.push('XERO_CLIENT_ID');
  if (!env.XERO_CLIENT_SECRET) missing.push('XERO_CLIENT_SECRET');
  if (!env.XERO_REDIRECT_URI) missing.push('XERO_REDIRECT_URI');
  if (missing.length) throw new IntegrationConfigError(`Missing Xero env vars: ${missing.join(', ')}.`);
  return { clientId: env.XERO_CLIENT_ID!, clientSecret: env.XERO_CLIENT_SECRET!, redirectUri: env.XERO_REDIRECT_URI! };
}

function oauthConfig(cfg: XeroConfig): OAuthClientConfig {
  return { clientId: cfg.clientId, clientSecret: cfg.clientSecret, tokenUrl: XERO_TOKEN_URL };
}

// ---------------------------------------------------------------------------
// OAuth flow (+ tenant discovery)
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(client: string, cfg: XeroConfig = getXeroConfig()): string {
  const state = signState({ provider: 'xero', client });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: XERO_SCOPE,
    state,
  });
  return `${XERO_AUTHORIZE_URL}?${params.toString()}`;
}

export interface XeroConnectionRow {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
}

export async function getConnections(accessToken: string, fetchImpl: FetchLike = fetch): Promise<XeroConnectionRow[]> {
  const res = await fetchImpl(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const json = await readJsonOrThrow(res, XERO_CONNECTIONS_URL);
  return (json ?? []).map((c: any) => ({
    id: c.id,
    tenantId: c.tenantId,
    tenantType: c.tenantType,
    tenantName: c.tenantName,
  }));
}

export interface XeroCallbackInput {
  code: string;
  state: string;
}

/** Verifies `state`, exchanges the code, then discovers the tenantId via GET /connections. */
export async function handleCallback(
  input: XeroCallbackInput,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<Connection> {
  const payload = verifyState(input.state);
  if (payload.provider !== 'xero') throw new IntegrationConfigError('State was signed for a different provider.');
  const tokens = await exchangeCodeForToken(oauthConfig(cfg), input.code, cfg.redirectUri, fetchImpl);
  const connections = await getConnections(tokens.accessToken, fetchImpl);
  const tenant = connections.find((c) => c.tenantType === 'ORGANISATION') ?? connections[0];
  if (!tenant) throw new IntegrationConfigError('Xero returned no connected organisation for this authorization.');
  const at = nowIso();
  return {
    provider: 'xero',
    client: payload.client,
    externalId: tenant.tenantId,
    tokensEnc: encryptTokens(tokens),
    status: 'connected',
    scopes: XERO_SCOPE.split(' '),
    connectedAt: at,
    updatedAt: at,
    lastSyncAt: null,
  };
}

export async function revokeConnection(
  conn: Connection,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const tokens = decryptTokens(conn.tokensEnc);
  // Verify: standard OIDC revocation body — form-encoded `token` (+ optional
  // token_type_hint) with Basic client auth. Confirm against Xero's docs.
  const res = await fetchImpl(XERO_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token' }).toString(),
  });
  if (!res.ok && res.status !== 400) await readJsonOrThrow(res, XERO_REVOKE_URL);
}

// ---------------------------------------------------------------------------
// Authenticated request: proactive refresh, refresh-on-401-once, 429 backoff
// ---------------------------------------------------------------------------

async function refreshConnection(
  conn: Connection,
  cfg: XeroConfig,
  fetchImpl: FetchLike,
): Promise<{ tokens: TokenSet; connection: Connection }> {
  const current = decryptTokens(conn.tokensEnc);
  const tokens = await refreshAccessToken(oauthConfig(cfg), current.refreshToken, fetchImpl);
  const connection: Connection = { ...conn, tokensEnc: encryptTokens(tokens), updatedAt: nowIso() };
  return { tokens, connection };
}

export interface XeroRequestResult {
  json: any;
  connection: Connection;
}

export async function xeroRequest(
  conn: Connection,
  path: string,
  init: { method?: string; body?: string; query?: Record<string, string>; headers?: Record<string, string> } = {},
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<XeroRequestResult> {
  let connection = conn;
  let tokens = decryptTokens(connection.tokensEnc);
  if (isExpired(tokens)) {
    const refreshed = await refreshConnection(connection, cfg, fetchImpl);
    tokens = refreshed.tokens;
    connection = refreshed.connection;
  }

  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : '';
  const url = `${XERO_API_BASE}${path}${qs}`;

  const doFetch = (accessToken: string) =>
    fetchWithBackoff(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': connection.externalId,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
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
// Accounts / Contacts
// ---------------------------------------------------------------------------

export function accountToWh(raw: any): WhAccount {
  return {
    externalId: raw.AccountID,
    code: raw.Code ?? null,
    name: raw.Name,
    providerType: raw.Type,
    providerSubtype: raw.Class ?? null,
    currency: null,
    active: raw.Status === 'ACTIVE',
    parentExternalId: null,
    currentBalanceCents: null, // Verify: Accounts doesn't carry a running balance; TrialBalance does.
    updatedAt: raw.UpdatedDateUTC ?? null,
  };
}

export async function getAccounts(
  conn: Connection,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ accounts: WhAccount[]; connection: Connection }> {
  const { json, connection } = await xeroRequest(conn, '/Accounts', {}, cfg, fetchImpl);
  const accounts: WhAccount[] = (json.Accounts ?? []).map(accountToWh);
  return { accounts, connection };
}

export function contactToWh(raw: any): WhContact {
  return {
    externalId: raw.ContactID,
    kind: raw.IsSupplier ? 'vendor' : raw.IsCustomer ? 'customer' : 'other',
    name: raw.Name,
    email: raw.EmailAddress ?? null,
    active: raw.ContactStatus === 'ACTIVE',
  };
}

/** Xero pages most list endpoints with `page` (100 rows/page); a short page ends the walk. */
async function paginateByPage(
  conn: Connection,
  path: string,
  itemsKey: string,
  cfg: XeroConfig,
  fetchImpl: FetchLike,
  extraQuery: Record<string, string> = {},
): Promise<{ rows: any[]; connection: Connection }> {
  const rows: any[] = [];
  let connection = conn;
  let page = 1;
  for (;;) {
    const { json, connection: next } = await xeroRequest(
      connection,
      path,
      { query: { ...extraQuery, page: String(page) } },
      cfg,
      fetchImpl,
    );
    connection = next;
    const batch: any[] = json[itemsKey] ?? [];
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return { rows, connection };
}

export async function getContacts(
  conn: Connection,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ contacts: WhContact[]; connection: Connection }> {
  const { rows, connection } = await paginateByPage(conn, '/Contacts', 'Contacts', cfg, fetchImpl);
  return { contacts: rows.map(contactToWh), connection };
}

// ---------------------------------------------------------------------------
// Bank transactions
// ---------------------------------------------------------------------------

/** AUTHORISED+reconciled -> matched; AUTHORISED with a category line -> categorized; else unreviewed; VOIDED/DELETED -> excluded. Verify: Xero has no first-class "For Review" status in this API — see README. */
function bankTxnStatus(raw: any): WhBankTxn['status'] {
  if (raw.Status === 'DELETED' || raw.Status === 'VOIDED') return 'excluded';
  if (raw.IsReconciled) return 'matched';
  if (raw.LineItems?.some((li: any) => li.AccountCode)) return 'categorized';
  return 'unreviewed';
}

export function bankTxnToWh(raw: any): WhBankTxn {
  const total = dollarsToCents(Number(raw.Total ?? 0));
  return {
    externalId: raw.BankTransactionID,
    bankAccountExternalId: raw.BankAccount?.AccountID ?? '',
    date: (raw.DateString ?? raw.Date ?? '').slice(0, 10),
    amountCents: raw.Type === 'RECEIVE' ? Math.abs(total) : -Math.abs(total),
    description: raw.LineItems?.[0]?.Description ?? raw.Reference ?? '',
    counterparty: raw.Contact?.Name ?? null,
    reference: raw.Reference ?? null,
    status: bankTxnStatus(raw),
    categoryAccountExternalId: raw.LineItems?.[0]?.AccountCode ?? null,
  };
}

export function bankTxnToTxn(raw: any): Txn {
  const wh = bankTxnToWh(raw);
  return {
    id: raw.BankTransactionID,
    date: wh.date,
    amountCents: wh.amountCents,
    description: wh.description,
    counterparty: wh.counterparty ?? undefined,
    reference: wh.reference ?? undefined,
    currency: raw.CurrencyCode ?? undefined,
    source: { system: 'xero', id: raw.BankTransactionID, label: raw.Type },
  };
}

export async function getBankTransactions(
  conn: Connection,
  opts: { modifiedSince?: string } = {},
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ raw: any[]; txns: Txn[]; whRows: WhBankTxn[]; connection: Connection }> {
  let connection = conn;
  const rows: any[] = [];
  let page = 1;
  for (;;) {
    const { json, connection: next } = await xeroRequest(
      connection,
      '/BankTransactions',
      { query: { page: String(page) }, headers: opts.modifiedSince ? { 'If-Modified-Since': opts.modifiedSince } : {} },
      cfg,
      fetchImpl,
    );
    connection = next;
    const batch: any[] = json.BankTransactions ?? [];
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return { raw: rows, txns: rows.map(bankTxnToTxn), whRows: rows.map(bankTxnToWh), connection };
}

// ---------------------------------------------------------------------------
// Journals — the full double-entry GL feed, paged by offset=lastJournalNumber
// ---------------------------------------------------------------------------

export function journalToWhEntry(raw: any): WhEntry {
  const lines: WhLine[] = (raw.JournalLines ?? []).map((jl: any, i: number) => {
    const net = dollarsToCents(Number(jl.NetAmount ?? 0));
    return {
      lineNo: i + 1,
      accountExternalId: jl.AccountID ?? jl.AccountCode ?? '',
      contactExternalId: null,
      description: jl.Description ?? null,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
      dimensions: {},
    };
  });
  return {
    externalId: raw.JournalID,
    sourceType: raw.SourceType ?? 'Journal',
    number: raw.JournalNumber != null ? String(raw.JournalNumber) : null,
    date: (raw.JournalDate ?? '').slice(0, 10),
    memo: raw.Reference ?? null,
    currency: null,
    status: null,
    updatedAt: raw.CreatedDateUTC ?? null,
    lines,
  };
}

/** `offset` is the last JournalNumber seen — pass 0 (or omit) for a full pull. Stops on a page under 100. */
export async function getJournals(
  conn: Connection,
  offset: number,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ entries: WhEntry[]; nextOffset: number; connection: Connection }> {
  let connection = conn;
  const entries: WhEntry[] = [];
  let cursor = offset;
  for (;;) {
    const { json, connection: next } = await xeroRequest(
      connection,
      '/Journals',
      { query: { offset: String(cursor) } },
      cfg,
      fetchImpl,
    );
    connection = next;
    const batch: any[] = json.Journals ?? [];
    if (batch.length === 0) break;
    entries.push(...batch.map(journalToWhEntry));
    cursor = Math.max(...batch.map((j) => Number(j.JournalNumber ?? cursor)));
    if (batch.length < 100) break;
  }
  return { entries, nextOffset: cursor, connection };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function getTrialBalance(
  conn: Connection,
  date: string,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ report: any; connection: Connection }> {
  const { json, connection } = await xeroRequest(conn, '/Reports/TrialBalance', { query: { date } }, cfg, fetchImpl);
  return { report: json, connection };
}

// ---------------------------------------------------------------------------
// Post a ManualJournal
// ---------------------------------------------------------------------------

export function buildManualJournalPayload(
  je: JournalEntry,
  accountCodeMap: Record<string, string>,
  approval: Approval,
): any {
  const approverNote = `Approved by ${approval.approvers.map((a) => `${a.name} (${a.role})`).join(', ')}.`;
  return {
    // Verify: Xero's create endpoints wrap the payload in the plural entity
    // key, consistent with every other Accounting API array endpoint; I
    // could not fetch a live example to confirm ManualJournals specifically.
    ManualJournals: [
      {
        Narration: `${je.memo} — ${approverNote}`.slice(0, 250),
        Date: je.date,
        Status: 'POSTED',
        JournalLines: je.lines.map((line) => ({
          LineAmount: line.debitCents > 0 ? centsToDollars(line.debitCents) : -centsToDollars(line.creditCents),
          AccountCode: accountCodeMap[line.account],
          Description: line.description,
        })),
      },
    ],
  };
}

export async function createManualJournal(
  conn: Connection,
  je: JournalEntry,
  approval: Approval,
  accountCodeMap: Record<string, string>,
  cfg: XeroConfig = getXeroConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ externalId: string; connection: Connection }> {
  const payload = buildManualJournalPayload(je, accountCodeMap, approval);
  const { json, connection } = await xeroRequest(
    conn,
    '/ManualJournals',
    { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': je.idempotencyKey } },
    cfg,
    fetchImpl,
  );
  return { externalId: json.ManualJournals[0].ManualJournalID, connection };
}

export { ProviderHttpError };
