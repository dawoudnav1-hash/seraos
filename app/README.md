# Vert prospects — account, lead and outreach tracker

A static single-page app (Vite + React 19 + TypeScript, no backend) for Vert's B2B outreach to Australian
finance teams and accounting firms. It has three views plus a data page:

- **Dashboard**: outreach KPIs, weekly activity, funnel, channel/section/segment/city breakdowns, coverage, recent
  activity.
- **Accounts**: tabs for *Accounting & advisory firms* / *Internal finance teams* / *1-person* / *All*, grouped by
  segment, with an *All · Not contacted · Contacted* toggle and City / State filters. Click a row to expand the
  account: overview, alpha/signal, finance team, contacts, and a timeline. Each contact has buttons to log outreach.
- **Contacts**: flat, searchable list of every lead, with the same toggle and City / State filters. Click one to open
  its account.
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

### Contacted vs not contacted

**Contacted** means a derived status other than *Not contacted*, i.e. at least one matched event of any kind (sent,
connection, seen, replied, meeting — imported or logged here); `isContacted()` in `status.ts`. A contact uses its own
status, an account its account status (so a contacted account can still have not-contacted contacts).

- The toggle and the detailed *Outreach* select share one state (`OutreachFilter` in `filters.ts`): picking
  *Not contacted* in either moves the other, a specific status (Seen, Replied…) implies *Contacted*, and leaving
  *Contacted* clears it. The toggle's counts apply every other filter (section tab, search, city, …) but not the
  outreach filter itself, so *Not contacted + Contacted = All*; the section tab counts include the toggle.
- If you log an event on an open account so that it no longer matches the toggle, it stays on screen (marked
  "Now contacted") until you collapse it or change a filter.

### City

`city` / `suburb` / `state` / `cityBasis` come from the pipeline (see `DATA_CONTRACT.md`); a contact's city is its
account's. A missing city is "Unknown" and a missing state (e.g. Tauranga, NZ) is "No state" in the filters. The City
column shows city with "suburb, state" underneath and sorts unknowns last; the raw *Location* column is hidden by
default (Columns menu). Search matches city, suburb and state. Choosing a State clears a City outside that state.
CSV exports include City, Suburb and State.

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
- **Not contacted / Contacted** (section, segment and city tables): accounts with no event / at least one event,
  over **all time** — they ignore the date range, so they always match the Accounts view. *Touched* is the
  range-dependent counterpart (accounts with an event in the range); with *All* the two agree.
- **By city**: the 12 cities with the most accounts, then *Other* (the rest, summed), then *Unknown*. Accounts,
  Contacts and Contacted / Not contacted are all time; Sent, Replies and Meetings count events in the range. Each event
  counts once, under the city of the account it was logged against (its `accountId`, else the first account it
  matched); unmatched events are left out, so the rows add up to the Total row. Clicking a city opens
  `#/accounts?city=<city>` (All tab, other filters cleared).
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
