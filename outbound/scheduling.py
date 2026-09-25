"""Time logic: business days, send windows in the prospect's timezone, and free meeting slots."""

from __future__ import annotations

import random
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import Settings

COUNTRY_TZ = {
    "australia": "Australia/Sydney", "au": "Australia/Sydney",
    "new zealand": "Pacific/Auckland", "nz": "Pacific/Auckland",
    "united states": "America/New_York", "usa": "America/New_York", "us": "America/New_York",
    "united kingdom": "Europe/London", "uk": "Europe/London", "gb": "Europe/London",
    "canada": "America/Toronto", "ca": "America/Toronto",
    "ireland": "Europe/Dublin", "germany": "Europe/Berlin", "france": "Europe/Paris",
    "netherlands": "Europe/Amsterdam", "spain": "Europe/Madrid", "italy": "Europe/Rome",
    "sweden": "Europe/Stockholm", "denmark": "Europe/Copenhagen", "singapore": "Asia/Singapore",
}


def prospect_tz(settings: Settings, p: dict) -> ZoneInfo:
    for candidate in (p.get("timezone"), COUNTRY_TZ.get((p.get("country") or "").strip().lower())):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except Exception:
                pass
    return settings.sender.tz


def add_business_days(start: datetime, days: int, workdays: list[int]) -> datetime:
    d = start
    added = 0
    while added < days:
        d += timedelta(days=1)
        if d.weekday() in workdays:
            added += 1
    return d


def next_send_time(settings: Settings, tz: ZoneInfo, after: datetime, *, jitter: bool = True) -> datetime:
    """Earliest moment >= `after` inside the send window (in tz), with a small human-looking jitter."""
    start_t, end_t = settings.sequence.window
    days = settings.sequence.send_days
    local = after.astimezone(tz)
    for _ in range(15):
        day_start = datetime.combine(local.date(), start_t, tz)
        day_end = datetime.combine(local.date(), end_t, tz)
        if local.weekday() in days and local < day_end:
            candidate = max(local, day_start)
            if jitter and candidate == day_start:
                span = int((day_end - day_start).total_seconds() // 60)
                candidate += timedelta(minutes=random.randint(0, max(0, min(span - 1, 90))))
            return candidate.astimezone(timezone.utc)
        local = datetime.combine(local.date() + timedelta(days=1), time(0, 0), tz)
    raise RuntimeError("no send day configured")


def in_send_window(settings: Settings, tz: ZoneInfo, at: datetime) -> bool:
    start_t, end_t = settings.sequence.window
    local = at.astimezone(tz)
    return local.weekday() in settings.sequence.send_days and start_t <= local.time() <= end_t


def candidate_slots(settings: Settings, busy: list[tuple[datetime, datetime]], now: datetime,
                    prospect_zone: ZoneInfo | None = None) -> list[datetime]:
    """Free meeting starts, spread across different days, in the seller's meeting hours.

    If the prospect's timezone is known, only offer slots that land between 8:00 and 18:00 for them too.
    """
    m = settings.meetings
    tz = settings.sender.tz
    length = timedelta(minutes=settings.offer.meeting_length_minutes)
    buffer = timedelta(minutes=m.buffer_minutes)
    earliest = now + timedelta(hours=m.min_notice_hours)
    day_start_t = time(*map(int, m.day_start.split(":")))
    day_end_t = time(*map(int, m.day_end.split(":")))

    def is_free(s: datetime) -> bool:
        e = s + length
        return all(not (s < b_end + buffer and e > b_start - buffer) for b_start, b_end in busy)

    def ok_for_prospect(s: datetime) -> bool:
        if not prospect_zone:
            return True
        loc = s.astimezone(prospect_zone)
        return loc.weekday() < 5 and time(8, 0) <= loc.time() and (loc + length).time() <= time(18, 0)

    per_day: list[list[datetime]] = []
    day = now.astimezone(tz).date()
    business_days_seen = 0
    while business_days_seen < m.lookahead_business_days:
        if day.weekday() in m.days:
            business_days_seen += 1
            slots = []
            cursor = datetime.combine(day, day_start_t, tz)
            end = datetime.combine(day, day_end_t, tz)
            while cursor + length <= end:
                if cursor >= earliest and is_free(cursor) and ok_for_prospect(cursor):
                    slots.append(cursor)
                cursor += timedelta(minutes=30)
            if slots:
                per_day.append(slots)
        day += timedelta(days=1)

    # One slot per day, alternating morning/afternoon so the options feel considered.
    chosen: list[datetime] = []
    for i, slots in enumerate(per_day):
        if len(chosen) >= m.slots_to_offer:
            break
        pick = slots[0] if i % 2 == 0 else slots[len(slots) // 2]
        chosen.append(pick)
    return chosen


def fmt_slot(dt: datetime, tz: ZoneInfo) -> str:
    loc = dt.astimezone(tz)
    hour = loc.strftime("%I").lstrip("0")
    minute = "" if loc.minute == 0 else loc.strftime(":%M")
    return f"{loc.strftime('%a %-d %b')}, {hour}{minute}{loc.strftime('%p').lower()} {loc.tzname()}"
