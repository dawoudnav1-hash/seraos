"""Normalise free-text Australian locations into (city, suburb, state).

`city` is the metro area / regional centre people mean when they say "a Melbourne firm":
Richmond, VIC -> Melbourne; Burleigh Heads, QLD -> Gold Coast. Anything in a state that is
not a known regional centre falls back to that state's capital metro.
"""
from __future__ import annotations

import re

STATES = {
    "VIC": "VIC", "VICTORIA": "VIC",
    "NSW": "NSW", "NEW SOUTH WALES": "NSW",
    "QLD": "QLD", "QUEENSLAND": "QLD",
    "WA": "WA", "WESTERN AUSTRALIA": "WA",
    "SA": "SA", "SOUTH AUSTRALIA": "SA",
    "TAS": "TAS", "TASMANIA": "TAS",
    "ACT": "ACT", "AUSTRALIAN CAPITAL TERRITORY": "ACT",
    "NT": "NT", "NORTHERN TERRITORY": "NT",
}
CAPITAL = {"VIC": "Melbourne", "NSW": "Sydney", "QLD": "Brisbane", "WA": "Perth", "SA": "Adelaide",
           "TAS": "Hobart", "ACT": "Canberra", "NT": "Darwin"}

# Localities that are NOT part of the state capital's metro area -> the centre people would name.
REGIONAL = {
    # VIC
    "geelong": "Geelong", "torquay": "Geelong", "ballarat": "Ballarat", "bendigo": "Bendigo",
    "mildura": "Mildura", "sorrento": "Mornington Peninsula", "mornington": "Mornington Peninsula", "warragul": "Warragul", "sale": "Sale",
    # NSW
    "byron bay": "Byron Bay", "suffolk park": "Byron Bay", "mullumbimby": "Byron Bay",
    "newcastle": "Newcastle", "newcastle west": "Newcastle", "wollongong": "Wollongong",
    "gosford": "Central Coast", "tuggerah": "Central Coast", "central coast": "Central Coast",
    "cootamundra": "Cootamundra", "erina": "Central Coast", "rathmines": "Newcastle", "lake macquarie": "Newcastle",
    # QLD
    "gold coast": "Gold Coast", "burleigh heads": "Gold Coast", "burleigh": "Gold Coast", "southport": "Gold Coast",
    "bundall": "Gold Coast", "varsity lakes": "Gold Coast", "currumbin waters": "Gold Coast",
    "sunshine coast": "Sunshine Coast", "birtinya": "Sunshine Coast", "maroochydore": "Sunshine Coast",
    "noosaville": "Sunshine Coast", "noosa": "Sunshine Coast", "marcoola": "Sunshine Coast",
    "cairns": "Cairns", "townsville": "Townsville",
    # WA
    "bunbury": "Bunbury", "busselton": "Busselton",
    # SA
    "mclaren vale": "McLaren Vale", "hahndorf": "Adelaide Hills",
    # TAS
    "devonport": "Devonport", "launceston": "Launceston",
}
# Names that are themselves a capital/metro (so suburb = None).
METRO_NAMES = {v.lower() for v in CAPITAL.values()} | {v.lower() for v in REGIONAL.values()}
VAGUE = {"", "au", "australia", "aus"} | {k.lower() for k in STATES}


def _state_of(text: str) -> str | None:
    up = text.upper()
    # longest names first so "SOUTH AUSTRALIA" wins over "AUSTRALIA"-like partials
    for name in sorted(STATES, key=len, reverse=True):
        if re.search(rf"(?<![A-Z]){re.escape(name)}(?![A-Z])", up):
            return STATES[name]
    return None


def _first_locality(text: str) -> str:
    t = re.sub(r"\(.*?\)", " ", text)            # drop "(114 William St)"
    t = re.split(r"[,&+/;]| and ", t)[0]          # first named place
    t = re.sub(r"\b(HQ|CBD|by appt|offices?)\b", " ", t, flags=re.I)
    t = re.sub(r"\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT|Victoria|Queensland|New South Wales)\b\s*$", " ", t.strip(), flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" .-")
    return t


def is_vague(loc: str | None) -> bool:
    if not loc:
        return True
    return _first_locality(loc).lower() in VAGUE


def normalise(loc: str | None) -> dict:
    """-> {'city','suburb','state'} (keys omitted when unknown)."""
    if not loc or not str(loc).strip():
        return {}
    text = str(loc).strip()
    state = _state_of(text)
    first = _first_locality(text)
    low = first.lower()
    # "Milton (Brisbane), QLD" / "Melbourne (5 Queens Rd...)": a capital named in brackets wins
    bracket = re.search(r"\(([^)]*)\)", text)
    out: dict = {}
    if state:
        out["state"] = state
    if low in VAGUE:
        # e.g. "AU", "Victoria, AU", "Australia (Central Coast NSW HQ; ...)"
        if bracket:
            inner = normalise(bracket.group(1))
            if inner.get("city"):
                return inner
        return out
    if low in REGIONAL:
        out["city"] = REGIONAL[low]
    elif low in METRO_NAMES:
        out["city"] = next(v for v in list(CAPITAL.values()) + list(REGIONAL.values()) if v.lower() == low)
    elif bracket and bracket.group(1).strip().lower() in {c.lower() for c in CAPITAL.values()}:
        out["city"] = bracket.group(1).strip().title()
    elif state:
        out["city"] = CAPITAL[state]
    else:
        out["city"] = first  # outside Australia or unrecognised: keep as written
    if low.startswith("st kilda rd") or low.startswith("melbourne"):
        out["city"] = "Melbourne"
        out["state"] = "VIC"
    if out.get("city") and low not in METRO_NAMES and not low.startswith("melbourne") and first != out["city"]:
        out["suburb"] = first if not low.startswith("st kilda rd") else "St Kilda Rd"
    return out
