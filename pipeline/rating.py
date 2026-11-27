"""Account rating: a 0-100 score + A-D grade with an itemised, human-readable breakdown.

Score = Fit (0-50) + Size (0-15) + Reachability (0-20) + Engagement (0-15) - penalties.
Grades: A >= 80, B 66-79, C 50-65, D < 50.
Every component appends a reason, so the app can show exactly why an account scored what it did.
"""
from __future__ import annotations

import re

GRADES = [(80, "A"), (66, "B"), (50, "C"), (0, "D")]
DECISION_TITLE = re.compile(r"\b(cfo|chief financial|finance manager|head of finance|financial controller|controller|director|partner|principal|founder|owner|managing|md|ceo|general manager)\b", re.I)
CLOSE_WORK = re.compile(r"bookkeep|client accounting|\bcas\b|outsourced accounting|virtual cfo|vcfo|reconcil|month[- ]end|management accounts", re.I)
FIT_WORDS = [  # (pattern, normalised 0-1) — the phrase that appears FIRST in the research text wins
    (re.compile(r"not a fit|poor fit|no fit|not core icp", re.I), 0.1),
    (re.compile(r"weak(?:er)?[- ]fit|moderate[- ]to[- ]weak|\bweak\b", re.I), 0.25),
    (re.compile(r"moderate(?:[- ]fit)?", re.I), 0.5),
    (re.compile(r"good fit|solid fit|plausible", re.I), 0.75),
    (re.compile(r"strong fit|excellent fit|strong buyer|strong candidate", re.I), 0.9),
]
CONF = {"high": 0.8, "med": 0.6, "medium": 0.6, "low": 0.3}


def _int(v):
    m = re.match(r"\s*(\d+)", str(v)) if v is not None else None
    return int(m.group(1)) if m else None


def rate(a: dict, events: list[dict]) -> dict:
    reasons: list[str] = []

    # ---- Fit (0-50)
    parts = []
    if a.get("signalScore") is not None:
        parts.append(("research signal %s/5" % a["signalScore"], float(a["signalScore"]) / 5))
    if a.get("fitScore") is not None:
        parts.append(("prospect-list fit %s/5" % a["fitScore"], float(a["fitScore"]) / 5))
    conf = CONF.get(str(a.get("fitConfidence") or "").strip().lower())
    if conf is not None:
        parts.append(("fit confidence %s" % a["fitConfidence"], conf))
    if a.get("signalScore") is None and a.get("signal"):
        text = (a.get("signalSummary") or a["signal"])[:400]
        found = sorted((m.start(), m.group(0).lower(), val) for pat, val in FIT_WORDS for m in [pat.search(text)] if m)
        if found:
            _, phrase, val = found[0]
            parts.append((f"research says '{phrase}'", val))
    if parts:
        fit = 50 * sum(v for _, v in parts) / len(parts)
        reasons.append(f"Fit {fit:.0f}/50 from " + ", ".join(n for n, _ in parts))
    else:
        fit = 25
        reasons.append("Fit 25/50 (no fit signal recorded; neutral)")
    blob = " ".join(str(x) for x in [a.get("signal"), a.get("serviceSignal"), " ".join(a.get("services") or []), a.get("whyFit")] if x)
    if a["type"] == "firm" and CLOSE_WORK.search(blob):
        fit = min(50, fit + 5)
        reasons.append("+5 recurring close work (bookkeeping, CAS, reconciliations, month-end)")

    # ---- Size (0-15)
    if a["type"] == "firm":
        n = _int(a.get("employees"))
        size = 7 if n is None else 15 if 5 <= n <= 60 else 10 if 61 <= n <= 150 else 6 if n < 5 else 5
        reasons.append(f"Size {size}/15 ({'staff unknown' if n is None else f'{n} staff'}; sweet spot 5-60)")
    else:
        n = a.get("financeHeadcount")
        size = 7 if n is None else 15 if 2 <= n <= 6 else 9 if n == 1 else 8 if n >= 7 else 5
        reasons.append(f"Size {size}/15 ({'finance team unknown' if n is None else f'finance team of {n}'}; sweet spot 2-6)")

    # ---- Reachability (0-20)
    live = [c for c in a["contacts"] if not c.get("likelyLeft") and "do not contact" not in (c.get("notes") or "").lower()]
    best = sorted(live, key=lambda c: ({"ok": 0, "caution": 1}.get(c.get("emailRisk"), 2), not c.get("isPrimary")))
    reach = 0
    if best:
        c = best[0]
        reach += {"ok": 12, "caution": 7}.get(c.get("emailRisk"), 0)
        if any(x.get("linkedin") for x in live):
            reach += 4
        if any(DECISION_TITLE.search(x.get("title") or "") for x in live):
            reach += 4
        reasons.append(f"Reach {reach}/20 ({c['name']}: email {c.get('emailRisk', 'none')}"
                       f"{', LinkedIn' if any(x.get('linkedin') for x in live) else ''}"
                       f"{', decision-maker' if any(DECISION_TITLE.search(x.get('title') or '') for x in live) else ''})")
    else:
        reasons.append("Reach 0/20 (no current, contactable person)")

    # ---- Engagement (0-15)
    kinds = {e.get("kind") for e in events}
    if kinds & {"reply", "meeting"}:
        eng, why = 15, "replied or met"
    elif "connection_accepted" in kinds:
        eng, why = 10, "accepted on LinkedIn"
    elif any("bounced" in (e.get("snippet") or "").lower() for e in events):
        eng, why = 2, "last email bounced"
    else:
        eng, why = 6, "no response yet" if kinds else "not contacted yet"
    reasons.append(f"Engagement {eng}/15 ({why})")

    # ---- Penalties
    pen = 0
    flags = a.get("flags") or ""
    if "⚠" in flags:
        pen += 20
        reasons.append("-20 warning flag on the account")
    if a["contacts"] and not live:
        pen += 10
        reasons.append("-10 every contact has left or must not be contacted")

    score = max(0, min(100, round(fit + size + reach + eng - pen)))
    grade = next(g for cut, g in GRADES if score >= cut)
    return {"rating": score, "grade": grade, "ratingReasons": reasons}
