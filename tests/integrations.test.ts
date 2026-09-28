/**
 * QuickBooks Online / Xero connectors — all network access is mocked; no
 * test touches the real internet. See lib/integrations/README.md for what
 * is verified against provider docs vs. best-effort.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { JournalEntry } from '@/lib/engine/types';
import {
  IntegrationConfigError,
  OAuthStateError,
  TokenDecryptionError,
  decryptTokens,
  encryptTokens,
  exchangeCodeForToken,
  getEncryptionKey,
  refreshAccessToken,
  signState,
  verifyState,
  type TokenSet,
} from '@/lib/integrations/oauth';
import { ProviderHttpError, fetchWithBackoff, parseRetryAfterMs } from '@/lib/integrations/http';
import { centsToDollars, dollarsToCents, type FetchLike } from '@/lib/integrations/util';
import {
  InMemoryConnectionStore,
  getConnectionStore,
  setConnectionStore,
  type Connection,
} from '@/lib/integrations/store';
import { InMemoryLedgerSink } from '@/lib/integrations/sink';
import { syncClient } from '@/lib/integrations/sync';
import * as quickbooks from '@/lib/integrations/quickbooks';
import * as xero from '@/lib/integrations/xero';
import {
  InMemoryPostingLedger,
  PostingRefusedError,
  postJournalEntry,
  setPostingLedger,
  type Approval,
} from '@/lib/integrations/posting';
import { GET as connectGET } from '@/app/api/integrations/[provider]/connect/route';
import { GET as statusGET } from '@/app/api/integrations/[provider]/status/route';

// ---------------------------------------------------------------------------
// Test-only fixtures and mock fetch helpers
// ---------------------------------------------------------------------------

process.env.VERT_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
process.env.QBO_CLIENT_ID = 'qbo-client-id';
process.env.QBO_CLIENT_SECRET = 'qbo-client-secret';
process.env.QBO_REDIRECT_URI = 'https://app.example.com/api/integrations/quickbooks/callback';
process.env.QBO_ENVIRONMENT = 'sandbox';
process.env.XERO_CLIENT_ID = 'xero-client-id';
process.env.XERO_CLIENT_SECRET = 'xero-client-secret';
process.env.XERO_REDIRECT_URI = 'https://app.example.com/api/integrations/xero/callback';

const qboCfg: quickbooks.QboConfig = {
  clientId: 'qbo-id',
  clientSecret: 'qbo-secret',
  redirectUri: 'https://app.example.com/cb',
  environment: 'sandbox',
};
const xeroCfg: xero.XeroConfig = {
  clientId: 'xero-id',
  clientSecret: 'xero-secret',
  redirectUri: 'https://app.example.com/xcb',
};

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Consumes mock responses strictly in order; throws if a test asks for more than it scripted. */
function sequentialFetch(script: Array<Response>): { fetchImpl: FetchLike; calls: { url: string; init: any }[] } {
  const calls: { url: string; init: any }[] = [];
  let i = 0;
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    if (i >= script.length) throw new Error(`sequentialFetch: no scripted response for call #${i} (${String(input)})`);
    return script[i++];
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

/** Routes by a URL predicate — for flows that hit several distinct endpoints in one run. */
function routerFetch(
  handlers: Array<{ test: (url: string) => boolean; respond: (url: string, init: any) => Response }>,
): { fetchImpl: FetchLike; calls: { url: string; init: any }[] } {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = handlers.find((h) => h.test(url));
    if (!handler) throw new Error(`routerFetch: no handler matched ${url}`);
    return handler.respond(url, init);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function makeConnection(provider: 'quickbooks' | 'xero', overrides: Partial<Connection> = {}): Connection {
  const tokens: TokenSet = {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    tokenType: 'bearer',
    scope: 'x',
  };
  const at = new Date().toISOString();
  return {
    provider,
    client: 'acme-co',
    externalId: provider === 'quickbooks' ? 'realm-123' : 'tenant-123',
    tokensEnc: encryptTokens(tokens),
    status: 'connected',
    scopes: ['x'],
    connectedAt: at,
    updatedAt: at,
    lastSyncAt: null,
    ...overrides,
  };
}

function entityFromQuery(url: string): string | null {
  const q = new URL(url).searchParams.get('query') ?? '';
  return q.match(/FROM\s+(\w+)/)?.[1] ?? null;
}

const validJe: JournalEntry = {
  id: 'je-2026-0301',
  date: '2026-03-01',
  type: 'manual',
  memo: 'Reclass March rent from suspense',
  lines: [
    {
      account: '6410',
      description: 'Rent expense',
      debitCents: 123456,
      creditCents: 0,
      sources: [{ system: 'upload', id: 'lease-2026-03.pdf' }],
    },
    {
      account: '1000',
      description: 'Cash',
      debitCents: 0,
      creditCents: 123456,
      sources: [{ system: 'bank', id: 'txn-9981' }],
    },
  ],
  attachments: [],
  idempotencyKey: 'idem-je-2026-0301',
};

const twoApprovers: Approval = {
  approvalId: 'appr-1',
  approvers: [
    { name: 'Alice Chen', role: 'Controller' },
    { name: 'Bob Diaz', role: 'CFO' },
  ],
};

beforeEach(() => {
  setConnectionStore(new InMemoryConnectionStore());
  setPostingLedger(new InMemoryPostingLedger());
});

// ---------------------------------------------------------------------------
// oauth.ts — signed state
// ---------------------------------------------------------------------------

describe('OAuth state', () => {
  it('signs and verifies a state round-trip', () => {
    const state = signState({ provider: 'quickbooks', client: 'acme-co' });
    const payload = verifyState(state);
    expect(payload.provider).toBe('quickbooks');
    expect(payload.client).toBe('acme-co');
    expect(payload.nonce).toHaveLength(32);
  });

  it('rejects a tampered state', () => {
    const state = signState({ provider: 'xero', client: 'acme-co' });
    const [payloadPart, sigPart] = state.split('.');
    // Flip the client id in the payload without re-signing.
    const tamperedPayload = Buffer.from(payloadPart, 'base64url').toString('utf8').replace('acme-co', 'evil-co');
    const tampered = `${Buffer.from(tamperedPayload).toString('base64url')}.${sigPart}`;
    expect(() => verifyState(tampered)).toThrow(OAuthStateError);
  });

  it('rejects an expired state', () => {
    const state = signState({ provider: 'quickbooks', client: 'acme-co', ttlSeconds: -1 });
    expect(() => verifyState(state)).toThrow(/expired/i);
  });
});

// ---------------------------------------------------------------------------
// oauth.ts — token encryption at rest
// ---------------------------------------------------------------------------

describe('Token encryption', () => {
  const tokens: TokenSet = {
    accessToken: 'access-xyz',
    refreshToken: 'refresh-xyz',
    expiresAt: new Date().toISOString(),
    tokenType: 'bearer',
  };

  it('round-trips a TokenSet through AES-256-GCM', () => {
    const blob = encryptTokens(tokens);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(decryptTokens(blob)).toEqual(tokens);
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptTokens(tokens, getEncryptionKey());
    const wrongKey = Buffer.from('b'.repeat(32));
    expect(() => decryptTokens(blob, wrongKey)).toThrow(TokenDecryptionError);
  });

  it('throws a clear error when VERT_ENCRYPTION_KEY is missing or the wrong length', () => {
    expect(() => getEncryptionKey('')).toThrow(IntegrationConfigError);
    expect(() => getEncryptionKey('dG9vLXNob3J0')).toThrow(IntegrationConfigError); // "too-short" base64
  });
});

// ---------------------------------------------------------------------------
// oauth.ts — code/refresh HTTP shape
// ---------------------------------------------------------------------------

describe('Token exchange HTTP shape', () => {
  it('sends Basic auth and a form-encoded body on code exchange', async () => {
    const { fetchImpl, calls } = sequentialFetch([
      jsonRes(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, token_type: 'bearer' }),
    ]);
    const tokens = await exchangeCodeForToken(
      { clientId: 'id1', clientSecret: 'secret1', tokenUrl: 'https://example.com/token' },
      'auth-code-123',
      'https://app.example.com/cb',
      fetchImpl,
    );
    expect(tokens.accessToken).toBe('at1');
    expect(tokens.refreshToken).toBe('rt1');
    const [call] = calls;
    expect(call.url).toBe('https://example.com/token');
    expect(call.init.headers.Authorization).toBe(`Basic ${Buffer.from('id1:secret1').toString('base64')}`);
    expect(call.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-123');
    expect(body.get('redirect_uri')).toBe('https://app.example.com/cb');
  });

  it('sends grant_type=refresh_token on refresh', async () => {
    const { fetchImpl, calls } = sequentialFetch([
      jsonRes(200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
    ]);
    await refreshAccessToken(
      { clientId: 'id1', clientSecret: 'secret1', tokenUrl: 'https://example.com/token' },
      'old-refresh-token',
      fetchImpl,
    );
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
  });
});

// ---------------------------------------------------------------------------
// http.ts — 429 backoff
// ---------------------------------------------------------------------------

describe('429 backoff', () => {
  it('honors Retry-After and retries until success', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      return jsonRes(200, { ok: true });
    }) as unknown as FetchLike;

    const res = await fetchWithBackoff(
      'https://example.com/thing',
      { method: 'GET' },
      { fetchImpl, sleepImpl: async (ms) => void sleeps.push(ms) },
    );
    expect(res.status).toBe(200);
    expect(call).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('parses a Retry-After header in seconds, defaulting to 1s when absent', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(null)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// QuickBooks client
// ---------------------------------------------------------------------------

describe('QuickBooks client', () => {
  it('refreshes an expired-looking 401 once, then retries the request', async () => {
    const conn = makeConnection('quickbooks');
    const { fetchImpl, calls } = sequentialFetch([
      new Response('', { status: 401 }),
      jsonRes(200, { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }),
      jsonRes(200, { QueryResponse: { Account: [] } }),
    ]);
    const { json, connection } = await quickbooks.qboRequest(conn, '/query', { extraQuery: { query: 'SELECT * FROM Account' } }, qboCfg, fetchImpl);
    expect(json).toEqual({ QueryResponse: { Account: [] } });
    expect(calls).toHaveLength(3);
    expect(calls[1].url).toBe(quickbooks.QBO_TOKEN_URL);
    expect(decryptTokens(connection.tokensEnc).accessToken).toBe('fresh-at');
  });

  it('builds the JournalEntry payload with exact cent-derived amounts, PostingType and AccountRef', () => {
    const payload = quickbooks.buildJournalEntryPayload(
      validJe,
      { '6410': '55', '1000': '35' },
      twoApprovers,
    );
    expect(payload.TxnDate).toBe('2026-03-01');
    expect(payload.DocNumber).toBe('je-2026-0301');
    expect(payload.PrivateNote).toContain('Alice Chen (Controller)');
    expect(payload.Line).toEqual([
      {
        Description: 'Rent expense',
        Amount: 1234.56,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '55' } },
      },
      {
        Description: 'Cash',
        Amount: 1234.56,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '35' } },
      },
    ]);
  });

  it('posts the JournalEntry with requestid derived from idempotencyKey', async () => {
    const conn = makeConnection('quickbooks');
    const { fetchImpl, calls } = sequentialFetch([jsonRes(200, { JournalEntry: { Id: '777' } })]);
    const { externalId } = await quickbooks.createJournalEntry(
      conn,
      validJe,
      twoApprovers,
      { '6410': '55', '1000': '35' },
      qboCfg,
      fetchImpl,
    );
    expect(externalId).toBe('777');
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('requestid')).toBe('idem-je-2026-0301');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body).Line).toHaveLength(2);
  });

  it('paginates the Query API with STARTPOSITION/MAXRESULTS until a short page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), Name: `Acct ${i + 1}`, AccountType: 'Bank', Active: true }));
    const page2 = [{ Id: '1001', Name: 'Last one', AccountType: 'Bank', Active: true }];
    const { fetchImpl, calls } = sequentialFetch([
      jsonRes(200, { QueryResponse: { Account: page1 } }),
      jsonRes(200, { QueryResponse: { Account: page2 } }),
    ]);
    const { rows } = await quickbooks.queryAll(makeConnection('quickbooks'), 'Account', null, qboCfg, fetchImpl);
    expect(rows).toHaveLength(1001);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get('query')).toContain('STARTPOSITION 1 MAXRESULTS 1000');
    expect(new URL(calls[1].url).searchParams.get('query')).toContain('STARTPOSITION 1001 MAXRESULTS 1000');
  });

  it('normalizes a QBO Account payload, converting CurrentBalance to exact cents', () => {
    const account = quickbooks.normalizeAccount({
      Id: '55',
      AcctNum: '6410',
      Name: 'Rent Expense',
      AccountType: 'Expense',
      AccountSubType: 'RentOrLeaseOfBuildings',
      Active: true,
      CurrentBalance: 1234.56,
    });
    expect(account).toEqual({
      id: '55',
      code: '6410',
      name: 'Rent Expense',
      qboType: 'Expense',
      qboSubType: 'RentOrLeaseOfBuildings',
      active: true,
      currentBalanceCents: 123456,
    });
  });

  it('normalizes a JournalReport into WhEntry rows whose lines balance to the cent', () => {
    const report = {
      Header: { ReportName: 'JournalReport', Currency: 'USD' },
      Columns: {
        Column: [
          { ColTitle: 'Date', ColType: 'tx_date' },
          { ColTitle: 'Transaction Type', ColType: 'txn_type' },
          { ColTitle: 'No.', ColType: 'doc_num' },
          { ColTitle: 'Name', ColType: 'name' },
          { ColTitle: 'Memo/Description', ColType: 'memo' },
          { ColTitle: 'Account', ColType: 'account_name' },
          { ColTitle: 'Debit', ColType: 'subt_nat_amount' },
          { ColTitle: 'Credit', ColType: 'credit_amt' },
        ],
      },
      Rows: {
        Row: [
          {
            type: 'Data',
            ColData: [
              { value: '2026-02-01' },
              { value: 'Journal Entry' },
              { value: '1001' },
              { value: 'Acme Co', id: 'c1' },
              { value: 'Monthly rent accrual' },
              { value: 'Rent Expense', id: '60' },
              { value: '1234.56' },
              { value: '' },
            ],
          },
          {
            type: 'Data',
            ColData: [
              { value: '2026-02-01' },
              { value: 'Journal Entry' },
              { value: '1001' },
              { value: 'Acme Co', id: 'c1' },
              { value: 'Monthly rent accrual' },
              { value: 'Accrued Liabilities', id: '61' },
              { value: '' },
              { value: '1234.56' },
            ],
          },
        ],
      },
    };
    const entries = quickbooks.normalizeJournalReport(report);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.number).toBe('1001');
    expect(entry.date).toBe('2026-02-01');
    expect(entry.lines).toHaveLength(2);
    const totalDebit = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    const totalCredit = entry.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(totalDebit).toBe(123456);
    expect(totalDebit).toBe(totalCredit);
    expect(entry.lines.map((l) => l.accountExternalId)).toEqual(['60', '61']);
  });
});

