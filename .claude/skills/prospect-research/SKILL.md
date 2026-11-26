---
name: prospect-research
description: Deep, cited research on one Vert prospect (an Australian accounting firm or a company's finance team) plus a first-touch email and a follow-up drafted ONLY from cited facts. Use when asked to research prospects, build dossiers, or draft personalised outreach for accounts in app/src/data/accounts.json. Produces data/raw/research/<accountId>.json that the Outreach section of the app shows behind its "Research" button.
---

# Prospect research → cited dossier → grounded drafts

Vert is AI software that automates reconciliation, cash coding and month-end close for accounting firms and in-house finance teams ("4 hours of manual reconciliations in 5 minutes; $100 of billable work for $2–4"; traceable, doesn't guess). The sender is Dawoud (founder, dawoud@vertfinance.tech).

Generic AI research fails at scale in three predictable ways. This skill exists to stop them:
1. **Confusing entities** (a UK firm with the same name, a person who left). → Identity check before anything else.
2. **Plausible but unsourced claims** ("they're growing fast"). → Every claim carries a source id and a short verbatim quote; the validator rejects anything else.
3. **Template-y drafts** that would fit any firm. → A draft may only use facts from the dossier's claims, must reference at least two specific claims, and must pass the specificity test below.

Do one account at a time, start to finish. Never batch "fill in the blanks" across accounts.

## Inputs
- The account record from `app/src/data/accounts.json` (name, domain, website, linkedin, location, contacts, description, signal, services, notes, flags, outreach history in `app/src/data/outreach.json`).
- Tools: Exa (`web_search_exa`, `web_fetch_exa`). Use `web_fetch_exa` to read a page before citing it whenever the search snippet is not enough to quote from. If Exa rate-limits, wait ~15 s and retry.

## Step 1 — Identity lock (do not skip)
Confirm the firm's own website (domain match), its suburb/state, and that each contact you'll write to currently works there (team page, LinkedIn headline "Current", or a dated post in the last 12 months). Record this as claims with category `identity`. If the identity can't be locked, stop, set `status: "identity_unconfirmed"`, explain in `gaps`, and write no drafts.

## Step 2 — Source sweep (checklist; record every attempt)
Run each search and log it in `searches` with the query and how many usable results it gave. Aim for breadth, then read the best 6–15 pages fully.
1. Firm website: home, about/team, services, careers, blog/news/insights (`site:<domain>`).
2. Firm blog posts and newsletters (topics they write about, recent dates).
3. LinkedIn: company page, posts by the firm and by the contact(s) (`site:linkedin.com/posts <name>`, `<person> <firm> linkedin`).
4. Podcasts and video: `<person> podcast`, `<firm> podcast`, YouTube interviews, webinars.
5. Facebook / Instagram pages and posts (`site:facebook.com <firm>`).
6. News and industry press: AFR, SmartCompany, Accountants Daily, Xero/MYOB partner pages and awards, CA ANZ / CPA mentions, acquisitions/mergers.
7. Hiring: job ads (Seek, LinkedIn jobs, careers page) — especially bookkeeper / accountant / client manager roles.
8. Tech stack signals: Xero/MYOB/QuickBooks partner status, Dext, Hubdoc, Karbon, FYI, Practice Ignition, ApprovalMax mentions.
9. Registries/directories when useful (ABN Lookup, Xero advisor directory, Google Business profile).
Prefer primary sources (their own site, their own posts, their own podcast appearance) over directories. Never cite a search-results page; cite the page itself.

## Step 3 — Claims (the only facts drafts may use)
Each claim: one atomic, checkable statement, written plainly, with:
- `sourceIds`: ≥ 1 source that actually says it (two for anything surprising);
- `quote`: ≤ 30 words copied verbatim from the source that supports it;
- `date`: the date of the underlying fact or post when known (YYYY-MM or YYYY-MM-DD);
- `category`: identity | firm | person | services | clients | growth | hiring | tech | content | news | pain | personal;
- `confidence`: high (primary source, recent) or medium (secondary or older than 18 months).
No inferences dressed as facts. Inferences go in `hooks` with the claim ids they rest on ("posts about BAS deadline crunch every quarter → reconciliation load is seasonal").
Aim for 10–25 claims. If fewer than 6 can be found, say so in `gaps` — never pad.

## Step 4 — Hooks, risks, gaps
- `hooks`: 2–5 personalisation angles, each tied to claim ids, ranked best first. The best hooks are things the person said or did recently (a post, a podcast answer, a hire, a new service line).
- `risks`: anything that argues against outreach (already uses an AI reconciliation tool, competitor, tax-only practice, recent merger, contact left). Each tied to claim ids.
- `gaps`: what you looked for and could not find.

## Step 5 — Drafts (grounded, in Dawoud's voice)
Write `drafts.first` (if not yet contacted) and `drafts.followUp` (always). Rules:
- Only facts from `claims`; list every claim used in `claimIds`. No invented numbers, clients, or compliments.
- Specificity test: delete the firm name — would the email still obviously be about THIS firm? If not, rewrite. Must reference ≥ 2 claims, at least one about the person or something they published/did.
- 60–110 words for first touch, 35–80 for follow-up. Plain text. No links except the signature. No "I hope this finds you well", no "quick question", no emojis, no bullet lists.
- Follow-up: new angle (a different claim or a concrete question), short, references the earlier email lightly ("Following up on my note last week…"). Subject = "Re: <original subject>" when an earlier subject is known (outreach.json), else a fresh short subject.
- Address the primary non-"likely left" contact by first name. Never write to a contact whose notes say "Do not contact".
- Sign-off exactly:
  Best,
  Dawoud
  Vert | https://vertfinance.tech

Voice reference (Dawoud's real emails — match the rhythm, plainness and length, not the exact words):
> Hi Shannon, Most accounting firms are stuck between burning hours reconciling by hand, or using AI that auto-codes without a trustworthy audit trail. I built a tool that turns hours of manual reconciliation into minutes and $100 worth of billable outputs into $2-4. We are already piloting Xero Platinum Partners, I'd love to get to know more about your firm. Open to a 10 min walkthrough this week?

> Hi Bryn, Noticed HelloCFO is built around virtual and fractional CFO work, so reconciling is the part that slows down the advice clients pay for. I've spent the past year asking finance leaders at Employment Hero, Startmate and Relevance why AI automation in accounting sticks or quietly fails. That became Vert, which helps firms reconcile and cash code 2x faster. How much of your CFO team's month goes on reconciling before the advisory work can start?

The second is the target: it opens with something specific to the firm.

## Step 6 — Write and validate
Write `data/raw/research/<accountId>.json` (schema below) with Python `json.dump(..., ensure_ascii=False, indent=1)`, then run:

    python3 pipeline/validate_research.py data/raw/research/<accountId>.json

Fix every error it reports and re-run until it prints `OK`. Do not hand back a dossier that fails validation.

## Schema
```json
{
  "accountId": "slug from accounts.json",
  "accountName": "…",
  "status": "complete | identity_unconfirmed | thin",
  "researchedAt": "ISO date",
  "summary": "2–4 sentences, every fact traceable to claims",
  "sources": [{"id": "S1", "url": "https://…", "title": "…", "type": "website|blog|podcast|video|linkedin|facebook|instagram|news|job|directory|registry|other", "publisher": "…", "date": "YYYY-MM-DD or null"}],
  "claims": [{"id": "C1", "text": "…", "sourceIds": ["S1"], "quote": "verbatim ≤30 words", "date": "YYYY-MM or null", "category": "…", "confidence": "high|medium"}],
  "people": [{"name": "…", "title": "…", "contactId": "id from accounts.json or null", "linkedin": "url or null", "claimIds": ["C3"]}],
  "hooks": [{"text": "…", "claimIds": ["C2", "C5"]}],
  "risks": [{"text": "…", "claimIds": ["C7"]}],
  "gaps": ["…"],
  "searches": [{"query": "…", "results": 3}],
  "drafts": {
    "first": {"contactId": "…", "subject": "…", "body": "…", "claimIds": ["…"]},
    "followUp": {"contactId": "…", "subject": "…", "body": "…", "claimIds": ["…"]}
  }
}
```
`drafts.first` is `null` for accounts already contacted. Both drafts are `null` when status is `identity_unconfirmed`.
