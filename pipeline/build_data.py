#!/usr/bin/env python3
"""Merge every prospect source into one de-duplicated dataset for the app.

Inputs  (data/raw/):
  vert_finance_team_contacts.xlsx  Google Sheet "Vert_AU_finance_team_contacts" (SaaS + CPG/Ecom finance teams)
  origami.xlsx                     Google Sheet "Vert_AU_prospects_Origami" (ecom + accounting tabs)
  ecom.xlsx                        Google Sheet "AU_ecommerce_AI_finance_leads"
  melbourne.xlsx                   Google Sheet "Melbourne Accounting Firm Contacts"
  attio/companies_offset_*.json    Attio companies export
  attio/people_offset_*.json       Attio people export
  outreach/events.json             (optional) outreach events pulled from mailboxes

Outputs:
  app/src/data/accounts.json, app/src/data/outreach.json, data/build_report.md

Run:  python3 pipeline/build_data.py
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from locations import is_vague, normalise as normalise_location  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT_DIR = os.path.join(ROOT, "app", "src", "data")
REPORT = os.path.join(ROOT, "data", "build_report.md")

SRC_ATTIO = "Attio"
SRC_VF = "Vert_AU_finance_team_contacts"
SRC_ECOM = "AU_ecommerce_AI_finance_leads"
SRC_ORI = "Vert_AU_prospects_Origami"
SRC_MEL = "Melbourne Accounting Firm Contacts"
SRC_MASTER = "Vert_prospect_list_AU_final"
SRC_EXA = "Exa web research"

SEG_SAAS = "SaaS"
SEG_ECOM = "CPG / Ecom / D2C"
SEG_AI = "AI startup"
SEG_ACC = "Accounting & advisory"
SEG_VC = "VC / Accelerator"
SEG_OTHER = "Other"

FREE_MAIL = {
    "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com",
    "bigpond.com", "bigpond.net.au", "optusnet.com.au", "outlook.com.au", "me.com",
}

report: list[str] = []


def log(section: str, msg: str) -> None:
    report.append(f"[{section}] {msg}")


# ---------------------------------------------------------------- helpers
HYPERLINK = re.compile(r'^=HYPERLINK\("([^"]*)"(?:\s*,\s*"([^"]*)")?\)$', re.I)


def cell(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, str):
        v = v.strip()
        m = HYPERLINK.match(v)
        if m:
            v = m.group(1).strip()
        if v == "" or v.lower() in {"n/a", "none", "-", "—"}:
            return None
        if v.startswith("="):  # any other formula: unusable as data
            return None
    return v


def read_tab(fname: str, tab: str) -> list[dict]:
    wb = openpyxl.load_workbook(os.path.join(RAW, fname))
    ws = wb[tab]
    rows = [[cell(c.value) for c in r] for r in ws.iter_rows()]
    rows = [r for r in rows if any(x is not None for x in r)]
    hdr = [str(h).strip() if h is not None else f"col{i}" for i, h in enumerate(rows[0])]
    return [{hdr[i]: r[i] for i in range(min(len(hdr), len(r))) if r[i] is not None} for r in rows[1:]]


def s(v) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def domain_of(url) -> str | None:
    if not url:
        return None
    u = str(url).strip().lower()
    u = re.sub(r"^[a-z]+://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = u.split("/")[0].split("?")[0].split("#")[0].strip(".")
    return u if "." in u else None


def email_domain(e) -> str | None:
    if not e or "@" not in str(e):
        return None
    d = str(e).split("@", 1)[1].strip().lower()
    return None if d in FREE_MAIL else d


def domain_root(d: str | None) -> str | None:
    if not d:
        return None
    r = d.split(".")[0]
    return r if len(r) >= 5 else None


STOP = r"\b(pty|ltd|limited|inc|llc|the|australia|aus|au|co)\b"


def name_key(name) -> str:
    n = str(name or "").lower().replace("&", " and ").replace("+", " and ")
    n = re.sub(r"\(.*?\)", " ", n)
    n = re.sub(STOP, " ", n)
    return re.sub(r"[^a-z0-9]", "", n)


GENERIC = r"\b(group|chartered|accountants?|accounting|advisory|advisors?|partners|services|business|financial|and|tax|cpa|consulting)\b"


def loose_name_key(name) -> str:
    n = str(name or "").lower().replace("&", " and ")
    n = re.sub(r"\(.*?\)", " ", n)
    n = re.sub(STOP, " ", n)
    n = re.sub(GENERIC, " ", n)
    return re.sub(r"[^a-z0-9]", "", n)


def person_key(name) -> str:
    n = re.sub(r"\(.*?\)", " ", str(name or "")).lower()
    n = n.split(",")[0]  # drop post-nominals: "Tom Rose, MBA"
    n = re.sub(r"\b(mba|cpa|ca|caana|fcpa|fca|cfa|acca|phd)\b", " ", n)
    n = re.sub(r"\b(dr|mr|mrs|ms|cpa|ca)\b\.?", " ", n)
    return re.sub(r"[^a-z]", "", n)


def li_key(url) -> str | None:
    if not url:
        return None
    u = str(url).strip().lower()
    m = re.search(r"linkedin\.com/(in|company)/([^/?#]+)", u)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def norm_url(url) -> str | None:
    if not url:
        return None
    u = str(url).strip()
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def slug(text: str) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return t[:40] or "x"


def to_int(v) -> int | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    m = re.match(r"^\s*(\d+)", str(v))
    return int(m.group(1)) if m else None


FIN_RE = re.compile(r"\b(cfo|finance|financial|controller|accountant|accounts|accounting|bookkeep\w*|payroll|fp&a|treasur\w*|comptroller|tax)\b", re.I)
FOUNDER_RE = re.compile(r"\bfound(er|ing)\b", re.I)
EXEC_RE = re.compile(r"\b(ceo|chief|managing|director|partner|principal|owner|coo|president|head|general manager|gm|md)\b", re.I)


def role_type(title: str | None, explicit: str | None = None) -> str:
    if explicit:
        e = explicit.strip().lower()
        if e == "finance":
            return "Finance"
        if e == "founder":
            return "Founder"
        if e in {"ceo", "executive", "exec"}:
            return "Executive"
    t = title or ""
    if FIN_RE.search(t):
        return "Finance"
    if FOUNDER_RE.search(t):
        return "Founder"
    if EXEC_RE.search(t):
        return "Executive"
    return "Other"


CAUTION_RE = re.compile(r"not confirmed|catch-all|not verifiable|unavailable|own firm|own practice|address at|affinda address|not independently verified|unverified|previous employer|hellocfo address|his .* address|her .* address", re.I)
LEFT_RE = re.compile(r"latest role|still at|confirm still|check (he|she|they) (is|are) still|has left|no longer|moved to|current role as|(likely|may be) (a )?different|different firm|wrong company|not a firm decision-maker", re.I)


# ---------------------------------------------------------------- model
class Registry:
    def __init__(self):
        self.accounts: list[dict] = []
        self.by_domain: dict[str, dict] = {}
        self.by_name: dict[str, dict] = {}
        self.by_loose: dict[str, list[dict]] = defaultdict(list)
        self.by_root: dict[str, list[dict]] = defaultdict(list)

    def index(self, acc: dict):
        for d in acc["_domains"]:
            self.by_domain.setdefault(d, acc)
            r = domain_root(d)
            if r and acc not in self.by_root[r]:
                self.by_root[r].append(acc)
        k = name_key(acc["name"])
        if k:
            self.by_name.setdefault(k, acc)
        lk = loose_name_key(acc["name"])
        if len(lk) >= 4 and acc not in self.by_loose[lk]:
            self.by_loose[lk].append(acc)

    def find(self, name: str | None, domains: list[str], source: str, allow_loose: bool) -> dict | None:
        for d in domains:
            if d in self.by_domain:
                return self.by_domain[d]
        k = name_key(name) if name else ""
        if k and k in self.by_name:
            cand = self.by_name[k]
            if not domains or not cand["_domains"] or {domain_root(d) for d in domains} & {domain_root(d) for d in cand["_domains"]}:
                log("merge-by-name", f"{source}: '{name}' {domains} -> '{cand['name']}' {sorted(cand['_domains'])}")
                return cand
            log("REVIEW-same-name-diff-domain", f"{source}: '{name}' {domains} vs '{cand['name']}' {sorted(cand['_domains'])} (kept separate)")
        for d in domains:
            r = domain_root(d)
            if r and len(self.by_root.get(r, [])) == 1:
                cand = self.by_root[r][0]
                log("merge-by-domain-root", f"{source}: '{name}' {domains} -> '{cand['name']}' {sorted(cand['_domains'])}")
                return cand
        if allow_loose and name:
            lk = loose_name_key(name)
            c = self.by_loose.get(lk, [])
            if len(lk) >= 4 and len(c) == 1:
                cand = c[0]
                if not domains or not cand["_domains"]:
                    log("merge-by-loose-name", f"{source}: '{name}' {domains} -> '{cand['name']}' {sorted(cand['_domains'])}")
                    return cand
                log("REVIEW-loose-name-diff-domain", f"{source}: '{name}' {domains} vs '{cand['name']}' {sorted(cand['_domains'])} (kept separate)")
        return None

    def upsert(self, source: str, name: str | None, domains: list[str], fields: dict, allow_loose=False) -> dict:
        domains = [d for d in dict.fromkeys(d for d in domains if d)]
        acc = self.find(name, domains, source, allow_loose)
        if acc is None:
            acc = {"name": name or (domains[0] if domains else "Unnamed"), "_domains": [], "sources": [], "contacts": [], "_fields": {}}
            self.accounts.append(acc)
        for d in domains:
            if d not in acc["_domains"]:
                acc["_domains"].append(d)
        if source not in acc["sources"]:
            acc["sources"].append(source)
        for k, v in fields.items():
            if v is None or v == "" or v == []:
                continue
            if k not in acc["_fields"]:  # first source wins (sources processed in priority order)
                acc["_fields"][k] = v
            elif k == "location" and is_vague(acc["_fields"][k]) and not is_vague(v):
                acc["_fields"][k] = v  # a specific place beats "AU" / "Australia"
        self.index(acc)
        return acc


def add_contact(acc: dict, source: str, c: dict) -> dict | None:
    name = s(c.get("name"))
    if not name:
        return None
    email = s(c.get("email"))
    email = email.lower() if email and "@" in email else None
    li = norm_url(c.get("linkedin")) if c.get("linkedin") and "linkedin.com" in str(c.get("linkedin")).lower() else None
    pk, lk = person_key(name), li_key(li)
    existing = None
    for x in acc["contacts"]:
        if (email and x.get("email") == email) or (lk and li_key(x.get("linkedin")) == lk) or (pk and person_key(x["name"]) == pk):
            existing = x
            break
    if existing is None:
        existing = {"name": name, "sources": [], "inAttio": False, "_order": len(acc["contacts"])}
        acc["contacts"].append(existing)
    elif email and existing.get("email") and existing["email"] != email:
        log("contact-email-conflict", f"{acc['name']} / {name}: kept {existing['email']}, other source ({source}) had {email}")
    if source not in existing["sources"]:
        existing["sources"].append(source)
    if source == SRC_ATTIO:
        existing["inAttio"] = True
    for k, v in (("email", email), ("linkedin", li)):
        if v and not existing.get(k):
            existing[k] = v
    for k in ("title", "emailStatus", "location", "inRoleSince", "priority", "roleTypeExplicit"):
        v = s(c.get(k))
        if v and not existing.get(k):
            existing[k] = v
    n = s(c.get("notes"))
    if n:
        existing["notes"] = (existing["notes"] + " | " + n) if existing.get("notes") and n not in existing["notes"] else (existing.get("notes") or n)
    if c.get("isPrimary"):
        existing["isPrimary"] = True
    return existing


def split_person(text: str | None) -> tuple[str | None, str | None]:
    """Attio 'Name — Title' strings."""
    if not text:
        return None, None
    t = str(text).strip()
    parts = re.split(r"\s+[—–-]\s+", t, maxsplit=1)
    name = parts[0].strip()
    title = parts[1].strip() if len(parts) > 1 else None
    if not name or len(name) > 60 or re.search(r"\b(none|n/a|unknown|not found|no |name|tbd|vacant)\b", name, re.I):
        return None, None
    return name, title


# ---------------------------------------------------------------- load sources
def attio_companies() -> list[dict]:
    recs = []
    for f in sorted(glob.glob(os.path.join(RAW, "attio", "companies_offset_*.json"))):
        recs += json.load(open(f))
    return recs


def attio_people() -> list[dict]:
    recs = []
    for f in sorted(glob.glob(os.path.join(RAW, "attio", "people_offset_*.json"))):
        recs += json.load(open(f))
    return recs


def attio_segment(r: dict) -> str:
    ind = (r.get("industry") or "").strip()
    if ind == "SaaS":
        return SEG_SAAS
    if ind.startswith("CPG"):
        return SEG_ECOM
    if ind.startswith("VC"):
        return SEG_VC
    return ""  # unknown: let sheet decide, fallback later


def loc_text(loc) -> str | None:
    if not isinstance(loc, dict):
        return None
    parts = [loc.get("locality"), loc.get("region"), loc.get("country_code")]
    t = ", ".join(p for p in parts if p)
    return t or None


SIGNAL_SCORE = re.compile(r"^\s*(\d(?:\.\d)?)\s*/\s*5")


def build() -> tuple[list[dict], dict]:
    reg = Registry()
    attio_id_to_acc: dict[str, dict] = {}

    # 1) Attio companies (richest company data)
    companies = attio_companies()
    skipped_stub = 0
    for r in companies:
        doms = [d.lower() for d in r.get("domains", [])]
        if not r.get("name") and len(r) <= 5:  # empty stub record (domain only)
            skipped_stub += 1
            log("attio-stub", f"record {r['record_id']} has no name/fields (domains {doms}); merged only if a sheet has the same domain")
            # keep a placeholder so its domain can still be matched later
        fields = {
            "attioId": r["record_id"],
            "segment": attio_segment(r),
            "sector": r.get("sector"),
            "description": r.get("description"),
            "location": loc_text(r.get("primary_location")),
            "employees": s(r.get("employee_count")),
            "employeeRange": r.get("employee_range"),
            "financeHeadcountRaw": s(r.get("finance_headcount")),
            "arr": r.get("estimated_arr_usd"),
            "funding": r.get("recent_funding"),
            "valuation": r.get("valuation"),
            "founded": s(r.get("foundation_date")),
            "signal": r.get("signal"),
            "cfo": r.get("cfo") if split_person(r.get("cfo"))[0] else None,
            "financeTeam": r.get("finance_team"),
            "founder": r.get("founder") if split_person(r.get("founder"))[0] else None,
            "linkedin": r.get("linkedin"),
            "logoUrl": r.get("logo_url"),
            "categories": r.get("categories"),
            "fundingRaisedUsd": r.get("funding_raised_usd"),
        }
        if not r.get("name") and len(r) <= 5:
            reg_stub = {"name": None, "doms": doms, "fields": fields, "id": r["record_id"]}
            attio_id_to_acc[r["record_id"]] = reg_stub  # resolved later
            continue
        acc = reg.upsert(SRC_ATTIO, r.get("name"), doms, fields)
        acc["inAttio"] = True
        acc.setdefault("_attioIds", []).append(r["record_id"])
        if len(acc["_attioIds"]) > 1:
            log("ATTIO-DUPLICATE", f"Attio has {len(acc['_attioIds'])} records for '{acc['name']}': {acc['_attioIds']} (merged into one account)")
        attio_id_to_acc[r["record_id"]] = acc
        # contacts implied by Attio cfo / founder fields
        n, t = split_person(r.get("cfo"))
        if n:
            add_contact(acc, SRC_ATTIO, {"name": n, "title": t, "linkedin": r.get("cfo_linkedin")})
        n, t = split_person(r.get("founder"))
        if n:
            add_contact(acc, SRC_ATTIO, {"name": n, "title": t or "Founder", "linkedin": r.get("founder_linkedin")})

    # 1b) Vert_prospect_list_AU_final (research master list behind the finance-contacts sheet)
    n_master = 0
    for tab, seg in (("SaaS", SEG_SAAS), ("CPG-Ecom", SEG_ECOM)):
        for r in read_tab("prospect_list_final.xlsx", tab):
            if not s(r.get("Company")):
                continue
            n_master += 1
            d = domain_of(str(r.get("Website") or "").split(" ")[0])
            fit = r.get("Fit score (1-5)")
            try:
                fit = float(fit) if fit is not None else None
                fit = int(fit) if fit is not None and fit.is_integer() else fit
            except (TypeError, ValueError):
                fit = None
            urls = [u.strip() for u in re.split(r"\s*;\s*|\s+", str(r.get("Source URLs") or "")) if u.strip().startswith("http")]
            reg.upsert(SRC_MASTER, s(r["Company"]), [d] if d else [], {
                "segment": seg,
                "sector": s(r.get("Sub-category")),
                "location": s(r.get("HQ city")),
                "revenue": s(r.get("Est. revenue range (and basis)")),
                "employees": s(r.get("Est. headcount")),
                "fundingStage": s(r.get("Funding stage and notable investors")),
                "techStack": s(r.get("Evidence of tech stack (with source)")),
                "keySignals": s(r.get("Key info / recent signals")),
                "whyFit": s(r.get("Why they fit Vert")),
                "decisionMaker": s(r.get("Likely decision maker")),
                "fitScore": fit,
                "fitConfidence": s(r.get("Confidence")),
                "icpStatus": s(r.get("ICP verdict")),
                "sourceUrls": urls or None,
                "listStatus": s(r.get("List status")),
            })
    log("count", f"{SRC_MASTER}: {n_master} accounts (Removed-accounts tab ignored)")

    # 2) Vert_AU_finance_team_contacts
    vf_accounts = read_tab("vert_finance_team_contacts.xlsx", "Finance Contacts")
    vf_contacts = read_tab("vert_finance_team_contacts.xlsx", "All contacts")
    vf_by_name: dict[str, dict] = {}
    primary_names: dict[str, str] = {}
    for r in vf_accounts:
        seg = {"SaaS": SEG_SAAS, "CPG / Ecom": SEG_ECOM}.get(s(r.get("Segment")) or "", SEG_OTHER)
        d = domain_of(r.get("Website"))
        acc = reg.upsert(SRC_VF, s(r["Account"]), [d] if d else [], {
            "segment": seg,
            "financeHeadcount": to_int(r.get("Finance headcount")),
            "headcountBasis": s(r.get("Headcount basis")),
            "flags": s(r.get("Notes / flags")),
        })
        vf_by_name[s(r["Account"])] = acc
        if r.get("Contact 1"):
            primary_names[s(r["Account"])] = person_key(r["Contact 1"])
    for r in vf_contacts:
        acc = vf_by_name.get(s(r.get("Account")))
        if acc is None:
            log("ERROR", f"VF contact for unknown account {r.get('Account')}")
            continue
        add_contact(acc, SRC_VF, {
            "name": r.get("Name"), "title": r.get("Title"), "linkedin": r.get("LinkedIn"), "email": r.get("Email"),
            "emailStatus": r.get("Email source / confidence"), "inRoleSince": r.get("In role since"),
            "location": r.get("Location"), "notes": r.get("Notes"),
            "isPrimary": primary_names.get(s(r.get("Account"))) == person_key(r.get("Name")),
        })
    log("count", f"{SRC_VF}: {len(vf_accounts)} accounts, {len(vf_contacts)} contacts")

    # 3) AU_ecommerce_AI_finance_leads
    ec_accounts = read_tab("ecom.xlsx", "Companies")
    ec_contacts = read_tab("ecom.xlsx", "Contacts")
    ec_by_name = {}
    for r in ec_accounts:
        seg = SEG_AI if (s(r.get("Segment")) or "").lower().startswith("ai") else SEG_ECOM
        d = domain_of(r.get("Website"))
        acc = reg.upsert(SRC_ECOM, s(r["Company"]), [d] if d else [], {
            "segment": seg,
            "linkedin": s(r.get("Company LinkedIn")),
            "location": s(r.get("HQ")),
            "revenue": s(r.get("Estimated annual revenue")) and f"{r.get('Estimated annual revenue')} (est., {r.get('Revenue source') or 'source n/a'})",
            "employees": s(r.get("Employees (Apollo)")),
            "growth": "; ".join(x for x in [
                s(r.get("Growth or recent raise")),
                f"12-mo headcount growth {r['12-month headcount growth']}" if r.get("12-month headcount growth") else None,
                f"24-mo headcount growth {r['24-month headcount growth']}" if r.get("24-month headcount growth") else None,
            ] if x) or None,
            "icpStatus": s(r.get("ICP status")),
            "notes": s(r.get("Notes")),
        })
        if seg == SEG_AI and acc["_fields"].get("segment") != SEG_AI:
            acc["_segmentHint"] = SEG_AI
        ec_by_name[s(r["Company"])] = acc
    for r in ec_contacts:
        acc = ec_by_name.get(s(r.get("Company")))
        if acc is None:
            log("ERROR", f"ecom contact for unknown company {r.get('Company')}")
            continue
        add_contact(acc, SRC_ECOM, {
            "name": r.get("Person"), "title": r.get("Title"), "email": r.get("Email"),
            "emailStatus": r.get("Email status"), "linkedin": r.get("LinkedIn"), "priority": r.get("Priority"),
            "notes": r.get("Notes"), "roleTypeExplicit": r.get("Role type"),
            "isPrimary": (s(r.get("Priority")) or "").lower().startswith("primary"),
        })
    log("count", f"{SRC_ECOM}: {len(ec_accounts)} companies, {len(ec_contacts)} contacts (Excluded tab ignored)")

    # 4) Origami: ecom + accounting
    for acc_tab, ppl_tab, seg in (("Ecom - Accounts", "Ecom - Prospects", SEG_ECOM), ("Accounting - Accounts", "Accounting - Prospects", SEG_ACC)):
        rows = read_tab("origami.xlsx", acc_tab)
        ppl = read_tab("origami.xlsx", ppl_tab)
        by_name = {}
        for r in rows:
            nm = s(r.get("Brand") or r.get("Firm"))
            d = domain_of(r.get("Website"))
            f = {"segment": seg}
            if seg == SEG_ECOM:
                f.update({
                    "employees": s(r.get("Employees")),
                    "revenue": s(r.get("Est. online sales (store estimate)")) and f"{r.get('Est. online sales (store estimate)')} online sales (store estimate)",
                    "notes": s(r.get("Notes")),
                })
            else:
                f.update({
                    "employees": s(r.get("Staff")),
                    "staff": to_int(r.get("Staff")),
                    "serviceSignal": s(r.get("Service signal (why it fits)")),
                    "fitConfidence": s(r.get("Fit confidence")),
                    "notes": s(r.get("Notes")),
                })
            acc = reg.upsert(SRC_ORI, nm, [d] if d else [], f, allow_loose=(seg == SEG_ACC))
            by_name[nm] = acc
        for r in ppl:
            nm = s(r.get("Brand") or r.get("Firm"))
            acc = by_name.get(nm)
            if acc is None:
                log("ERROR", f"Origami contact for unknown account {nm}")
                continue
            add_contact(acc, SRC_ORI, {"name": r.get("Name"), "title": r.get("Title"), "email": r.get("Email"),
                                       "linkedin": r.get("LinkedIn"), "isPrimary": to_int(r.get("Contact #")) == 1})
        log("count", f"{SRC_ORI} / {acc_tab}: {len(rows)} accounts, {len(ppl)} contacts")

    # 5) Melbourne accounting firms
    mel = read_tab("melbourne.xlsx", "Contacts")
    for r in mel:
        doms = []
        mel_notes = s(r.get("Notes")) or ""
        for i in (1, 2):
            d = email_domain(r.get(f"Contact {i} Email"))
            frag = "; ".join(p.strip() for p in mel_notes.split(";") if p.strip().startswith(f"C{i} "))
            if frag and LEFT_RE.search(frag):
                # contact flagged as wrong company / different firm: its email domain is not the firm's
                if d:
                    log("melbourne-domain-skipped", f"{r['Firm']}: ignored domain {d} from flagged contact ({frag})")
                continue
            if d and d not in doms:
                doms.append(d)
        loc = s(r.get("Location"))
        acc = reg.upsert(SRC_MEL, s(r["Firm"]), doms, {
            "segment": SEG_ACC,
            "location": f"{loc}, VIC, AU" if loc else "Melbourne, VIC, AU",
            "notes": s(r.get("Notes")),
        }, allow_loose=True)
        notes = s(r.get("Notes")) or ""
        for i in (1, 2):
            nm = r.get(f"Contact {i} Name")
            if not nm:
                continue
            # per-contact notes look like "C1 Name: ..."; attach the relevant fragment
            frag = "; ".join(p.strip() for p in notes.split(";") if p.strip().startswith(f"C{i} "))
            add_contact(acc, SRC_MEL, {"name": nm, "title": r.get(f"Contact {i} Title"), "linkedin": r.get(f"Contact {i} LinkedIn"),
                                       "email": r.get(f"Contact {i} Email"), "notes": frag or None, "isPrimary": i == 1})
    log("count", f"{SRC_MEL}: {len(mel)} firms")

    # Attio stub records: attach to an existing account by domain if possible
    for rid, v in list(attio_id_to_acc.items()):
        if isinstance(v, dict) and v.get("name") is None and "doms" in v:
            acc = next((reg.by_domain[d] for d in v["doms"] if d in reg.by_domain), None)
            if acc:
                acc["_fields"].setdefault("attioId", rid)
                acc["inAttio"] = True
                if SRC_ATTIO not in acc["sources"]:
                    acc["sources"].append(SRC_ATTIO)
                attio_id_to_acc[rid] = acc
                log("attio-stub", f"stub {v['doms']} attached to '{acc['name']}'")
            else:
                del attio_id_to_acc[rid]
                log("attio-stub", f"stub {v['doms']} dropped (no name, no matching account)")

    # 6) Attio people -> attach via company record id
    people = attio_people()
    unmatched_people = 0
    for p in people:
        comp = (p.get("company") or {}).get("record_id")
        acc = attio_id_to_acc.get(comp)
        if not isinstance(acc, dict) or "contacts" not in acc:
            unmatched_people += 1
            log("attio-person-unmatched", f"{p.get('name')} (company {comp})")
            continue
        email = (p.get("email_addresses") or [None])[0]
        before = len(acc["contacts"])
        c = add_contact(acc, SRC_ATTIO, {"name": p.get("name"), "title": p.get("job_title"), "email": email,
                                         "linkedin": p.get("linkedin"), "location": loc_text(p.get("primary_location"))})
        if c is not None and len(acc["contacts"]) > before:
            log("attio-person-new", f"{p.get('name')} <{email}> added to '{acc['name']}' (not in any sheet)")
        if c is not None:
            c["attioId"] = p.get("record_id")
    log("count", f"Attio: {len(companies)} companies ({skipped_stub} stub), {len(people)} people ({unmatched_people} unmatched)")

    return finalize(reg.accounts)


def finalize(raw_accounts: list[dict]) -> tuple[list[dict], dict]:
    out = []
    used_ids: set[str] = set()
    for a in raw_accounts:
        f = a["_fields"]
        domain = a["_domains"][0] if a["_domains"] else None
        seg = f.get("segment") or SEG_OTHER
        if a.get("_segmentHint"):
            seg = a["_segmentHint"]
        if seg == "":
            seg = SEG_OTHER
        # finance headcount: prefer Vert sheet (numeric), else Attio text
        fh = f.get("financeHeadcount")
        basis = f.get("headcountBasis")
        if fh is None and f.get("financeHeadcountRaw"):
            fh = to_int(f["financeHeadcountRaw"])
            basis = basis or f"Attio finance headcount: {f['financeHeadcountRaw']}"
        # contacts
        contacts = []
        for c in a["contacts"]:
            status = c.get("emailStatus") or ""
            notes = c.get("notes") or ""
            if not c.get("email"):
                risk = "none"
            elif CAUTION_RE.search(status) or CAUTION_RE.search(notes):
                risk = "caution"
            else:
                risk = "ok"
            contacts.append({
                "name": c["name"],
                "title": c.get("title"),
                "roleType": role_type(c.get("title"), c.get("roleTypeExplicit")),
                "email": c.get("email"),
                "emailStatus": c.get("emailStatus"),
                "emailRisk": risk,
                "linkedin": c.get("linkedin"),
                "location": c.get("location"),
                "inRoleSince": c.get("inRoleSince"),
                "priority": c.get("priority"),
                "notes": c.get("notes"),
                "isPrimary": bool(c.get("isPrimary")),
                "likelyLeft": bool(LEFT_RE.search(notes)),
                "sources": c["sources"],
                "inAttio": bool(c.get("inAttio")),
                "_order": c["_order"],
            })
        role_rank = {"Finance": 0, "Executive": 1, "Founder": 1, "Other": 2}
        contacts.sort(key=lambda c: (c["likelyLeft"], not c["isPrimary"], role_rank.get(c["roleType"], 3), c["_order"]))
        n_fin = sum(1 for c in contacts if c["roleType"] == "Finance" and not c["likelyLeft"])

        # account type (section)
        if seg == SEG_ACC:
            staff = f.get("staff")
            if staff is not None and staff <= 2:
                typ, reason = "solo", f"Accounting practice with {staff} staff"
            else:
                typ = "firm"
                reason = f"Accounting / advisory practice ({staff} staff)" if staff else "Accounting / advisory practice (staff count unknown)"
        else:
            if fh == 1:
                typ, reason = "solo", "1-person finance function (finance headcount = 1)"
            elif fh is not None and fh >= 2:
                typ, reason = "internal", f"In-house finance team of {fh}"
            elif fh == 0:
                typ, reason = "solo", "No dedicated finance staff found (finance headcount = 0)"
            else:
                typ, reason = "internal", f"In-house finance team (headcount unknown; {n_fin} finance contact{'s' if n_fin != 1 else ''} found)"

        base = slug(a["name"])
        aid = base
        if aid in used_ids:
            aid = f"{base}-{hashlib.sha1((domain or a['name']).encode()).hexdigest()[:6]}"
        used_ids.add(aid)
        cids = set()
        for c in contacts:
            cid = f"{aid}--{slug(c['name'])}"
            k = 2
            while cid in cids:
                cid = f"{aid}--{slug(c['name'])}-{k}"
                k += 1
            cids.add(cid)
            c["id"] = cid
            del c["_order"]
            for k in [k for k, v in c.items() if v is None]:
                del c[k]

        signal = f.get("signal")
        score, summary = None, None
        if signal:
            m = SIGNAL_SCORE.match(signal)
            score = float(m.group(1)) if m else None
            if score is not None and score.is_integer():
                score = int(score)
            summary = signal.strip().split("\n", 1)[0].strip()

        website = norm_url(domain) if domain else None
        acc = {
            "id": aid,
            "name": a["name"],
            "domain": domain,
            "website": website,
            "linkedin": norm_url(f.get("linkedin")) if f.get("linkedin") else None,
            "logoUrl": f.get("logoUrl"),
            "type": typ,
            "typeReason": reason,
            "segment": seg,
            "sector": f.get("sector"),
            "description": f.get("description"),
            "location": f.get("location"),
            "employees": f.get("employees"),
            "employeeRange": f.get("employeeRange"),
            "financeHeadcount": fh,
            "headcountBasis": basis,
            "revenue": f.get("revenue"),
            "arr": f.get("arr"),
            "funding": f.get("funding"),
            "valuation": f.get("valuation"),
            "founded": f.get("founded"),
            "signalScore": score,
            "signalSummary": summary,
            "signal": signal,
            "serviceSignal": f.get("serviceSignal"),
            "fitConfidence": f.get("fitConfidence"),
            "growth": f.get("growth"),
            "icpStatus": f.get("icpStatus"),
            "fundingStage": f.get("fundingStage"),
            "techStack": f.get("techStack"),
            "keySignals": f.get("keySignals"),
            "whyFit": f.get("whyFit"),
            "decisionMaker": f.get("decisionMaker"),
            "fitScore": f.get("fitScore"),
            "listStatus": f.get("listStatus"),
            "sourceUrls": f.get("sourceUrls"),
            "signalSource": "Attio" if signal else None,
            "flags": f.get("flags"),
            "notes": f.get("notes"),
            "cfo": f.get("cfo"),
            "financeTeam": f.get("financeTeam"),
            "founder": f.get("founder"),
            "attioId": f.get("attioId"),
            "otherAttioIds": [x for x in a.get("_attioIds", []) if x != f.get("attioId")],
            "inAttio": bool(a.get("inAttio")),
            "sources": a["sources"],
            "otherDomains": a["_domains"][1:],
            "contacts": contacts,
        }
        out.append({k: v for k, v in acc.items() if v is not None and v != [] or k in ("contacts", "sources", "inAttio")})
    out.sort(key=lambda x: x["name"].lower())
    return out, {}


# ---------------------------------------------------------------- enrichment (Exa web research)
def _load_list(*names) -> list:
    out = []
    for n in names:
        p = os.path.join(RAW, "enrich", n)
        if os.path.exists(p):
            out += json.load(open(p))
    return out


def apply_enrichment(accounts: list[dict]) -> None:
    by_id = {a["id"]: a for a in accounts}
    used_domains = {d: a["id"] for a in accounts for d in [a.get("domain")] + a.get("otherDomains", []) if d}

    def safe_url(u, must_contain=None):
        if not u or not isinstance(u, str) or not re.match(r"^https?://", u):
            return None
        if must_contain and must_contain not in u.lower():
            return None
        return u.strip()

    def set_domain(a, url):
        d = domain_of(url)
        if not d or a.get("domain"):
            return
        if d in used_domains and used_domains[d] != a["id"]:
            log("enrich-domain-conflict", f"{a['name']}: Exa website {d} already belongs to {used_domains[d]}; ignored")
            return
        a["domain"], a["website"] = d, norm_url(d)
        used_domains[d] = a["id"]

    n_f = n_c = 0
    # accounting firms
    for e in _load_list("firms_A_out.json", "firms_B_out.json"):
        a = by_id.get(e.get("id"))
        if not a or a["segment"] != SEG_ACC:
            continue
        if (e.get("confidence") or "").lower() == "low":
            log("enrich-skipped-low-confidence", f"{a['name']}")
            continue
        touched = False
        if safe_url(e.get("website")) and not a.get("domain"):
            set_domain(a, e["website"])
            touched = True
        li = safe_url(e.get("linkedin"), "linkedin.com/company/")
        if li and not a.get("linkedin"):
            a["linkedin"] = li
            touched = True
        for src_k, dst_k in (("description", "description"), ("location", "location"), ("staffBasis", "headcountBasis")):
            if s(e.get(src_k)) and (not a.get(dst_k) or (dst_k == "location" and is_vague(a.get(dst_k)) and not is_vague(e[src_k]))):
                a[dst_k] = s(e[src_k])
                touched = True
        if isinstance(e.get("services"), list) and e["services"]:
            a["services"] = [str(x) for x in e["services"] if x]
            touched = True
        staff = e.get("staff")
        if isinstance(staff, (int, float)) and not a.get("employees"):
            a["employees"] = str(int(staff))
            touched = True
        if s(e.get("alphaSignal")) and not a.get("signal"):
            a["signal"] = s(e["alphaSignal"])
            a["signalSummary"] = a["signal"].split("\n", 1)[0][:220]
            a["signalSource"] = SRC_EXA
            touched = True
        urls = [u for u in (e.get("sourceUrls") or []) if safe_url(u)]
        if urls:
            a["sourceUrls"] = list(dict.fromkeys((a.get("sourceUrls") or []) + urls))
        # re-classify section with the new evidence
        staff_n = to_int(a.get("employees"))
        if e.get("isSoloPractice") is True or (staff_n is not None and staff_n <= 2):
            a["type"] = "solo"
            a["typeReason"] = "Sole practitioner / micro practice" + (f" ({e.get('staffBasis')})" if e.get("staffBasis") else "")
        elif a["type"] == "firm" and staff_n:
            a["typeReason"] = f"Accounting / advisory practice ({staff_n} staff)"
        if touched:
            if SRC_EXA not in a["sources"]:
                a["sources"].append(SRC_EXA)
            n_f += 1
    # companies
    for e in _load_list("companies_A_out.json", "companies_B_out.json"):
        a = by_id.get(e.get("id"))
        if not a or e.get("skipped"):
            continue
        touched = False
        desc = s(e.get("description"))
        if desc and not a.get("description"):
            a["description"] = desc
            touched = True
        li = safe_url(e.get("linkedin"), "linkedin.com/company/")
        if li and not a.get("linkedin"):
            a["linkedin"] = li
            touched = True
        if safe_url(e.get("website")) and not a.get("domain"):
            set_domain(a, e["website"])
            touched = True
        if touched:
            if SRC_EXA not in a["sources"]:
                a["sources"].append(SRC_EXA)
            n_c += 1
    # people
    ppl_path = os.path.join(RAW, "enrich", "people_out.json")
    n_li = n_new = 0
    if os.path.exists(ppl_path):
        P = json.load(open(ppl_path))
        con = {c["id"]: c for a in accounts for c in a["contacts"]}
        for x in P.get("linkedin_found", []):
            c = con.get(x.get("contactId"))
            li = safe_url(x.get("linkedin"), "linkedin.com/in/")
            if c and li and not c.get("linkedin") and (x.get("confidence") or "").lower() == "high":
                c["linkedin"] = li
                if SRC_EXA not in c["sources"]:
                    c["sources"].append(SRC_EXA)
                n_li += 1
        for x in P.get("new_contacts", []):
            a = by_id.get(x.get("accountId"))
            name = s(x.get("name"))
            if not a or not name:
                continue
            if any(person_key(c["name"]) == person_key(name) for c in a["contacts"]):
                continue
            cid = f"{a['id']}--{slug(name)}"
            if cid in con:
                continue
            email = s(x.get("email"))
            email = email.lower() if email and "@" in email else None
            c = {
                "id": cid, "name": name, "title": s(x.get("title")), "roleType": role_type(s(x.get("title"))),
                "email": email, "emailStatus": "Published on firm website (found via Exa)" if email else None,
                "emailRisk": "ok" if email else "none",
                "linkedin": safe_url(x.get("linkedin"), "linkedin.com/in/"),
                "notes": f"Found via Exa web research ({x.get('confidence', 'n/a')} confidence): {s(x.get('evidence')) or ''}".strip(),
                "isPrimary": not a["contacts"], "likelyLeft": False, "sources": [SRC_EXA], "inAttio": False,
            }
            a["contacts"].append({k: v for k, v in c.items() if v is not None})
            con[cid] = c
            if SRC_EXA not in a["sources"]:
                a["sources"].append(SRC_EXA)
            n_new += 1
    log("count", f"Exa enrichment: {n_f} firms, {n_c} companies, {n_li} LinkedIn URLs, {n_new} new contacts")

    # manual overrides (stale contacts, placeholders, account warnings)
    ov_path = os.path.join(RAW, "enrich", "overrides.json")
    if os.path.exists(ov_path):
        ov = json.load(open(ov_path))
        rm = set(ov.get("removeContacts", []))
        for a in accounts:
            before = len(a["contacts"])
            a["contacts"] = [c for c in a["contacts"] if c["id"] not in rm]
            if len(a["contacts"]) != before:
                log("override", f"removed {before - len(a['contacts'])} placeholder contact(s) from {a['name']}")
                if not any(c.get("isPrimary") for c in a["contacts"]) and a["contacts"]:
                    a["contacts"][0]["isPrimary"] = True
            for c in a["contacts"]:
                o = ov.get("contacts", {}).get(c["id"])
                if o:
                    if o.get("likelyLeft"):
                        c["likelyLeft"] = True
                        c["isPrimary"] = False
                    if o.get("note"):
                        c["notes"] = (c.get("notes") + " | " if c.get("notes") else "") + o["note"]
                    log("override", f"contact {c['id']}: {o}")
            o = ov.get("accounts", {}).get(a["id"])
            if o and o.get("domain"):
                old_dom = a.get("domain")
                a["domain"], a["website"] = o["domain"], norm_url(o["domain"])
                a["otherDomains"] = [d for d in a.get("otherDomains", []) if d != o["domain"]]
                log("override", f"account {a['id']}: domain {old_dom} -> {o['domain']}")
            if o and o.get("flag"):
                a["flags"] = (a.get("flags") + " | " if a.get("flags") else "") + "⚠ " + o["flag"]
                log("override", f"account {a['id']}: flagged")
            # keep ordering rule: likely-left last
            role_rank = {"Finance": 0, "Executive": 1, "Founder": 1, "Other": 2}
            a["contacts"].sort(key=lambda c: (bool(c.get("likelyLeft")), not c.get("isPrimary"), role_rank.get(c.get("roleType"), 3)))


# ---------------------------------------------------------------- additions made on the published page
SRC_LIVE = "Published page (23 Nov research)"


def merge_live_additions(accounts: list[dict]) -> None:
    """Merge accounts, contacts and notes that another session added directly to the published page
    (data/raw/live_artifact/accounts.json) and that no other source has."""
    path = os.path.join(RAW, "live_artifact", "accounts.json")
    if not os.path.exists(path):
        return
    live = json.load(open(path))
    by_id = {a["id"]: a for a in accounts}
    by_dom = {d: a for a in accounts for d in [a.get("domain")] + a.get("otherDomains", []) if d}
    by_name = {name_key(a["name"]): a for a in accounts}
    n_acc = n_con = n_note = 0
    for la in live:
        mine = by_id.get(la["id"])
        if mine is None:
            dup = by_dom.get(la.get("domain") or "") or by_name.get(name_key(la["name"]))
            if dup:
                log("live-merge", f"live account {la['id']} matches existing {dup['id']}; merging its contacts there")
                mine = dup
            else:
                acc = {k: v for k, v in la.items() if k not in ("city", "suburb", "state", "cityBasis")}
                acc["sources"] = list(dict.fromkeys(acc.get("sources", []) + [SRC_LIVE]))
                accounts.append(acc)
                by_id[acc["id"]] = acc
                for d in [acc.get("domain")] + acc.get("otherDomains", []):
                    if d:
                        by_dom[d] = acc
                by_name[name_key(acc["name"])] = acc
                n_acc += 1
                n_con += len(acc["contacts"])
                continue
        con_ids = {c["id"] for c in mine["contacts"]}
        keys = {person_key(c["name"]) for c in mine["contacts"]}
        emails = {c.get("email") for c in mine["contacts"] if c.get("email")}
        for lc in la.get("contacts", []):
            match = next((c for c in mine["contacts"] if c["id"] == lc["id"] or person_key(c["name"]) == person_key(lc["name"])
                          or (lc.get("email") and c.get("email") == lc["email"])), None)
            if match is None:
                c = dict(lc)
                if c["id"] in con_ids or not c["id"].startswith(mine["id"] + "--"):
                    c["id"] = f"{mine['id']}--{slug(c['name'])}"
                if c["id"] in con_ids or person_key(c["name"]) in keys or (c.get("email") and c["email"] in emails):
                    continue
                mine["contacts"].append(c)
                con_ids.add(c["id"]); keys.add(person_key(c["name"]))
                n_con += 1
                if SRC_LIVE not in mine["sources"]:
                    mine["sources"].append(SRC_LIVE)
            else:
                ln = (lc.get("notes") or "").strip()
                if ln and ln not in (match.get("notes") or ""):
                    match["notes"] = (match["notes"] + " | " if match.get("notes") else "") + ln
                    n_note += 1
                    log("live-merge", f"note on {match['id']}: {ln}")
    accounts.sort(key=lambda x: x["name"].lower())
    log("count", f"published-page additions: {n_acc} accounts, {n_con} contacts, {n_note} notes")


# ---------------------------------------------------------------- exclusions
def excluded_ids() -> dict:
    ov_path = os.path.join(RAW, "enrich", "overrides.json")
    return json.load(open(ov_path)).get("excludeAccounts", {}) if os.path.exists(ov_path) else {}


def exclude_accounts(accounts: list[dict]) -> None:
    """Drop accounts the owner removed from the list (overrides.json -> excludeAccounts)."""
    ex = excluded_ids()
    keep = [a for a in accounts if a["id"] not in ex]
    for a in accounts:
        if a["id"] in ex:
            log("excluded", f"{a['name']} ({a['id']}): {ex[a['id']]}")
    missing = set(ex) - {a["id"] for a in accounts}
    for m in missing:
        log("excluded", f"{m}: listed in excludeAccounts but no such account")
    for a in accounts:
        if a["id"] in ex:
            EXCLUDED_KEYS.update(d for d in [a.get("domain")] + a.get("otherDomains", []) if d)
            EXCLUDED_KEYS.update(c["email"].lower() for c in a["contacts"] if c.get("email"))
    accounts[:] = keep


EXCLUDED_KEYS: set[str] = set()  # domains + contact emails of excluded accounts (their outreach is dropped too)


# ---------------------------------------------------------------- cities
def assign_cities(accounts: list[dict]) -> None:
    """Adds city / suburb / state (+ cityBasis) to every account that has a usable location."""
    basis = Counter()
    researched = {e["id"]: e for e in _load_list("cities_out.json") if e.get("location") and not e.get("notFound")}
    for a in accounts:
        r = researched.get(a["id"])
        if r and (is_vague(a.get("location")) or not normalise_location(a.get("location")).get("state")):
            log("city-researched", f"{a['name']}: {a.get('location')!r} -> {r['location']!r} ({r.get('sourceUrl')})")
            a["location"] = r["location"]
            loc = normalise_location(a["location"])
            if loc.get("city"):
                a.update(loc)
                a["cityBasis"] = "Web research (Exa)"
                if SRC_EXA not in a["sources"]:
                    a["sources"].append(SRC_EXA)
                basis[a["cityBasis"]] += 1
                continue
        loc = normalise_location(a.get("location"))
        if loc.get("city"):
            a.update(loc)
            a["cityBasis"] = "Company location"
        else:
            # fall back to where the company's (current) contacts are based, if they agree on an Australian city
            votes = Counter()
            for c in a["contacts"]:
                if c.get("likelyLeft"):
                    continue
                cl = normalise_location(c.get("location"))
                if cl.get("city") and cl.get("state"):
                    votes[(cl["city"], cl["state"])] += 1
            if votes:
                (city, state), n = votes.most_common(1)[0]
                if n == sum(votes.values()):  # unanimous only
                    a["city"], a["state"] = city, state
                    a["cityBasis"] = "Contact location (company location not recorded)"
            if not a.get("city") and loc.get("state"):
                a["state"] = loc["state"]
        basis[a.get("cityBasis", "unknown")] += 1
        if not a.get("city"):
            log("city-unknown", f"{a['name']}: location {a.get('location')!r}")
    log("count", "cities: " + ", ".join(f"{k} {v}" for k, v in basis.most_common()))


# ---------------------------------------------------------------- outreach
def build_outreach(accounts: list[dict]) -> dict:
    path = os.path.join(RAW, "outreach", "events.json")
    notes_path = os.path.join(RAW, "outreach", "sources.json")
    events_in = json.load(open(path)) if os.path.exists(path) else []
    extra = os.path.join(RAW, "outreach", "events_extra.json")
    if os.path.exists(extra):
        events_in += json.load(open(extra))
    for f in sorted(glob.glob(os.path.join(RAW, "outreach", "events_hostinger_*.json"))):
        known = {e.get("id") for e in events_in}
        events_in += [e for e in json.load(open(f)) if e.get("id") not in known]
    live_o = os.path.join(RAW, "live_artifact", "outreach.json")
    if os.path.exists(live_o):
        known = {e.get("id") for e in events_in}
        added = [e for e in json.load(open(live_o)).get("events", []) if e.get("id") not in known]
        for e in added:  # matching is recomputed below from the counterparty emails
            e.pop("accountId", None); e.pop("contactId", None)
        events_in += added
        log("count", f"outreach: {len(added)} events added from the published page")
    sources = json.load(open(notes_path)) if os.path.exists(notes_path) else []
    by_email: dict[str, list[tuple[str, str]]] = defaultdict(list)
    acc_name = {a["id"]: a["name"] for a in accounts}
    by_domain: dict[str, str] = {}
    by_person: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for a in accounts:
        for d in [a.get("domain")] + a.get("otherDomains", []):
            if d:
                by_domain.setdefault(d, a["id"])
        for c in a["contacts"]:
            if c.get("email"):
                by_email[c["email"].lower()].append((a["id"], c["id"]))
                d = email_domain(c["email"])
                if d:
                    by_domain.setdefault(d, a["id"])
            by_person[person_key(c["name"])].append((a["id"], c["id"]))
    seen_ids = set()
    out = []
    unmatched = 0
    for e in events_in:
        if e.get("id") in seen_ids:
            continue
        seen_ids.add(e.get("id"))
        ev = {k: e.get(k) for k in ("id", "date", "channel", "kind", "source", "counterpartyEmails", "personName", "subject", "snippet", "seenFlag") if e.get(k) not in (None, "", [])}
        emails = [x.lower() for x in (e.get("counterpartyEmails") or [])]
        cands = next((by_email[x] for x in emails if x in by_email), [])
        if len(cands) > 1:
            # same person on several accounts (e.g. a fractional CFO): use the account named in the subject/snippet
            text = f"{e.get('subject') or ''} {e.get('snippet') or ''}".lower()
            named = [c for c in cands if name_key(acc_name[c[0]]) and name_key(acc_name[c[0]]) in re.sub(r"[^a-z0-9]", "", text)]
            if len(named) == 1:
                cands = named
            else:
                log("outreach-ambiguous", f"{e.get('id')}: {emails} matches {[c[0] for c in cands]}; left to email matching")
                ev["accountId"] = cands[0][0]
                cands = []
        hit = cands[0] if cands else None
        if hit:
            ev["accountId"], ev["contactId"] = hit
        else:
            dom = (e.get("domain") or "").lower() or next((email_domain(x) for x in emails if email_domain(x)), None)
            if dom and dom in by_domain:
                ev["accountId"] = by_domain[dom]
            if e.get("personName"):
                cands = by_person.get(person_key(e["personName"]), [])
                if len(cands) == 1:
                    ev["accountId"], ev["contactId"] = cands[0]
        if "accountId" not in ev and not hit:
            unmatched += 1
        out.append(ev)
    if EXCLUDED_KEYS:
        def excluded_event(ev):
            if ev.get("accountId"):
                return False
            ems = [x.lower() for x in ev.get("counterpartyEmails") or []]
            return bool(ems) and all(x in EXCLUDED_KEYS or (email_domain(x) or "") in EXCLUDED_KEYS for x in ems)
        dropped = [e["id"] for e in out if excluded_event(e)]
        out = [e for e in out if not excluded_event(e)]
        unmatched -= len(dropped)
        for d in dropped:
            log("excluded", f"outreach event {d} dropped (excluded account)")
    out.sort(key=lambda x: x.get("date") or "")
    log("count", f"outreach: {len(out)} events ({unmatched} not matched to an account)")
    return {"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sources": sources, "events": out}


# ---------------------------------------------------------------- checks
def checks(accounts: list[dict]) -> None:
    ids = [a["id"] for a in accounts]
    assert len(ids) == len(set(ids)), "duplicate account ids"
    cids = [c["id"] for a in accounts for c in a["contacts"]]
    assert len(cids) == len(set(cids)), "duplicate contact ids"
    doms = Counter(d for a in accounts for d in [a.get("domain")] + a.get("otherDomains", []) if d)
    dup = [d for d, n in doms.items() if n > 1]
    assert not dup, f"domain on more than one account: {dup}"
    names = Counter(name_key(a["name"]) for a in accounts)
    for k, n in names.items():
        if n > 1:
            log("REVIEW-dup-name", f"{n} accounts share normalised name '{k}': " + ", ".join(f"{a['name']} ({a.get('domain')})" for a in accounts if name_key(a["name"]) == k))
    roots = defaultdict(list)
    for a in accounts:
        r = domain_root(a.get("domain"))
        if r:
            roots[r].append(a)
    for r, lst in roots.items():
        if len(lst) > 1:
            log("REVIEW-same-domain-root", ", ".join(f"{a['name']} ({a['domain']})" for a in lst))
    # contact email reused across accounts
    em = defaultdict(list)
    for a in accounts:
        for c in a["contacts"]:
            if c.get("email"):
                em[c["email"]].append(a["name"])
    for e, lst in em.items():
        if len(lst) > 1:
            log("REVIEW-email-on-multiple-accounts", f"{e}: {lst}")
    for a in accounts:
        if a["type"] not in ("firm", "internal", "solo"):
            raise AssertionError(a)


def main() -> int:
    accounts, _ = build()
    apply_enrichment(accounts)
    merge_live_additions(accounts)
    exclude_accounts(accounts)
    assign_cities(accounts)
    for a in accounts:  # drop empty optional fields so output matches the TS contract
        for k in [k for k, v in a.items() if (v is None or v == []) and k not in ("contacts", "sources")]:
            del a[k]
    checks(accounts)
    outreach = build_outreach(accounts)
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(accounts, open(os.path.join(OUT_DIR, "accounts.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(outreach, open(os.path.join(OUT_DIR, "outreach.json"), "w"), ensure_ascii=False, indent=1)

    n_c = sum(len(a["contacts"]) for a in accounts)
    by_type = Counter(a["type"] for a in accounts)
    by_seg = Counter(a["segment"] for a in accounts)
    lines = [
        "# Data build report",
        "",
        f"Generated {outreach['generatedAt']} by `pipeline/build_data.py`.",
        "",
        f"- Accounts (de-duplicated): **{len(accounts)}**",
        f"- Contacts (de-duplicated): **{n_c}**",
        f"- Sections: firm {by_type['firm']}, internal {by_type['internal']}, solo {by_type['solo']}",
        "- Segments: " + ", ".join(f"{k} {v}" for k, v in by_seg.most_common()),
        f"- Accounts in Attio: {sum(a['inAttio'] for a in accounts)}",
        f"- Accounts with no contacts: {sum(1 for a in accounts if not a['contacts'])}",
        f"- Contacts with email: {sum(1 for a in accounts for c in a['contacts'] if c.get('email'))}",
        f"- Outreach events: {len(outreach['events'])}",
        "",
        "## Log",
        "",
    ] + [f"- {x}" for x in report]
    open(REPORT, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines[:14]))
    print(f"(full log: {REPORT})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
