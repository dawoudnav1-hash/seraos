#!/usr/bin/env python3
"""Coverage + integrity checks for the generated dataset.

Every account and contact in every source must be represented exactly once in
app/src/data/accounts.json. Run: python3 pipeline/test_build_data.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as B  # noqa: E402

ROOT = B.ROOT
A = json.load(open(os.path.join(ROOT, "app", "src", "data", "accounts.json")))
O = json.load(open(os.path.join(ROOT, "app", "src", "data", "outreach.json")))

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


# --- integrity
ids = [a["id"] for a in A]
check(len(ids) == len(set(ids)), "account ids unique")
cids = [c["id"] for a in A for c in a["contacts"]]
check(len(cids) == len(set(cids)), "contact ids unique")
for a in A:
    check(a["type"] in ("firm", "internal", "solo"), f"bad type {a['id']}")
    check(bool(a.get("typeReason")), f"typeReason missing {a['id']}")
    check(a["segment"] in ("SaaS", "CPG / Ecom / D2C", "AI startup", "Accounting & advisory", "VC / Accelerator", "Other"), f"bad segment {a['id']}")
    if a["segment"] == "Accounting & advisory":
        check(a["type"] in ("firm", "solo"), f"accounting firm typed internal {a['id']}")
    for c in a["contacts"]:
        check(c["emailRisk"] in ("ok", "caution", "none"), f"bad emailRisk {c['id']}")
        check((c["emailRisk"] == "none") == (not c.get("email")), f"emailRisk/email mismatch {c['id']}")
        check(all(v is not None for v in c.values()), f"null field {c['id']}")
        for k in ("linkedin",):
            if c.get(k):
                check(c[k].startswith("https://") or c[k].startswith("http://"), f"bad url {c['id']} {c[k]}")
    for k in ("website", "linkedin"):
        if a.get(k):
            check(a[k].startswith("http"), f"bad {k} {a['id']}")
doms = [d for a in A for d in [a.get("domain")] + a.get("otherDomains", []) if d]
check(len(doms) == len(set(doms)), "each domain on exactly one account")

# --- coverage: every source account lands on an output account
by_domain = {d: a for a in A for d in [a.get("domain")] + a.get("otherDomains", []) if d}
by_name = {B.name_key(a["name"]): a for a in A}


def locate(name, domain=None):
    if domain and domain in by_domain:
        return by_domain[domain]
    return by_name.get(B.name_key(name))


def has_contact(acc, name, email=None):
    pk = B.person_key(name)
    for c in acc["contacts"]:
        if (email and c.get("email") == email.lower()) or B.person_key(c["name"]) == pk:
            return True
    return False


src_accounts = 0
src_contacts = 0
vf = B.read_tab("vert_finance_team_contacts.xlsx", "Finance Contacts")
vf_map = {}
for r in vf:
    src_accounts += 1
    acc = locate(r["Account"], B.domain_of(r.get("Website")))
    check(acc is not None, f"VF account missing: {r['Account']}")
    vf_map[r["Account"]] = acc
for r in B.read_tab("vert_finance_team_contacts.xlsx", "All contacts"):
    src_contacts += 1
    acc = vf_map.get(r["Account"])
    check(acc is not None and has_contact(acc, r["Name"], r.get("Email")), f"VF contact missing: {r['Name']} @ {r['Account']}")

ec_map = {}
for r in B.read_tab("ecom.xlsx", "Companies"):
    src_accounts += 1
    acc = locate(r["Company"], B.domain_of(r.get("Website")))
    check(acc is not None, f"ecom account missing {r['Company']}")
    ec_map[r["Company"]] = acc
for r in B.read_tab("ecom.xlsx", "Contacts"):
    src_contacts += 1
    acc = ec_map.get(r["Company"])
    check(acc is not None and has_contact(acc, r["Person"], r.get("Email")), f"ecom contact missing {r['Person']}")

for at, pt, key in (("Ecom - Accounts", "Ecom - Prospects", "Brand"), ("Accounting - Accounts", "Accounting - Prospects", "Firm")):
    m = {}
    for r in B.read_tab("origami.xlsx", at):
        src_accounts += 1
        acc = locate(r[key], B.domain_of(r.get("Website")))
        check(acc is not None, f"origami account missing {r[key]}")
        m[r[key]] = acc
    for r in B.read_tab("origami.xlsx", pt):
        src_contacts += 1
        acc = m.get(r[key])
        check(acc is not None and has_contact(acc, r["Name"], r.get("Email")), f"origami contact missing {r['Name']} @ {r[key]}")

mel_found = 0
for r in B.read_tab("melbourne.xlsx", "Contacts"):
    src_accounts += 1
    acc = None
    for i in (1, 2):
        e = r.get(f"Contact {i} Email")
        if e:
            acc = acc or next((a for a in A if any(c.get("email") == str(e).lower() for c in a["contacts"])), None)
    acc = acc or by_name.get(B.name_key(r["Firm"])) or next((a for a in A if B.loose_name_key(a["name"]) == B.loose_name_key(r["Firm"])), None)
    check(acc is not None, f"melbourne firm missing {r['Firm']}")
    for i in (1, 2):
        if r.get(f"Contact {i} Name"):
            src_contacts += 1
            check(acc is not None and has_contact(acc, r[f"Contact {i} Name"], r.get(f"Contact {i} Email")), f"melbourne contact missing {r[f'Contact {i} Name']}")

attio = B.attio_companies()
attio_ids = {a.get("attioId") for a in A} | {x for a in A for x in a.get("otherAttioIds", [])}
for r in attio:
    if r.get("name"):
        check(r["record_id"] in attio_ids, f"Attio company missing {r['name']}")
for p in B.attio_people():
    em = (p.get("email_addresses") or [None])[0]
    check(any(has_contact(a, p["name"], em) for a in A), f"Attio person missing {p['name']}")

# --- outreach integrity
ev_ids = [e["id"] for e in O["events"]]
check(len(ev_ids) == len(set(ev_ids)), "event ids unique")
acc_ids, con_ids = set(ids), set(cids)
for e in O["events"]:
    check(e["channel"] in ("email", "linkedin"), f"bad channel {e['id']}")
    check(e["kind"] in ("sent", "reply", "opened", "connection_sent", "connection_accepted", "message_sent", "message_seen", "meeting"), f"bad kind {e['id']}")
    if e.get("accountId"):
        check(e["accountId"] in acc_ids, f"event {e['id']} -> unknown account")
    if e.get("contactId"):
        check(e["contactId"] in con_ids, f"event {e['id']} -> unknown contact")
        check(e["contactId"].startswith(e["accountId"] + "--"), f"event {e['id']} contact/account mismatch")

# --- cities
from locations import normalise as _norm, is_vague as _vague  # noqa: E402
STATES_OK = {"VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"}
for a in A:
    if a.get("state"):
        check(a["state"] in STATES_OK, f"bad state {a['id']} {a['state']}")
    if a.get("city"):
        check(bool(a.get("cityBasis")), f"city without basis {a['id']}")
        check(a["city"] != a.get("suburb"), f"suburb duplicates city {a['id']}")
    if a.get("location") and not _vague(a["location"]) and _norm(a["location"]).get("state"):
        check(bool(a.get("city")), f"specific AU location but no city: {a['id']} {a['location']!r}")
for loc, exp in {"Richmond VIC": "Melbourne", "Burleigh Heads, QLD": "Gold Coast", "Barton, ACT": "Canberra",
                 "St Kilda Rd (616 St Kilda Rd), VIC, AU": "Melbourne", "Milton (Brisbane), QLD": "Brisbane",
                 "Noosaville, Queensland, AU": "Sunshine Coast", "Newcastle West, NSW": "Newcastle"}.items():
    check(_norm(loc).get("city") == exp, f"normalise {loc!r} -> {_norm(loc)} (expected {exp})")
check(not _norm("AU").get("city") and not _norm("Australia").get("city"), "vague locations must not get a city")

print(f"source accounts checked: {src_accounts}, source contacts checked: {src_contacts}")
print(f"output: {len(A)} accounts, {len(cids)} contacts, {len(O['events'])} events")
if failures:
    print(f"FAILED ({len(failures)}):")
    for f in failures[:50]:
        print("  -", f)
    sys.exit(1)
print("ALL CHECKS PASSED")
