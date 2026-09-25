# Outbound: a sales agent with a human in the loop

Outbound researches each prospect and their company on the live web and writes a short, specific cold email from what it finds. It follows up in the same Gmail thread, reads replies, proposes meeting times from your real calendar and books the meeting. **Nothing is sent and no meeting is booked until you approve it.**

```
 import / add ──► research (Claude + web search/fetch) ──► dossier with sourced facts, fit score
                                                               │
                                          draft email grounded in those facts ◄┘
                                                               │
                     YOU: approve / edit / rewrite with feedback / reject   (review queue UI)
                                                               │
             send via your Gmail in the prospect's local morning ──► follow-ups in-thread
                                                               │
       reply detected ──► sequence stops ──► reply classified ──► answer / offer free slots
                                                               │
                     YOU: approve ──► they pick a time ──► YOU: approve ──► calendar invite + Meet link
```

## What it does

**Deep research.** For each prospect, Claude runs a web research pass (up to `max_searches` searches and `max_fetches` page reads). It covers the company site, press, funding, launches, hiring, interviews and podcasts, and the person's background. It then turns the notes into a structured dossier:
- dated facts, each with a source URL
- "why now" triggers
- pain hypotheses and personalization hooks, ranked by strength
- a fit score against your ideal customer, and any disqualifiers

It only reports email addresses that appear verbatim on a public page, with the URL. It never guesses addresses from name patterns (guessed addresses bounce and hurt your domain). If the prospect you imported looks wrong for your offer, research finds the right decision-maker.

**Emails that sound human.** The writer works from the dossier. It opens with one specific, recent, true observation about the prospect, links it to a likely problem, adds one line on what you do with at most one real proof point, and ends with a low-friction question. Each draft:
- must cite which dossier facts it uses, and is rejected if it cites a fact that doesn't exist
- is checked by a linter for the usual tells: banned phrases ("I hope this finds you well", "I came across"…), em dashes, links, markdown, sign-offs, long sentences, spam-trigger words, and going over the word limit
- is rewritten automatically once if the linter finds problems; anything still left shows as a warning in the review queue

Emails are plain text: no tracking pixels, no HTML, no links on first touch.

**Follow-ups.** Follow-ups are drafted in the same thread (`Re: <subject>`) after N business days (`followup_gaps_business_days`). Each one brings a new angle instead of "just following up", and the last one is a gracious close. Drafts are created a day before they're due so you have time to review them. Sends go out in the prospect's local morning (the timezone comes from research or country), with jitter, a daily cap and spacing between sends.

**Replies.** The Gmail inbox is synced for replies in the thread, replies from the same address in a new thread, and bounces. Any human reply cancels queued follow-ups immediately. Each reply is classified as one of: `interested`, `meeting_time`, `question`, `referral`, `not_now`, `not_interested`, `unsubscribe`, `out_of_office` or `bounce`, and the agent acts on it:

| Reply | What happens |
|---|---|
| interested | Checks your Google Calendar free/busy and drafts a reply offering 3 slots, one per day, that fall inside working hours for both of you |
| meeting_time | Checks the time is still free and drafts a confirmation. Approving it creates the calendar event with a Meet link and invites them |
| question | Drafts an answer. Anything it can't know (pricing, integrations) becomes a `[CONFIRM: …]` placeholder, and approval is blocked until you fill it in |
| referral | Drafts a thank-you and adds the referred person as a new prospect (research runs automatically) |
| not_now | Moves them to nurture, snoozes until the date they gave, and drafts a short acknowledgement |
| out_of_office | Pushes the sequence past their return date |
| unsubscribe / bounce | Adds them to the suppression list permanently; nothing can be sent to them again |
| not_interested | Closes the prospect; no email is sent |

**The human in the loop.** The review queue shows each draft next to the facts it relies on (with source links), the "why now", and their reply if there is one. You can:
- **Approve**: edits you make in the box are what gets sent
- **Rewrite**: give feedback such as "lead with the Coles deal, shorter" and it redrafts
- **Reject**, or **Reject & stop** the sequence

The prospect page shows the full dossier, the conversation, and an audit log of every step. You can also edit the contact, re-research, pause, mark won/lost, or suppress from there.

## Setup (about 15 minutes)

