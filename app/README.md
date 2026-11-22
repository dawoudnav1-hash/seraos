# Vert prospects — account, lead and outreach tracker

A static single-page app (Vite + React 19 + TypeScript, no backend) for Vert's B2B outreach to Australian
finance teams and accounting firms. It has three views plus a data page:

- **Dashboard**: outreach KPIs, weekly activity, funnel, channel/section/segment breakdowns, coverage, recent activity.
- **Accounts**: tabs for *Accounting & advisory firms* / *Internal finance teams* / *1-person* / *All*, grouped by
  segment. Click a row to expand the account: overview, alpha/signal, finance team, contacts, and a timeline. Each
  contact has buttons to log outreach.
- **Contacts**: flat, searchable list of every lead. Click one to open its account.
- **Data**: export, import or clear manually logged events, plus when the data was generated and where it came from.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # tsc --noEmit (app + config) then vite build
```

The build is a **single self-contained file**, `dist/index.html`, with JS, CSS and data inlined by
`vite-plugin-singlefile`. You can open it straight from disk or host it as one page. `npm run preview` serves it on
port 4173.

## Test

```bash
npm test                         # Vitest unit tests (src/lib/*.test.ts)
npm run build && npm run e2e     # Playwright smoke test against dist/ (starts vite preview itself)
```

`e2e/smoke.mjs` is a plain Node script. It uses the preinstalled Chromium (it does not run `playwright install`) and
writes screenshots to `e2e/screenshots/`. If something is already serving on `PORT` (default 4173), the script uses
that server.

## Where the data comes from

- `src/data/accounts.json` (`Account[]`) and `src/data/outreach.json` (`{ generatedAt, sources, events }`) are
  produced by `pipeline/build_data.py`. Don't edit them by hand. The exact types are in `DATA_CONTRACT.md` and are
  copied verbatim into `src/types.ts`.
- Both files are bundled at build time as raw text and parsed defensively (`src/lib/data.ts`). If a field is missing
  or mistyped, the app normalises it instead of crashing. Duplicate ids are dropped, and the Data page shows a
  warning.
- `src/__fixtures__/` holds a small hand-written dataset used only by the unit tests. `src/lib/realData.test.ts`
  checks invariants (unique ids, section counts add up, stats computable) against whatever is in `src/data/`.
- **Manual events** are what you log with the buttons in the app. They are stored in this browser's `localStorage`
  under the key `seraos.manualEvents.v1`, with `source: 'manual'`. Everywhere stats are computed, they are merged
  with the generated events and de-duplicated by `id`; on an id collision the generated event wins. Use
  *Data → Export JSON* to back them up. If storage is unavailable, the app still works, but logged events only last
  for the session.

## How events are matched and status is derived (`src/lib/status.ts`)

An event **belongs to a contact** when its `contactId` matches a known contact. Otherwise it belongs to every contact
whose email equals one of the event's `counterpartyEmails` (case-insensitive). An event **belongs to an account** when
its `accountId` matches a known account, and also to the account of every contact it matched. Events that match
neither still count toward message totals. The dashboard reports them as "unmatched".

The **outreach status** of a contact or account is the highest-precedence event attached to it:

| Status        | Triggered by                                                                       |
| ------------- | ---------------------------------------------------------------------------------- |
| Meeting       | `meeting`                                                                          |
| Replied       | `reply`                                                                            |
| Seen          | `opened`, `message_seen`, or any event with `seenFlag === true`                    |
| Contacted     | `sent`, `message_sent`, `connection_sent`, `connection_accepted`                   |
| Not contacted | no events                                                                          |

Precedence is Meeting > Replied > Seen > Contacted > Not contacted. *Last touch* is the newest dated event.

## Stat definitions (`src/lib/stats.ts`)

These follow *Kind semantics* in `DATA_CONTRACT.md`.

- **Messages sent**: `sent` + `message_sent` + `connection_sent`, split by `channel`.
- **Seen**: `opened` + `message_seen` + events with `seenFlag === true`. When no event in the whole dataset carries
  seen information, the tile says so and suggests logging "Seen" manually.
- **Replies**: number of `reply` events. **Reply rate**: unique people who replied *and* were messaged ÷ unique people messaged (so it never exceeds 100%; a reply from someone with no tracked outbound message still counts under Replies). A person
  is a matched contact; failing that, the first counterparty email; failing that, the person name. If nobody was
  messaged, the rate is shown as "—".
- **Accounts touched / Contacts reached**: accounts or contacts with at least one event in the selected range.
- **Funnel**: known contacts whose derived status reached at least each stage in the range.
- **Date ranges**: 7d, 30d and 90d keep events dated on or after `now − N days`. The lower bound is inclusive and there
  is no upper bound, so slightly future-dated events are not dropped. *All* keeps everything, including events
  without a valid date (these are left out of the weekly chart). Weeks start Monday, in UTC.

## Notes

- Links are sanitised so that only `http(s)` and `mailto` URLs are rendered. All text is rendered as text; there is no
  `dangerouslySetInnerHTML`.
- UI preferences (section tab, filters, sort, hidden columns, collapsed groups, dashboard range) persist in
  `localStorage` under `seraos.*` keys.
- Deep links: `#/accounts/<accountId>` opens that account expanded and scrolled into view.
  `?contact=<contactId>` also highlights one contact.