// ---------------------------------------------------------------------------
// Xero client
// ---------------------------------------------------------------------------

describe('Xero client', () => {
  it('refreshes an expired-looking 401 once, then retries the request', async () => {
    const conn = makeConnection('xero');
    const { fetchImpl, calls } = sequentialFetch([
      new Response('', { status: 401 }),
      jsonRes(200, { access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 1800 }),
      jsonRes(200, { Accounts: [] }),
    ]);
    const { json, connection } = await xero.xeroRequest(conn, '/Accounts', {}, xeroCfg, fetchImpl);
    expect(json).toEqual({ Accounts: [] });
    expect(calls).toHaveLength(3);
    expect(calls[2].init.headers['xero-tenant-id']).toBe(conn.externalId);
    expect(decryptTokens(connection.tokensEnc).accessToken).toBe('fresh-at');
  });

  it('builds the ManualJournal payload with signed LineAmount (+debit/-credit) and AccountCode', () => {
    const payload = xero.buildManualJournalPayload(validJe, { '6410': '400', '1000': '090' }, twoApprovers);
    const [mj] = payload.ManualJournals;
    expect(mj.Date).toBe('2026-03-01');
    expect(mj.Status).toBe('POSTED');
    expect(mj.JournalLines).toEqual([
      { LineAmount: 1234.56, AccountCode: '400', Description: 'Rent expense' },
      { LineAmount: -1234.56, AccountCode: '090', Description: 'Cash' },
    ]);
  });

  it('posts the ManualJournal with the Idempotency-Key header from idempotencyKey', async () => {
    const conn = makeConnection('xero');
    const { fetchImpl, calls } = sequentialFetch([jsonRes(200, { ManualJournals: [{ ManualJournalID: 'mj-1' }] })]);
    const { externalId } = await xero.createManualJournal(conn, validJe, twoApprovers, { '6410': '400', '1000': '090' }, xeroCfg, fetchImpl);
    expect(externalId).toBe('mj-1');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('idem-je-2026-0301');
    expect(calls[0].init.method).toBe('POST');
  });

  it('paginates Contacts by `page` until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ContactID: `c${i + 1}`, Name: `Contact ${i + 1}`, ContactStatus: 'ACTIVE' }));
    const page2 = Array.from({ length: 30 }, (_, i) => ({ ContactID: `c${i + 101}`, Name: `Contact ${i + 101}`, ContactStatus: 'ACTIVE' }));
    const { fetchImpl, calls } = sequentialFetch([jsonRes(200, { Contacts: page1 }), jsonRes(200, { Contacts: page2 })]);
    const { contacts } = await xero.getContacts(makeConnection('xero'), xeroCfg, fetchImpl);
    expect(contacts).toHaveLength(130);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get('page')).toBe('1');
    expect(new URL(calls[1].url).searchParams.get('page')).toBe('2');
  });

  it('paginates Journals by offset=lastJournalNumber and advances the cursor', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      JournalID: `j${i + 1}`,
      JournalNumber: i + 1,
      JournalDate: '2026-01-01',
      JournalLines: [
        { AccountCode: '400', NetAmount: 10 },
        { AccountCode: '090', NetAmount: -10 },
      ],
    }));
    const page2 = Array.from({ length: 40 }, (_, i) => ({
      JournalID: `j${i + 101}`,
      JournalNumber: i + 101,
      JournalDate: '2026-01-02',
      JournalLines: [
        { AccountCode: '400', NetAmount: 5 },
        { AccountCode: '090', NetAmount: -5 },
      ],
    }));
    const { fetchImpl, calls } = sequentialFetch([jsonRes(200, { Journals: page1 }), jsonRes(200, { Journals: page2 })]);
    const { entries, nextOffset } = await xero.getJournals(makeConnection('xero'), 0, xeroCfg, fetchImpl);
    expect(entries).toHaveLength(140);
    expect(nextOffset).toBe(140);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get('offset')).toBe('0');
    expect(new URL(calls[1].url).searchParams.get('offset')).toBe('100');
    // Debit-first sign convention: positive NetAmount -> debit, negative -> credit.
    expect(entries[0].lines[0]).toMatchObject({ debitCents: 1000, creditCents: 0 });
    expect(entries[0].lines[1]).toMatchObject({ debitCents: 0, creditCents: 1000 });
  });

  it('normalizes a BankTransactions payload into a signed Txn and a WhBankTxn', () => {
    const receive = {
      BankTransactionID: 'bt-1',
      Type: 'RECEIVE',
      Date: '2026-04-01T00:00:00',
      Total: 500,
      IsReconciled: false,
      Contact: { Name: 'Big Customer' },
      Reference: 'INV-100',
      BankAccount: { AccountID: 'bank-1' },
      LineItems: [{ Description: 'Invoice payment', AccountCode: '200' }],
    };
    const spend = { ...receive, BankTransactionID: 'bt-2', Type: 'SPEND', IsReconciled: true };

    const receiveTxn = xero.bankTxnToTxn(receive);
    expect(receiveTxn.amountCents).toBe(50000);
    expect(receiveTxn.counterparty).toBe('Big Customer');

    const spendWh = xero.bankTxnToWh(spend);
    expect(spendWh.amountCents).toBe(-50000);
    expect(spendWh.status).toBe('matched'); // IsReconciled -> matched

    const unreviewedWh = xero.bankTxnToWh({ ...receive, BankTransactionID: 'bt-3', LineItems: [] });
    expect(unreviewedWh.status).toBe('unreviewed');
  });

  it('normalizes an Accounts payload into WhAccount', () => {
    const wh = xero.accountToWh({ AccountID: 'a1', Code: '400', Name: 'Rent', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' });
    expect(wh).toMatchObject({ externalId: 'a1', code: '400', name: 'Rent', providerType: 'EXPENSE', active: true });
  });
});

