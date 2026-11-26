#!/usr/bin/env python3
"""Validate prospect research dossiers (see .claude/skills/prospect-research/SKILL.md).

Usage: python3 pipeline/validate_research.py data/raw/research/<id>.json [...]
       python3 pipeline/validate_research.py --all
Prints OK per file or the list of problems; exit code 1 if any file fails.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_TYPES = {"website", "blog", "podcast", "video", "linkedin", "facebook", "instagram", "news", "job", "directory", "registry", "other"}
CATEGORIES = {"identity", "firm", "person", "services", "clients", "growth", "hiring", "tech", "content", "news", "pain", "personal"}
BANNED = [r"hope (this|you).{0,20}well", r"quick question", r"\{\{", r"\[(name|firm|company)\]", r"lorem", r"I came across your (profile|company)"]
SIGNOFF = "Best,\nDawoud\nVert | https://vertfinance.tech"


def words(s):
    return len(re.findall(r"\b[\w'’$%-]+\b", s))


def validate(path, accounts, contacts):
    errs = []
    try:
        d = json.load(open(path))
    except Exception as e:  # noqa: BLE001
        return [f"not valid JSON: {e}"]
    aid = d.get("accountId")
    if aid not in accounts:
        errs.append(f"accountId {aid!r} not in accounts.json")
    if os.path.basename(path) != f"{aid}.json":
        errs.append("file name must be <accountId>.json")
    status = d.get("status")
    if status not in ("complete", "identity_unconfirmed", "thin"):
        errs.append("status must be complete | identity_unconfirmed | thin")
    src = {s.get("id"): s for s in d.get("sources", [])}
    if len(src) != len(d.get("sources", [])):
        errs.append("duplicate source ids")
    for s in d.get("sources", []):
        if not re.match(r"^https?://", s.get("url") or ""):
            errs.append(f"source {s.get('id')} has no http(s) url")
        if re.search(r"google\.[a-z.]+/search|bing\.com/search|exa\.ai/search", s.get("url") or ""):
            errs.append(f"source {s.get('id')} is a search-results page; cite the page itself")
        if s.get("type") not in SOURCE_TYPES:
            errs.append(f"source {s.get('id')} type {s.get('type')!r} invalid")
    claims = {c.get("id"): c for c in d.get("claims", [])}
    if len(claims) != len(d.get("claims", [])):
        errs.append("duplicate claim ids")
    used_sources = set()
    for c in d.get("claims", []):
        cid = c.get("id")
        if not c.get("text"):
            errs.append(f"claim {cid} has no text")
        sids = c.get("sourceIds") or []
        if not sids:
            errs.append(f"claim {cid} has no sourceIds")
        for sid in sids:
            if sid not in src:
                errs.append(f"claim {cid} cites unknown source {sid}")
            used_sources.add(sid)
        q = (c.get("quote") or "").strip()
        if not q:
            errs.append(f"claim {cid} has no supporting quote")
        elif words(q) > 35:
            errs.append(f"claim {cid} quote is longer than 30 words")
        if c.get("category") not in CATEGORIES:
            errs.append(f"claim {cid} category {c.get('category')!r} invalid")
        if c.get("confidence") not in ("high", "medium"):
            errs.append(f"claim {cid} confidence must be high|medium")
    for sid in src:
        if sid not in used_sources:
            errs.append(f"source {sid} is not cited by any claim")
    if status == "complete":
        if len(claims) < 6:
            errs.append(f"status complete but only {len(claims)} claims (use status 'thin')")
        if not any(c.get("category") == "identity" for c in claims.values()):
            errs.append("no identity claim (step 1)")
        if len({s.get('type') for s in src.values()}) < 2:
            errs.append("all sources are one type; sweep more source types or mark status 'thin'")
    for group in ("hooks", "risks"):
        for h in d.get(group, []):
            for cid in h.get("claimIds") or []:
                if cid not in claims:
                    errs.append(f"{group} references unknown claim {cid}")
    for p in d.get("people", []):
        if p.get("contactId") and p["contactId"] not in contacts:
            errs.append(f"person {p.get('name')} contactId {p['contactId']} not in accounts.json")
    drafts = d.get("drafts") or {}
    if status == "identity_unconfirmed":
        if any(drafts.get(k) for k in ("first", "followUp", "followUp2")):
            errs.append("identity_unconfirmed dossiers must not contain drafts")
    for kind, (lo, hi) in (("first", (60, 110)), ("followUp", (35, 80)), ("followUp2", (25, 60))):
        dr = drafts.get(kind)
        if not dr:
            continue
        body = dr.get("body") or ""
        cid = dr.get("contactId")
        if cid not in contacts:
            errs.append(f"draft {kind} contactId {cid!r} not in accounts.json")
        elif contacts[cid][0] != aid:
            errs.append(f"draft {kind} contact belongs to another account")
        else:
            c = contacts[cid][1]
            if not c.get("email"):
                errs.append(f"draft {kind} goes to a contact with no email")
            if "do not contact" in (c.get("notes") or "").lower():
                errs.append(f"draft {kind} goes to a contact marked Do not contact")
            if c.get("likelyLeft"):
                errs.append(f"draft {kind} goes to a contact flagged as likely left")
        if not dr.get("subject"):
            errs.append(f"draft {kind} has no subject")
        if not body.rstrip().endswith(SIGNOFF):
            errs.append(f"draft {kind} must end with the exact sign-off")
        n = words(body.replace(SIGNOFF, ""))
        if not lo <= n <= hi:
            errs.append(f"draft {kind} is {n} words (allowed {lo}-{hi})")
        ids = dr.get("claimIds") or []
        if len(ids) < 2:
            errs.append(f"draft {kind} must use at least 2 claims")
        for x in ids:
            if x not in claims:
                errs.append(f"draft {kind} uses unknown claim {x}")
        if ids and not any(claims.get(x, {}).get("category") in ("person", "content", "news", "hiring", "growth", "personal") for x in ids):
            errs.append(f"draft {kind} uses no claim about the person or something they did/published")
        for pat in BANNED:
            if re.search(pat, body, re.I):
                errs.append(f"draft {kind} contains banned phrase /{pat}/")
        if re.search(r"https?://", body.replace(SIGNOFF, "")):
            errs.append(f"draft {kind} has a link outside the signature")
        # numbers in the draft must appear in a cited claim, Vert's own stats excepted
        vert_numbers = {"4", "5", "100", "2", "2-4", "10", "2x"}
        cited = " ".join((claims.get(x, {}).get("text", "") + " " + claims.get(x, {}).get("quote", "")) for x in ids)
        for num in re.findall(r"\d[\d,.]*", body.replace(SIGNOFF, "")):
            if num not in vert_numbers and num not in cited:
                errs.append(f"draft {kind} mentions '{num}' which no cited claim contains")
    return errs


def main(argv):
    accounts_list = json.load(open(os.path.join(ROOT, "app", "src", "data", "accounts.json")))
    accounts = {a["id"]: a for a in accounts_list}
    contacts = {c["id"]: (a["id"], c) for a in accounts_list for c in a["contacts"]}
    paths = sorted(glob.glob(os.path.join(ROOT, "data", "raw", "research", "*.json"))) if argv == ["--all"] else argv
    if not paths:
        print(__doc__)
        return 2
    bad = 0
    for p in paths:
        errs = validate(p, accounts, contacts)
        if errs:
            bad += 1
            print(f"FAIL {p}")
            for e in errs:
                print(f"  - {e}")
        else:
            print(f"OK {p}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
