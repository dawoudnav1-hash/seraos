"""Deterministic checks that catch the tells of machine-written or spammy cold email."""

from __future__ import annotations

import re

from .config import Settings

# Phrases that scream template / AI regardless of the seller's own list.
BUILTIN_BANNED = [
    "i hope this", "hope you're doing well", "hope you are doing well", "i trust this",
    "i'm reaching out", "i am reaching out", "i wanted to", "allow me to", "my name is",
    "i'd love to", "excited to", "thrilled", "unlock", "empower", "elevate", "seamless",
    "robust", "tailored", "holistic", "at the end of the day", "moving forward",
    "in today's", "ever-evolving", "landscape", "journey", "testament", "furthermore",
    "moreover", "additionally,", "impressive", "caught my eye", "caught my attention",
    "kudos", "hats off", "love what you're doing", "love what you are doing",
    "does that make sense", "let me know your thoughts", "as per", "feel free to",
    "no worries if not", "bump", "per my last email", "did you get a chance",
]

SPAM_TRIGGERS = ["free", "guarantee", "risk-free", "act now", "limited time", "100%", "$$$", "click here"]

URL_RE = re.compile(r"https?://|www\.", re.I)


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", text))


def lint(settings: Settings, subject: str, body: str, *, max_words: int, allow_links: bool,
         first_name: str = "") -> list[str]:
    problems: list[str] = []
    low = body.lower()
    words = word_count(body)
    if words > max_words:
        problems.append(f"too long: {words} words (max {max_words})")
    for phrase in [*settings.style.banned_phrases, *BUILTIN_BANNED]:
        if phrase.lower() in low or phrase.lower() in subject.lower():
            problems.append(f"banned phrase: “{phrase}”")
    for trig in SPAM_TRIGGERS:
        if re.search(rf"(?<![\w-]){re.escape(trig)}(?![\w-])", low):
            problems.append(f"spam-filter trigger word: “{trig}”")
    if "—" in body or "—" in subject:
        problems.append("contains an em dash (a strong AI tell); use a comma, period, or hyphen")
    if not allow_links and URL_RE.search(body):
        problems.append("contains a link; no links in cold emails (hurts deliverability and reads as marketing)")
    if body.count("!") > 1:
        problems.append("more than one exclamation mark")
    if re.search(r"\*\*|__|^#+ |^\s*[-*•] ", body, re.M):
        problems.append("contains markdown / bullet formatting; write plain sentences")
    if re.search(r"\{\{|\[(first ?name|company|name)\]", body, re.I):
        problems.append("contains an unfilled template placeholder")
    subj_words = len(subject.split())
    if subj_words == 0:
        problems.append("empty subject")
    elif subj_words > 6:
        problems.append(f"subject too long ({subj_words} words, max 6)")
    if subject.isupper() and len(subject) > 3:
        problems.append("subject is all caps")
    if re.search(r"(best|regards|cheers|thanks|sincerely),?\s*\n?\s*\w*\s*$", body.strip().split("\n")[-1], re.I) \
            and len(body.strip().split("\n")[-1].split()) <= 3:
        problems.append("body ends with a sign-off; the signature is added automatically")
    sentences = [s for s in re.split(r"(?<=[.?!])\s+", body.strip()) if s]
    if sentences and max(len(s.split()) for s in sentences) > 32:
        problems.append("has a sentence over 32 words; break it up")
    if first_name and first_name.lower() not in low[:60]:
        problems.append(f"doesn't greet {first_name} by name at the start")
    return problems


def compose(settings: Settings, body: str, *, include_opt_out: bool) -> str:
    """Final plain-text body: model-written body + sign-off + optional compliance footer."""
    s = settings.sender
    parts = [body.strip(), "", s.first_name]
    if s.signature.strip():
        parts.append(s.signature.strip())
    footer = []
    if include_opt_out and s.opt_out_line.strip():
        footer.append(s.opt_out_line.strip())
    if s.physical_address.strip():
        footer.append(s.physical_address.strip())
    if footer:
        parts += ["", *footer]
    return "\n".join(parts)
