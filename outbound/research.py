"""Deep research on a prospect and their company, using Claude with live web search + fetch."""

from __future__ import annotations

import json
import logging
from datetime import date

import anthropic

from . import db, llm
from .config import Settings
from .schemas import Dossier

log = logging.getLogger(__name__)

RESEARCH_SYSTEM = """You are a senior B2B sales researcher preparing a one-to-one cold email. \
The seller will only email this person if you find something real and specific, so depth and accuracy \
matter far more than volume.

How to work:
- Confirm you have the right company first (match the domain). If the name is ambiguous, say so.
- Prioritise the last 12 months: funding, launches, new retail/distribution, expansion into new markets, \
key hires, job postings, awards, press, podcasts/interviews, founder posts, product reviews, and anything \
that hints at the specific problem the seller solves.
- Read primary sources where you can (company site, about page, careers page, press releases, interviews). \
The person's own words (interviews, podcasts, posts) are the most valuable personalization material.
- Look at the contact person specifically: role, background, what they care about publicly. If the given \
contact looks wrong for the seller's offer, identify the right decision-maker.
- Emails: only report an email address if it appears verbatim on a public page, with that page's URL. \
Never construct or guess addresses from name patterns.
- Every factual claim in your notes must carry the URL it came from and a date if known. If you could not \
verify something, leave it out or mark it clearly as unverified. Never fill gaps with plausible-sounding detail.

Finish with concise research notes in markdown: company overview, contact overview, a numbered list of \
dated facts each with its source URL, why-now triggers, likely pains relevant to the seller's offer, \
any public email addresses found (with URL), and any red flags / disqualifiers."""

STRUCTURE_SYSTEM = """You turn raw sales research notes into a structured dossier. Use ONLY information \
present in the notes; every fact must keep its original source URL. Do not add facts, numbers, or emails \
that are not in the notes. Score fit honestly against the seller's ideal customer; a low score is useful."""


def _seller_block(s: Settings) -> str:
    o = s.offer
    proof = "\n".join(f"- {p}" for p in o.proof_points)
    return f"""<seller>
Company: {s.sender.company}
What we sell: {o.one_liner}
Problem we solve: {o.problem}
Ideal customer: {o.ideal_customer}
Not a fit: {o.not_a_fit or "n/a"}
Proof points:
{proof}
</seller>"""


def _prospect_block(p: dict) -> str:
    fields = {
        "Name": p["full_name"], "Title": p["title"], "Company": p["company"], "Website": p["domain"],
        "Country": p["country"], "LinkedIn": p["linkedin_url"], "Known email": p["email"],
    }
    lines = "\n".join(f"{k}: {v}" for k, v in fields.items() if v)
    ctx = f"\nPrior notes from our list (verify, don't trust blindly):\n{p['context']}" if p["context"] else ""
    return f"<prospect>\n{lines}{ctx}\n</prospect>"


def _collect_text_and_sources(blocks: list) -> tuple[str, list[str]]:
    text_parts: list[str] = []
    sources: list[str] = []
    for b in blocks:
        t = getattr(b, "type", None)
        if t == "text":
            text_parts.append(b.text)
            for c in getattr(b, "citations", None) or []:
                url = getattr(c, "url", None)
                if url:
                    sources.append(url)
        elif t == "web_search_tool_result":
            content = getattr(b, "content", None)
            if isinstance(content, list):  # a list on success, an error object otherwise
                sources.extend(r.url for r in content if getattr(r, "url", None))
        elif t == "web_fetch_tool_result":
            url = getattr(getattr(b, "content", None), "url", None)
            if url:
                sources.append(url)
    seen: set[str] = set()
    uniq = [u for u in sources if not (u in seen or seen.add(u))]
    return "\n".join(text_parts).strip(), uniq


def research_prospect(settings: Settings, pid: int) -> dict:
    p = db.get_prospect(pid)
    if not p:
        raise ValueError(f"no prospect {pid}")
    db.set_status(pid, "researching")
    m = settings.models
    prompt = f"""Today is {date.today().isoformat()}.

{_seller_block(settings)}

{_prospect_block(p)}

Research this prospect and their company for a highly personalized cold email from the seller above."""
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": m.max_searches},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": m.max_fetches},
    ]
    try:
        blocks = llm.run_with_server_tools(
            model=m.research, system=RESEARCH_SYSTEM, prompt=prompt, tools=tools, effort=m.research_effort,
        )
        notes, sources = _collect_text_and_sources(blocks)
        if not notes:
            raise llm.LLMError("research produced no notes")

        dossier = llm.parse(
            model=m.research,
            system=STRUCTURE_SYSTEM,
            prompt=f"{_seller_block(settings)}\n\n{_prospect_block(p)}\n\n<research_notes>\n{notes}\n</research_notes>",
            schema=Dossier,
            effort="medium",
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.RateLimitError,
            anthropic.APIConnectionError, anthropic.InternalServerError, TypeError) as e:
        # Credentials missing / rate limited / API down: not the prospect's fault, retry next tick.
        db.set_status(pid, "queued_research", f"will retry: {str(e)[:200]}")
        raise
    except Exception as e:
        db.set_status(pid, "error", f"research failed: {e}")
        raise

    data = dossier.model_dump()
    db.save_dossier(pid, notes, data, sources)
    _apply_dossier(pid, p, dossier)
    return data


def _apply_dossier(pid: int, p: dict, d: Dossier) -> None:
    updates: dict = {"fit_score": d.fit_score}
    if not p["full_name"] and d.contact_name:
        updates["full_name"] = d.contact_name
        updates["first_name"] = d.contact_name.split()[0]
    if not p["title"] and d.contact_title:
        updates["title"] = d.contact_title
    if not p["linkedin_url"] and d.contact_linkedin:
        updates["linkedin_url"] = d.contact_linkedin
    if not p["timezone"] and d.timezone:
        updates["timezone"] = d.timezone

    # Upgrade a missing or generic inbox to the person's own publicly listed address.
    personal = [c for c in d.email_candidates if c.kind == "personal"]
    current_generic = p["email"].split("@")[0] in {"hello", "info", "support", "contact", "team", "hi", "sales", "admin"}
    if personal and (not p["email"] or current_generic):
        cand = personal[0]
        if not db.row("SELECT 1 FROM prospects WHERE email = ? AND id != ?", cand.email.lower(), pid):
            updates["email"] = cand.email
            updates["email_source"] = f"research: {cand.source_url}"
    elif not p["email"] and d.email_candidates:
        cand = d.email_candidates[0]
        if not db.row("SELECT 1 FROM prospects WHERE email = ? AND id != ?", cand.email.lower(), pid):
            updates["email"] = cand.email
            updates["email_source"] = f"research ({cand.kind}): {cand.source_url}"

    db.update_prospect(pid, **updates)
    if d.disqualifiers:
        db.set_status(pid, "disqualified", "; ".join(d.disqualifiers))
    else:
        db.set_status(pid, "researched", f"fit {d.fit_score}/5")
    db.log(pid, "research_done", json.dumps({"fit": d.fit_score, "facts": len(d.facts)}))