// ---------------------------------------------------------------------------
// util.ts — exact cents <-> dollars conversion
// ---------------------------------------------------------------------------

describe('Cents <-> dollars conversion', () => {
  it('converts cents to an exact two-decimal dollar number', () => {
    expect(centsToDollars(123456)).toBe(1234.56);
    expect(centsToDollars(100000)).toBe(1000);
    expect(centsToDollars(-9950)).toBe(-99.5);
    expect(centsToDollars(5)).toBe(0.05);
  });

  it('converts dollars back to exact cents, avoiding binary float drift', () => {
    expect(dollarsToCents(19.99)).toBe(1999);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30); // the classic float trap: 0.1+0.2 = 0.30000000000000004
    expect(dollarsToCents(1234.56)).toBe(123456);
  });
});

// ---------------------------------------------------------------------------
// posting.ts — the refusal gate and idempotency
// ---------------------------------------------------------------------------

describe('postJournalEntry refusals', () => {
  it('refuses a single approver', async () => {
    const approval: Approval = { approvalId: 'a1', approvers: [{ name: 'Alice', role: 'Controller' }] };
    await expect(postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je: validJe, approval })).rejects.toMatchObject({
      code: 'insufficient_approvals',
    });
  });

  it('refuses the same approver counted twice', async () => {
    const approval: Approval = {
      approvalId: 'a2',
      approvers: [
        { name: 'Alice Chen', role: 'Controller' },
        { name: '  alice chen ', role: 'Controller' },
      ],
    };
    await expect(postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je: validJe, approval })).rejects.toMatchObject({
      code: 'duplicate_approver',
    });
  });

  it('refuses an entry that does not balance', async () => {
    const unbalanced: JournalEntry = {
      ...validJe,
      idempotencyKey: 'idem-unbalanced',
      lines: [{ ...validJe.lines[0] }, { ...validJe.lines[1], creditCents: 100 }],
    };
    await expect(postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je: unbalanced, approval: twoApprovers })).rejects.toMatchObject({
      code: 'unbalanced',
    });
  });

  it('refuses a line with no source', async () => {
    const unsourced: JournalEntry = {
      ...validJe,
      idempotencyKey: 'idem-unsourced',
      lines: [{ ...validJe.lines[0], sources: [] }, validJe.lines[1]],
    };
    await expect(postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je: unsourced, approval: twoApprovers })).rejects.toMatchObject({
      code: 'missing_source',
    });
  });

  it('refuses an account with no provider mapping', async () => {
    await getConnectionStore().put(makeConnection('quickbooks'));
    const { fetchImpl } = sequentialFetch([
      jsonRes(200, { QueryResponse: { Account: [{ Id: '99', AcctNum: '9999', Name: 'Unrelated', AccountType: 'Expense', Active: true }] } }),
    ]);
    const je: JournalEntry = { ...validJe, idempotencyKey: 'idem-unmapped' };
    await expect(postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je, approval: twoApprovers }, { fetchImpl })).rejects.toMatchObject({
      code: 'unmapped_account',
    });
  });

  it('refuses when there is no connected account', async () => {
    const je: JournalEntry = { ...validJe, idempotencyKey: 'idem-not-connected' };
    await expect(postJournalEntry({ provider: 'xero', client: 'no-such-client', je, approval: twoApprovers })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });
});

