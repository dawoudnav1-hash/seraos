"""CSV import. Understands generic contact CSVs and the company-level prospect list format in this repo."""

from __future__ import annotations

import csv
import re
from pathlib import Path

from . import db

ALIASES = {
    "full_name": ["full name", "name", "contact name", "contact", "person"],
    "first_name": ["first name", "firstname", "first"],
    "last_name": ["last name", "lastname", "surname", "last"],
    "email": ["email", "email address", "work email", "contact email"],
    "title": ["title", "job title", "role", "position"],
    "company": ["company", "company name", "organization", "organisation", "account"],
    "domain": ["domain", "website", "company website", "url", "company domain"],
    "linkedin_url": ["linkedin", "linkedin url", "person linkedin", "founder linkedin", "linkedin profile"],
    "country": ["country", "location", "hq country"],
    "founders": ["founders", "founder", "founder(s)"],
}

# Columns that carry useful research context when present.
CONTEXT_COLUMNS = [
    "industry", "estimated revenue", "employee count", "funding", "why included", "recent growth signals",
    "ecommerce platform", "sources", "notes", "linkedin company page",
]

EMPTY = {"", "—", "-", "n/a", "na", "none", "null"}
GENERIC_LOCALPARTS = {"hello", "info", "support", "contact", "team", "hi", "sales", "admin", "enquiries", "orders"}


def _clean(v: str | None) -> str:
    v = (v or "").strip()
    return "" if v.lower() in EMPTY else v


def _norm_domain(v: str) -> str:
    v = re.sub(r"^https?://", "", v.strip().lower())
    return v.removeprefix("www.").split("/")[0]


def _first(multi: str) -> str:
    return re.split(r"\s*[;,]\s*|\s+\+\s+|\s+and\s+", multi)[0].strip() if multi else ""


def _map_headers(headers: list[str]) -> dict[str, str]:
    lower = {h.strip().lower(): h for h in headers}
    out = {}
    for field, names in ALIASES.items():
        for n in names:
            if n in lower:
                out[field] = lower[n]
                break
    return out


def import_csv(path: str | Path) -> dict:
    added = skipped = 0
    reasons: list[str] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        cols = _map_headers(reader.fieldnames or [])
        ctx_cols = [h for h in (reader.fieldnames or []) if h.strip().lower() in CONTEXT_COLUMNS]
        for i, r in enumerate(reader, start=2):
            get = lambda k: _clean(r.get(cols[k])) if k in cols else ""  # noqa: E731
            full = get("full_name") or " ".join(x for x in (get("first_name"), get("last_name")) if x)
            if not full and get("founders"):
                full = _first(get("founders"))
                # "Steve Chapman + co-founders" -> "Steve Chapman"
                full = re.sub(r"\s*\(.*?\)|\s+co-?founders?.*$", "", full, flags=re.I).strip()
            linkedin = _first(get("linkedin_url"))
            company = get("company")
            domain = _norm_domain(get("domain")) if get("domain") else ""
            email = get("email").lower()
            if email and "@" not in email:
                email = ""
            if not company and not domain and not email:
                skipped += 1
                reasons.append(f"row {i}: no company, domain or email")
                continue
            dup = None
            if email:
                dup = db.row("SELECT id FROM prospects WHERE email = ?", email)
            if not dup and company:
                dup = db.row("SELECT id FROM prospects WHERE lower(company) = lower(?) AND lower(full_name) = lower(?)",
                             company, full)
            if dup:
                skipped += 1
                reasons.append(f"row {i}: duplicate of prospect {dup['id']}")
                continue
            context_lines = [f"{h.strip()}: {_clean(r.get(h))}" for h in ctx_cols if _clean(r.get(h))]
            email_source = "import"
            if email and email.split("@")[0] in GENERIC_LOCALPARTS:
                email_source = "import (generic inbox)"
                if full:
                    context_lines.append(f"Only a generic inbox ({email}) is known; look for {full}'s direct address.")
            db.add_prospect(
                full_name=full, first_name=get("first_name"), email=email, email_source=email_source if email else "",
                title=get("title") or ("Founder" if get("founders") and full else ""), linkedin_url=linkedin,
                company=company, domain=domain, country=get("country"), context="\n".join(context_lines),
            )
            added += 1
    return {"added": added, "skipped": skipped, "reasons": reasons}