### 1. Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
outbound init
```

### 2. Anthropic API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Research and writing use `claude-opus-5` with adaptive thinking and web search/fetch. You can change the model per task in `[models]`. Rough cost: a research run is most of the spend per prospect (it depends on how many pages it reads); drafting and reply handling are small.

### 3. Tell it what you sell

```bash
cp config/seller.example.toml config/seller.toml
```

Fill in every `REQUIRED` field. The quality of the emails depends on this:
- **`proof_points`**: specific, true numbers. The agent will never invent claims about you, so if this list is thin, the emails will be too.
- **`ideal_customer`** / **`not_a_fit`**: these drive the fit score. Prospects below `min_fit_score` are parked as `low_fit` instead of being emailed.
- **`voice`**: how you actually talk.

Drafting is blocked until the config is complete.

### 4. Connect Gmail + Google Calendar

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API** and **Google Calendar API**.
2. Go to **OAuth consent screen**. Choose Internal (Workspace) or External, and if External add yourself as a test user.
3. Go to **Credentials → Create credentials → OAuth client ID → Desktop app**. Download the JSON as `credentials.json` into the project root.
4. Run `outbound google-auth` and sign in with the same address as `sender.email`. On a remote server, run it with `--no-browser` and open the printed URL through an SSH tunnel on port 8765.

The scopes are `gmail.modify` (send and read replies) and `calendar` (free/busy and creating invites). The token is stored at `data/google_token.json`.

```bash
outbound doctor   # checks config, API key, Google auth
```

### 5. Load prospects and run

```bash
outbound import d2c-prospect-list.csv   # or any CSV: name, email, title, company, website, linkedin, country…
outbound worker &                       # researches, drafts, syncs replies, sends approved mail (every 2 min)
outbound serve                          # review UI at http://127.0.0.1:8000
```

The importer understands the company-level list in this repo. It takes the first founder as the contact and passes funding, growth signals and sources to research as context. It flags generic inboxes (`hello@`) so research looks for the person's direct address.

If you expose the UI beyond localhost, set `OUTBOUND_UI_PASSWORD`. That enables basic auth; the username can be anything.

## Daily workflow

1. Open the review queue. Approve, edit or rewrite drafts; it takes about 20 seconds per email.
2. Prospects in `needs_email` have no verified address. Add one on the prospect page and it moves on to drafting.
3. Replies land in the queue with their classification and a drafted response. Approve it, and when they pick a time, approve the booking.

## CLI reference

| Command | |
|---|---|
| `outbound add --company Acme --domain acme.com --name "Sam Lee" --email sam@acme.com` | add one prospect |
| `outbound research 12 13` | research now and print the dossier summary (`--json` for all of it) |
| `outbound draft 12` | draft a first email now, ignoring the fit threshold |
| `outbound queue` / `approve ID` / `reject ID --stop` | review from the terminal |
| `outbound suppress someone@x.com` / `outbound suppress @competitor.com` | never email |
| `outbound tick` | run one pipeline pass (for cron instead of `worker`) |

## Deliverability and compliance (read before sending volume)

- **Use a secondary domain** (e.g. `getyourco.com`) with SPF, DKIM and DMARC set up, and warm it up for 2–3 weeks before you send cold email. Keep `daily_send_cap` at around 30 per inbox.
- The agent sends plain text from your real mailbox with no tracking, which is the best-case profile for inbox placement.
- **The law applies to you.** CAN-SPAM (US), the Spam Act (AU), CASL (CA) and GDPR/PECR (EU/UK) each have rules for commercial email: identify yourself, give a working opt-out, and in some jurisdictions have a lawful basis to email at all. `opt_out_line` and `physical_address` are appended to every cold email. Opt-out replies are suppressed automatically and permanently. AU and CA rules on unsolicited commercial email are stricter than the US, so check them for your use case.

## Layout

```
outbound/
  research.py    web research → structured, sourced dossier
  writer.py      first-touch + follow-up drafting, grounded in dossier facts
  style.py       deterministic linter for AI/spam tells; composes signature + footer
  replies.py     reply classification, reply drafting, slot proposals, meeting confirmation
  pipeline.py    orchestrator: sync inbox → handle replies → research → draft → follow-ups → send
  scheduling.py  business days, prospect-local send windows, free-slot finding
  google_api.py  Gmail (send/thread/search) + Calendar (free/busy, invites with Meet)
  db.py          SQLite state + audit log + suppression list
  web/           review UI (FastAPI + Jinja)
  cli.py         `outbound` command
tests/           end-to-end flow with the model, Gmail and Calendar faked at the boundary
```

`pytest` runs the suite. It covers the whole lifecycle: research → draft → approve → send → follow-up → reply cancels the sequence → slots offered → time accepted → meeting booked. It also covers unsubscribe/suppression, daily caps, placeholder blocking, send windows and CSV import.
