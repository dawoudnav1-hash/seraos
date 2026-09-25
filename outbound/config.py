"""Seller configuration (config/seller.toml) and runtime paths (env vars)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(os.environ.get("OUTBOUND_HOME", Path.cwd()))
CONFIG_PATH = Path(os.environ.get("OUTBOUND_CONFIG", ROOT / "config" / "seller.toml"))
DATA_DIR = Path(os.environ.get("OUTBOUND_DATA", ROOT / "data"))
DB_PATH = Path(os.environ.get("OUTBOUND_DB", DATA_DIR / "outbound.db"))
GOOGLE_CREDENTIALS = Path(os.environ.get("GOOGLE_CREDENTIALS", ROOT / "credentials.json"))
GOOGLE_TOKEN = Path(os.environ.get("GOOGLE_TOKEN", DATA_DIR / "google_token.json"))


def _t(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


@dataclass
class Sender:
    name: str
    first_name: str
    company: str
    email: str
    timezone: str
    title: str = ""
    signature: str = ""
    physical_address: str = ""
    opt_out_line: str = ""

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@dataclass
class Offer:
    one_liner: str
    problem: str
    ideal_customer: str
    proof_points: list[str]
    not_a_fit: str = ""
    cta: str = "Worth a quick chat?"
    meeting_length_minutes: int = 20
    booking_link: str = ""


@dataclass
class Style:
    max_words: int = 90
    followup_max_words: int = 60
    voice: str = ""
    banned_phrases: list[str] = field(default_factory=list)


@dataclass
class Sequence:
    followup_gaps_business_days: list[int] = field(default_factory=lambda: [3, 5])
    daily_send_cap: int = 30
    min_seconds_between_sends: int = 150
    send_window_start: str = "08:15"
    send_window_end: str = "11:30"
    send_days: list[int] = field(default_factory=lambda: [0, 1, 2, 3, 4])
    auto_research: bool = True
    auto_draft: bool = True
    auto_approve_followups: bool = False
    min_fit_score: int = 3

    @property
    def window(self) -> tuple[time, time]:
        return _t(self.send_window_start), _t(self.send_window_end)


@dataclass
class Meetings:
    day_start: str = "09:00"
    day_end: str = "17:00"
    days: list[int] = field(default_factory=lambda: [0, 1, 2, 3, 4])
    slots_to_offer: int = 3
    lookahead_business_days: int = 6
    min_notice_hours: int = 18
    buffer_minutes: int = 15
    calendar_id: str = "primary"
    add_google_meet: bool = True


@dataclass
class Models:
    research: str = "claude-opus-5"
    writing: str = "claude-opus-5"
    replies: str = "claude-opus-5"
    research_effort: str = "high"
    writing_effort: str = "high"
    replies_effort: str = "medium"
    max_searches: int = 12
    max_fetches: int = 10


@dataclass
class Settings:
    sender: Sender
    offer: Offer
    style: Style
    sequence: Sequence
    meetings: Meetings
    models: Models

    def problems(self) -> list[str]:
        """Unfilled REQUIRED placeholders. Drafting is blocked while non-empty."""
        out = []

        def walk(prefix, obj):
            for k, v in vars(obj).items():
                if isinstance(v, str) and v.startswith("REQUIRED"):
                    out.append(f"{prefix}.{k}")
                elif isinstance(v, list):
                    if any(isinstance(i, str) and i.startswith("REQUIRED") for i in v):
                        out.append(f"{prefix}.{k}")

        for name in ("sender", "offer"):
            walk(name, getattr(self, name))
        try:
            self.sender.tz
        except Exception:
            out.append("sender.timezone (not a valid IANA timezone)")
        return out


def load_settings(path: Path | None = None) -> Settings:
    path = path or CONFIG_PATH
    if not path.exists():
        raise FileNotFoundError(
            f"No seller config at {path}. Copy config/seller.example.toml to config/seller.toml and fill it in."
        )
    raw = tomllib.loads(path.read_text())
    return Settings(
        sender=Sender(**raw["sender"]),
        offer=Offer(**raw["offer"]),
        style=Style(**raw.get("style", {})),
        sequence=Sequence(**raw.get("sequence", {})),
        meetings=Meetings(**raw.get("meetings", {})),
        models=Models(**raw.get("models", {})),
    )
