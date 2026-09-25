from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from outbound import db, scheduling, style
from outbound.google_api import strip_quoted
from outbound.importer import import_csv

from .conftest import REPO_CSV


def test_lint_catches_ai_tells(settings):
    body = ("Hi Sam,\n\nI hope this email finds you well — I came across your company and was impressed. "
            "We leverage cutting-edge tech. Check https://x.com\n\nBest,")
    problems = style.lint(settings, "Quick question about your amazing growth journey", body,
                          max_words=90, allow_links=False, first_name="Sam")
    text = " ".join(problems)
    for expected in ("em dash", "link", "banned phrase", "subject too long", "sign-off"):
        assert expected in text, (expected, problems)


def test_lint_passes_clean_email(settings):
    body = ("Hi Sam,\n\nSaw Acme just opened in Coles. That usually means a lot of first-time buyers who never "
            "come back direct.\n\nWe run retention for D2C brands. Worth a quick chat?")
    assert style.lint(settings, "coles launch", body, max_words=90, allow_links=False, first_name="Sam") == []


def test_lint_hyphenated_free_is_fine(settings):
    body = "Hi Sam,\n\nThe gluten-free range looks like it's carrying the growth. Worth a chat?"
    assert style.lint(settings, "gluten-free range", body, max_words=90, allow_links=False, first_name="Sam") == []


def test_strip_quoted():
    text = "Sounds good, Tuesday works.\n\nOn Mon, 3 Aug 2026 at 9:14 am, Dana <dana@x.io> wrote:\n> Hi Sam\n> ..."
    assert strip_quoted(text) == "Sounds good, Tuesday works."


def test_send_window_respects_prospect_timezone(settings):
    settings.sequence.send_window_start = "08:15"
    settings.sequence.send_window_end = "11:30"
    settings.sequence.send_days = [0, 1, 2, 3, 4]
    tz = ZoneInfo("America/New_York")
    # Saturday afternoon in New York -> Monday morning in New York.
    sat = datetime(2026, 9, 26, 15, 0, tzinfo=tz)
    t = scheduling.next_send_time(settings, tz, sat).astimezone(tz)
    assert t.weekday() == 0 and 8 <= t.hour <= 11
    assert scheduling.in_send_window(settings, tz, t)


def test_business_days_skip_weekend():
    fri = datetime(2026, 9, 25, 9, tzinfo=timezone.utc)
    assert scheduling.add_business_days(fri, 3, [0, 1, 2, 3, 4]).weekday() == 2  # Wednesday


def test_candidate_slots_avoid_busy_and_spread_days(settings):
    tz = settings.sender.tz
    now = datetime(2026, 9, 28, 8, 0, tzinfo=tz)  # Monday
    busy = [(datetime(2026, 9, 29, 9, 0, tzinfo=tz), datetime(2026, 9, 29, 12, 0, tzinfo=tz))]
    slots = scheduling.candidate_slots(settings, busy, now)
    assert len(slots) == 3
    assert len({s.date() for s in slots}) == 3
    length = timedelta(minutes=settings.offer.meeting_length_minutes)
    for s in slots:
        assert all(not (s < e and s + length > b) for b, e in busy)
        assert s >= now + timedelta(hours=settings.meetings.min_notice_hours)


def test_candidate_slots_fit_prospect_hours(settings):
    now = datetime(2026, 9, 28, 8, 0, tzinfo=settings.sender.tz)
    london = ZoneInfo("Europe/London")
    for s in scheduling.candidate_slots(settings, [], now, london):
        loc = s.astimezone(london)
        assert 8 <= loc.hour < 18


def test_import_repo_prospect_list(settings):
    res = import_csv(REPO_CSV)
    assert res["added"] == 100, res["reasons"][:5]
    p = db.row("SELECT * FROM prospects WHERE company = 'Frasé Skin'")
    assert p["full_name"] == "Beau London" and p["first_name"] == "Beau"
    assert p["domain"] == "fraseskin.com.au" and p["linkedin_url"] == "linkedin.com/in/beau-london-805542253"
    assert "Times Square" in p["context"]
    hy = db.row("SELECT * FROM prospects WHERE company = 'Hyro'")
    assert hy["full_name"] == "Steve Chapman"
    earth = db.row("SELECT * FROM prospects WHERE company = 'Earthletica'")
    assert earth["email"] == "hello@earthletica.com" and "generic" in earth["email_source"]
    # Re-import is idempotent.
    assert import_csv(REPO_CSV)["added"] == 0
