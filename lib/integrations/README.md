# QuickBooks Online & Xero connectors

## What this owns

- `lib/integrations/oauth.ts` — signed `state`, AES-256-GCM token encryption, generic OAuth2 code/refresh exchange.
- `lib/integrations/store.ts` — `ConnectionStore` (in-memory; Postgres impl lands separately at `integrations(id, provider, client, external_id, tokens_enc, status, scopes, connected_at, updated_at, last_sync_at)`).
- `lib/integrations/sink.ts` — `LedgerSink` structural interface + in-memory impl the sync route writes through. **Do not add `lib/ledger/**` from this worktree** — the lead re-points this import at `lib/ledger/types.ts` at merge.
- `lib/integrations/quickbooks.ts`, `lib/integrations/xero.ts` — provider clients.
- `lib/integrations/posting.ts` — the only door a `JournalEntry` goes through to actually post.
- `lib/integrations/sync.ts` — full-then-incremental sync into the `LedgerSink`.
- `app/api/integrations/[provider]/{connect,callback,disconnect,status,sync}` — route handlers.

## Creating the developer apps

**Intuit (QuickBooks Online)**

1. Create an app at [developer.intuit.com](https://developer.intuit.com) → "My Apps".
2. Under Keys & OAuth, add a redirect URI matching `QBO_REDIRECT_URI` exactly (must be `https://` outside of `localhost`), e.g. `https://your-app.example.com/api/integrations/quickbooks/callback`.
3. Copy the sandbox (dev) and production client id/secret. Use the sandbox company for `QBO_ENVIRONMENT=sandbox`.
4. Scope requested: `com.intuit.quickbooks.accounting`.

**Xero**

1. Create an app at [developer.xero.com](https://developer.xero.com) → "My Apps" → "Web app".
2. Add a redirect URI matching `XERO_REDIRECT_URI` exactly, e.g. `https://your-app.example.com/api/integrations/xero/callback`.
3. Copy the client id/secret.
4. Scopes requested: `offline_access accounting.transactions accounting.settings accounting.contacts accounting.reports.read accounting.journals.read`.

## Env vars

```
VERT_ENCRYPTION_KEY=      # 32 bytes, base64 or hex — `openssl rand -base64 32`. Encrypts stored tokens AND signs the OAuth `state`.
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=
QBO_ENVIRONMENT=sandbox   # or production
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=
```

Every route and client call throws/`400`s with the exact missing variable name rather than failing silently.

## How posting is gated

`postJournalEntry({ provider, client, je, approval })` (`lib/integrations/posting.ts`) is the **only** path that writes a
journal entry to QuickBooks or Xero. It refuses — with a typed `PostingRefusedError` and a machine-readable `code` — unless:

- there is a connected account for that `provider` + `client`,
- `approval.approvers` has **≥ 2 distinct** people (by name),
- the entry balances to the cent (`sum(debitCents) === sum(creditCents)`),
- every line has at least one `SourceRef`,
- every line's account maps to a real provider account (matched by chart-of-accounts code: QBO's `AcctNum`, Xero's `Code`).

Posting is idempotent on `je.idempotencyKey`: a repeat post with the same key is looked up in the `PostingLedger` **before**
any network call and returns the original result — no second API call, ever. The lead's Postgres implementation
(`ledger_postings(provider, external_id, idempotency_key)`) plugs in via `setPostingLedger()`.

## What QuickBooks' public API cannot give us

QBO's REST API has no endpoint for bank-feed "For Review" transactions (the un-categorized rows sitting in the in-app
banking center before a user matches or adds them) — that queue is UI-only. Anything already categorized shows up as a
`Purchase`/`Deposit`/`Transfer`/`Payment`/`BillPayment`, which the GL/JournalReport pull already covers. If Vert needs the
uncategorized queue itself, it has to come from a bank-feed/Plaid-style connection or a CSV upload, not this connector.

## Sync strategy

- **Full-then-incremental**: the sync route (`syncClient` in `lib/integrations/sync.ts`) checks `LedgerSink.getSyncCursor`
  per entity; a missing cursor means a full pull (accounts/contacts always re-pull in full — they're small), a present one
  means incremental.
- **QuickBooks GL**: `JournalReport` for a date range gives every transaction's journal lines in double-entry form, which
  is why it's preferred over mapping `JournalEntry`/`Purchase`/`Deposit`/`Transfer`/`Payment`/`BillPayment` by hand — one
  parser instead of six. The cursor is the last `end_date` synced.
- **QuickBooks contacts**: `Customer`/`Vendor`/`Employee` changes come from **Change Data Capture**
  (`GET /cdc?entities=...&changedSince=...`); the cursor is `changedSince`.
- **Xero GL**: the system `Journals` feed (`GET /Journals?offset=<lastJournalNumber>`) is Xero's own append-only,
  already-incremental double-entry feed — the cursor is the last `JournalNumber` seen.
- **Xero bank transactions**: `GET /BankTransactions` with `If-Modified-Since`; the cursor is the last sync's timestamp.

## What's verified vs. from memory

Network access to `developer.intuit.com` and `developer.xero.com` was blocked from this sandbox; details below were
confirmed via web search against Intuit/Xero's own docs and blogs where noted, and are flagged `// Verify:` in the source
next to anything I could not confirm that way. See the final report for the full list.