describe('postJournalEntry idempotency', () => {
  it('posts once, then returns the cached result without a second network call', async () => {
    await getConnectionStore().put(makeConnection('quickbooks'));
    const { fetchImpl, calls } = sequentialFetch([
      jsonRes(200, { QueryResponse: { Account: [
        { Id: '55', AcctNum: '6410', Name: 'Rent', AccountType: 'Expense', Active: true },
        { Id: '35', AcctNum: '1000', Name: 'Cash', AccountType: 'Bank', Active: true },
      ] } }),
      jsonRes(200, { JournalEntry: { Id: '777' } }),
    ]);
    const je: JournalEntry = { ...validJe, idempotencyKey: 'idem-repeat-post' };

    const first = await postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je, approval: twoApprovers }, { fetchImpl });
    expect(first.externalId).toBe('777');
    expect(calls).toHaveLength(2);

    const second = await postJournalEntry({ provider: 'quickbooks', client: 'acme-co', je, approval: twoApprovers }, { fetchImpl });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2); // no additional call
  });
});

// ---------------------------------------------------------------------------
// sync.ts — full-then-incremental sync, QBO CDC cursor advance
// ---------------------------------------------------------------------------

describe('QuickBooks sync', () => {
  const journalReportFixture = {
    Header: { Currency: 'USD' },
    Columns: {
      Column: [
        { ColType: 'tx_date' },
        { ColType: 'txn_type' },
        { ColType: 'doc_num' },
        { ColType: 'name' },
        { ColType: 'memo' },
        { ColType: 'account_name' },
        { ColType: 'subt_nat_amount' },
        { ColType: 'credit_amt' },
      ],
    },
    Rows: {
      Row: [
        { type: 'Data', ColData: [{ value: '2026-02-01' }, { value: 'Journal Entry' }, { value: '1001' }, { value: 'Acme Co', id: 'c1' }, { value: 'Rent' }, { value: 'Rent Expense', id: '60' }, { value: '100.00' }, { value: '' }] },
        { type: 'Data', ColData: [{ value: '2026-02-01' }, { value: 'Journal Entry' }, { value: '1001' }, { value: 'Acme Co', id: 'c1' }, { value: 'Rent' }, { value: 'Cash', id: '61' }, { value: '' }, { value: '100.00' }] },
      ],
    },
  };

  function qboSyncHandlers() {
    return [
      { test: (u: string) => u.includes('/reports/JournalReport'), respond: () => jsonRes(200, journalReportFixture) },
      { test: (u: string) => u.includes('/cdc'), respond: () => jsonRes(200, { CDCResponse: [{ QueryResponse: [{ Customer: [{ Id: 'c1', DisplayName: 'Acme Co', Active: true }] }] }] }) },
      {
        test: (u: string) => u.includes('/query'),
        respond: (u: string) => {
          const entity = entityFromQuery(u);
          const rows: Record<string, any[]> = {
            // Every account the journal lines reference must exist — the warehouse enforces it.
            Account: [
              { Id: '55', AcctNum: '6410', Name: 'Rent', AccountType: 'Expense', Active: true },
              { Id: '60', AcctNum: '6400', Name: 'Rent Expense', AccountType: 'Expense', Active: true },
              { Id: '61', AcctNum: '1000', Name: 'Cash', AccountType: 'Bank', Active: true },
            ],
            Customer: [{ Id: 'c1', DisplayName: 'Acme Co', Active: true }],
            Vendor: [{ Id: 'v1', DisplayName: 'Vendor Co', Active: true }],
            Employee: [{ Id: 'e1', DisplayName: 'Employee One', Active: true }],
            Invoice: [{ Id: 'inv1', DocNumber: '1', TxnDate: '2026-01-01', TotalAmt: 500, Balance: 500, CustomerRef: { value: 'c1' } }],
            Bill: [{ Id: 'bill1', DocNumber: '2', TxnDate: '2026-01-02', TotalAmt: 200, Balance: 200, VendorRef: { value: 'v1' } }],
          };
          return jsonRes(200, { QueryResponse: { [entity ?? '']: rows[entity ?? ''] ?? [] } });
        },
      },
    ];
  }

  it('runs a full sync into the LedgerSink and returns counts per entity', async () => {
    await getConnectionStore().put(makeConnection('quickbooks'));
    const sink = new InMemoryLedgerSink();
    const { fetchImpl } = routerFetch(qboSyncHandlers());
    const counts = await syncClient('quickbooks', 'acme-co', { sink, fetchImpl, now: () => new Date('2026-03-15T00:00:00.000Z') });
    expect(counts).toMatchObject({ accounts: 3, contacts: 3, documents: 2, entries: 1, cdc: 1, bankTransactions: 0 });
  });

  it('advances the CDC cursor so a second sync uses the first sync as its changedSince', async () => {
    await getConnectionStore().put(makeConnection('quickbooks'));
    const sink = new InMemoryLedgerSink();

    const run1 = routerFetch(qboSyncHandlers());
    await syncClient('quickbooks', 'acme-co', { sink, fetchImpl: run1.fetchImpl, now: () => new Date('2026-03-15T00:00:00.000Z') });
    const cursorAfterRun1 = await sink.getSyncCursor('quickbooks:realm-123', 'cdc');
    expect(cursorAfterRun1).toBe('2026-03-15T00:00:00.000Z');

    const run2 = routerFetch(qboSyncHandlers());
    await syncClient('quickbooks', 'acme-co', { sink, fetchImpl: run2.fetchImpl, now: () => new Date('2026-03-16T00:00:00.000Z') });
    const cdcCall = run2.calls.find((c) => c.url.includes('/cdc'));
    expect(cdcCall).toBeDefined();
    expect(new URL(cdcCall!.url).searchParams.get('changedSince')).toBe(cursorAfterRun1);

    const cursorAfterRun2 = await sink.getSyncCursor('quickbooks:realm-123', 'cdc');
    expect(cursorAfterRun2).toBe('2026-03-16T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

describe('Integration API routes', () => {
  it('404s for an unknown provider', async () => {
    const res = await connectGET(new Request('http://localhost/api/integrations/foo/connect?client=acme-co'), {
      params: Promise.resolve({ provider: 'foo' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s when a required env var is missing', async () => {
    const saved = process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_ID;
    try {
      const res = await connectGET(new Request('http://localhost/api/integrations/quickbooks/connect?client=acme-co'), {
        params: Promise.resolve({ provider: 'quickbooks' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('QBO_CLIENT_ID');
    } finally {
      process.env.QBO_CLIENT_ID = saved;
    }
  });

  it('redirects to the authorize URL with a verifiable signed state', async () => {
    const res = await connectGET(new Request('http://localhost/api/integrations/quickbooks/connect?client=acme-co'), {
      params: Promise.resolve({ provider: 'quickbooks' }),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(quickbooks.QBO_AUTHORIZE_URL);
    const payload = verifyState(location.searchParams.get('state')!);
    expect(payload).toMatchObject({ provider: 'quickbooks', client: 'acme-co' });
  });

  it('status reports connected:false with no stored connection, then true once one exists', async () => {
    const before = await statusGET(new Request('http://localhost/api/integrations/xero/status?client=acme-co'), {
      params: Promise.resolve({ provider: 'xero' }),
    });
    expect((await before.json()).connected).toBe(false);

    await getConnectionStore().put(makeConnection('xero'));
    const after = await statusGET(new Request('http://localhost/api/integrations/xero/status?client=acme-co'), {
      params: Promise.resolve({ provider: 'xero' }),
    });
    const body = await after.json();
    expect(body.connected).toBe(true);
    expect(body.externalId).toBe('tenant-123');
  });
});

// Re-export used only to keep ProviderHttpError referenced (documents the error type this suite relies on).
void ProviderHttpError;
