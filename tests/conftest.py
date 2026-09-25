from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from outbound import config, db
from outbound.google_api import CreatedEvent, MailMessage, SentRef

SELLER_TOML = """
[sender]
name = "Dana Reyes"
first_name = "Dana"
title = "Founder"
company = "Loopwise"
email = "dana@loopwise.io"
timezone = "Australia/Sydney"
opt_out_line = "If this isn't relevant, just let me know and I won't follow up."

[offer]
one_liner = "We run retention email and SMS for D2C brands doing $1-10M."
problem = "Most brands this size lose repeat revenue after the first order."
ideal_customer = "Founder-led Shopify D2C brands, $1-10M revenue."
proof_points = ["Took a skincare brand from 18% to 31% repeat rate in 5 months."]
meeting_length_minutes = 20

[sequence]
followup_gaps_business_days = [3, 5]
send_window_start = "00:00"
send_window_end = "23:59"
send_days = [0, 1, 2, 3, 4, 5, 6]
min_seconds_between_sends = 0

[meetings]
days = [0, 1, 2, 3, 4]
min_notice_hours = 1
"""


@pytest.fixture
def settings(tmp_path, monkeypatch):
    cfg = tmp_path / "seller.toml"
    cfg.write_text(SELLER_TOML)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    db.init()
    return config.load_settings(cfg)


@dataclass
class FakeMailer:
    sent: list[dict] = field(default_factory=list)
    inbox: dict[str, list[MailMessage]] = field(default_factory=dict)  # thread_id -> messages from prospect
    _ids = itertools.count(1)

    def send(self, *, to, subject, body, from_name, from_email, thread_id=None, in_reply_to=None, references=None):
        n = next(self._ids)
        tid = thread_id or f"t{n}"
        self.sent.append(dict(to=to, subject=subject, body=body, thread_id=tid, in_reply_to=in_reply_to,
                              references=references))
        return SentRef(gmail_id=f"g{n}", thread_id=tid, rfc_message_id=f"<m{n}@loopwise.io>")

    def reply_from(self, thread_id: str, sender: str, text: str, subject: str = "Re: hi"):
        n = next(self._ids)
        self.inbox.setdefault(thread_id, []).append(MailMessage(
            id=f"in{n}", thread_id=thread_id, rfc_message_id=f"<r{n}@them.com>", sender=sender, sender_raw=sender,
            to="dana@loopwise.io", subject=subject, date=datetime.now(timezone.utc), text=text, full_text=text,
            labels=["INBOX"]))

    def thread_messages(self, thread_id):
        return list(self.inbox.get(thread_id, []))

    def search(self, query, max_results=20):
        return []


@dataclass
class FakeCalendar:
    busy_periods: list[tuple[datetime, datetime]] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)

    def busy(self, start, end):
        return [(s, e) for s, e in self.busy_periods if s < end and e > start]

    def create_event(self, *, summary, description, start, end, attendees, add_meet):
        self.events.append(dict(summary=summary, start=start, end=end, attendees=attendees))
        self.busy_periods.append((start, end))
        return CreatedEvent(event_id=f"ev{len(self.events)}", meet_link="https://meet.google.com/abc-defg-hij",
                            html_link="")


@pytest.fixture
def mailer():
    return FakeMailer()


@pytest.fixture
def calendar():
    return FakeCalendar()


REPO_CSV = Path(__file__).resolve().parent.parent / "d2c-prospect-list.csv"
