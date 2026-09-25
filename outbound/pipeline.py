"""The orchestrator. `tick()` advances every prospect one step; the worker calls it on an interval.

Nothing leaves the building without a human approving it (except follow-ups when
`auto_approve_followups` is on). Approval only schedules; `send_due` does the sending.
"""

from __future__ import annotations

import logging
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from . import db, replies, research, scheduling, writer
from .config import Settings
from .google_api import Calendar, CalendarClient, GmailClient, Mailer, google_ready

log = logging.getLogger(__name__)

SEQUENCE_PURPOSES = ("initial", "followup")
# Statuses where we may still receive mail from the prospect.
CONVERSATION_STATUSES = ("active", "replied", "meeting_pending", "meeting_booked", "nurture", "sequence_done")


class ApprovalError(ValueError):
    pass


def google_clients(s: Settings) -> tuple[Mailer | None, Calendar | None]:
    if not google_ready():
        return None, None
    return GmailClient(), CalendarClient(s.meetings.calendar_id)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- inbound -------------------------------------------------------------------

def sync_inbox(s: Settings, mailer: Mailer) -> int:
    """Pull replies (threaded or not) and bounces into the DB. Returns count of new inbound messages."""
    me = s.sender.email.lower()
    known = {r["gmail_id"] for r in db.rows("SELECT gmail_id FROM messages WHERE gmail_id IS NOT NULL")}
    prospects = db.rows(
        f"SELECT * FROM prospects WHERE gmail_thread_id != '' AND status IN ({','.join('?' * len(CONVERSATION_STATUSES))})",
        *CONVERSATION_STATUSES,
    )
    by_email = {p["email"]: p for p in prospects if p["email"]}
    found = 0

    def record(p: dict, m) -> None:
        nonlocal found
        if m.id in known or m.sender == me or "SENT" in m.labels or "DRAFT" in m.labels:
            return
        known.add(m.id)
        db.add_message(p["id"], "in", "inbound", "received", subject=m.subject, body=m.text or m.full_text,
                       gmail_id=m.id, gmail_thread_id=m.thread_id, rfc_message_id=m.rfc_message_id,
                       sent_at=m.date.isoformat(), meta={"from": m.sender_raw})
        db.log(p["id"], "inbound", m.subject)
        found += 1

    for p in prospects:
        try:
            for m in mailer.thread_messages(p["gmail_thread_id"]):
                if m.sender in ("mailer-daemon@googlemail.com",) or m.sender.startswith(("mailer-daemon@", "postmaster@")):
                    _mark_bounced(p, m.id, known)
                    continue
                record(p, m)
        except Exception as e:
            log.warning("thread sync failed for prospect %s: %s", p["id"], e)

    # Replies that started a new thread (some clients do this) — match on sender address.
    emails = list(by_email)
    for i in range(0, len(emails), 20):
        chunk = emails[i:i + 20]
        try:
            for m in mailer.search(f"from:({' OR '.join(chunk)}) newer_than:30d", max_results=50):
                p = by_email.get(m.sender)
                if p:
                    record(p, m)
        except Exception as e:
            log.warning("reply search failed: %s", e)

    # Bounces delivered as separate threads.
    try:
        for m in mailer.search("from:(mailer-daemon OR postmaster) newer_than:14d", max_results=50):
            if m.id in known:
                continue
            text = m.full_text.lower()
            for addr, p in by_email.items():
                if addr in text:
                    _mark_bounced(p, m.id, known)
    except Exception as e:
        log.warning("bounce search failed: %s", e)
    return found


def _mark_bounced(p: dict, gmail_id: str, known: set) -> None:
    if gmail_id in known:
        return
    known.add(gmail_id)
    db.add_message(p["id"], "in", "inbound", "handled", subject="(bounce)", body="Delivery failure", gmail_id=gmail_id)
    db.suppress(p["email"], "bounced")
    db.cancel_pending_outbound(p["id"], "bounced")
    db.set_status(p["id"], "bounced", p["email"])


def process_inbound(s: Settings, calendar: Calendar | None) -> int:
    n = 0
    for m in db.rows("SELECT id, prospect_id FROM messages WHERE direction = 'in' AND status = 'received' ORDER BY id"):
        try:
            replies.handle_inbound(s, m["id"], calendar)
            n += 1
        except Exception as e:
            log.exception("failed to handle inbound %s", m["id"])
            db.log(m["prospect_id"], "error", f"reply handling failed: {e}")
    return n


# --- research + drafting -------------------------------------------------------

def run_research(s: Settings, limit: int = 5, workers: int = 3) -> int:
    statuses = ("queued_research", "new") if s.sequence.auto_research else ("queued_research",)
    todo = db.rows(
        f"SELECT id FROM prospects WHERE status IN ({','.join('?' * len(statuses))}) ORDER BY "
        "CASE status WHEN 'queued_research' THEN 0 ELSE 1 END, id LIMIT ?", *statuses, limit,
    )
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(research.research_prospect, s, r["id"]): r["id"] for r in todo}
        for f in as_completed(futures):
            try:
                f.result()
                done += 1
            except Exception as e:
                log.error("research failed for %s: %s", futures[f], e)
    return done


def draft_initial_emails(s: Settings, limit: int = 10, *, force_ids: list[int] | None = None) -> int:
    if s.problems():
        log.warning("not drafting: seller config incomplete: %s", s.problems())
        return 0
    if force_ids:
        candidates = [db.get_prospect(i) for i in force_ids]
    elif s.sequence.auto_draft:
        candidates = db.rows("SELECT * FROM prospects WHERE status = 'researched' ORDER BY fit_score DESC, id LIMIT ?", limit)
    else:
        return 0
    n = 0
    for p in candidates:
        pid = p["id"]
        if db.row("SELECT 1 FROM messages WHERE prospect_id = ? AND purpose = 'initial' AND status != 'rejected'", pid):
            continue
        if not force_ids and (p["fit_score"] or 0) < s.sequence.min_fit_score:
            db.set_status(pid, "low_fit", f"fit {p['fit_score']}/5 below minimum {s.sequence.min_fit_score}")
            continue
        if not p["email"]:
            db.set_status(pid, "needs_email", "no verified email found; add one to continue")
            continue
        if db.is_suppressed(p["email"]):
            db.set_status(pid, "suppressed", p["email"])
            continue
        try:
            writer.draft_email(s, pid, 0)
            n += 1
        except Exception as e:
            log.exception("drafting failed for %s", pid)
            db.set_status(pid, "error", f"drafting failed: {e}")
    return n


def _sequence_state(pid: int) -> tuple[list[dict], bool]:
    msgs = db.thread(pid)
    sent = [m for m in msgs if m["direction"] == "out" and m["purpose"] in SEQUENCE_PURPOSES and m["status"] == "sent"]
    first_sent_at = db.parse_ts(sent[0]["sent_at"]) if sent else None
    # Any human reply since the sequence started stops it.
    replied = first_sent_at is not None and any(
        m["direction"] == "in" and m["subject"] != "(bounce)"
        and m["meta"].get("analysis", {}).get("intent") != "out_of_office"
        and db.parse_ts(m["sent_at"] or m["created_at"]) >= first_sent_at
        for m in msgs
    )
    return sent, replied


def draft_followups(s: Settings) -> int:
    if s.problems():
        return 0
    gaps = s.sequence.followup_gaps_business_days
    now = _utcnow()
    n = 0
    for p in db.rows("SELECT * FROM prospects WHERE status = 'active'"):
        pid = p["id"]
        if p["snooze_until"] and db.parse_ts(p["snooze_until"]) > now:
            continue
        sent, replied = _sequence_state(pid)
        if replied or not sent:
            continue
        step = len(sent)  # next step number
        last = sent[-1]
        if step > len(gaps):
            due_end = scheduling.add_business_days(db.parse_ts(last["sent_at"]), gaps[-1] if gaps else 3,
                                                   s.sequence.send_days)
            if now >= due_end:
                db.set_status(pid, "sequence_done", "no reply after full sequence")
            continue
        if db.row("SELECT 1 FROM messages WHERE prospect_id = ? AND purpose = 'followup' AND step = ?", pid, step):
            continue
        due = scheduling.add_business_days(db.parse_ts(last["sent_at"]), gaps[step - 1], s.sequence.send_days)
        if p["snooze_until"]:
            due = max(due, db.parse_ts(p["snooze_until"]))
        # Draft a day early so there's time to review before it's due.
        if now < due - timedelta(days=1):
            continue
        try:
            mid = writer.draft_email(s, pid, step)
            msg = db.get_message(mid)
            db.update_message(mid, meta={**msg["meta"], "due_at": due.isoformat()})
            if s.sequence.auto_approve_followups and not msg["meta"].get("warnings"):
                approve(s, mid)
            n += 1
        except Exception as e:
            log.exception("follow-up drafting failed for %s", pid)
            db.log(pid, "error", f"follow-up drafting failed: {e}")
    return n


# --- human-in-the-loop actions -------------------------------------------------

def approve(s: Settings, mid: int, *, subject: str | None = None, body: str | None = None) -> dict:
    m = db.get_message(mid)
    if not m or m["direction"] != "out":
        raise ApprovalError("not an outbound message")
    if m["status"] not in ("pending_approval", "failed"):
        raise ApprovalError(f"message is {m['status']}")
    subject = (subject if subject is not None else m["subject"]).strip()
    body = (body if body is not None else m["body"]).replace("\r\n", "\n").strip()
    if replies.CONFIRM_RE.search(body):
        raise ApprovalError("fill in the [CONFIRM: ...] placeholders first")
    p = db.get_prospect(m["prospect_id"])
    if not p["email"]:
        raise ApprovalError("prospect has no email address")
    if db.is_suppressed(p["email"]):
        raise ApprovalError(f"{p['email']} is on the suppression list")

    now = _utcnow()
    tz = scheduling.prospect_tz(s, p)
    if m["purpose"] in SEQUENCE_PURPOSES:
        not_before = max(now, db.parse_ts(m["meta"].get("due_at")) or now)
        when = scheduling.next_send_time(s, tz, not_before)
    else:
        # Conversational replies go out soon, but not instantly — nobody replies in 4 seconds.
        when = now + timedelta(minutes=random.randint(2, 9))
    edited = subject != m["subject"] or body != m["body"]
    db.update_message(mid, subject=subject, body=body, status="approved", scheduled_for=when.isoformat(),
                      meta={**m["meta"], "human_edited": edited})
    if m["meeting_id"]:
        db.update_meeting(m["meeting_id"], status="approved")
    if m["purpose"] == "initial":
        db.set_status(p["id"], "scheduled", f"first email at {when.isoformat()}")
    db.log(p["id"], "approved", f"message {mid}{' (edited)' if edited else ''} for {when.isoformat()}")
    return db.get_message(mid)


def reject(mid: int, *, stop_sequence: bool = False, reason: str = "") -> None:
    m = db.get_message(mid)
    db.update_message(mid, status="rejected", meta={**m["meta"], "rejected_reason": reason})
    if m["meeting_id"]:
        db.update_meeting(m["meeting_id"], status="rejected")
    db.log(m["prospect_id"], "rejected", f"message {mid}: {reason}")
    if stop_sequence or m["purpose"] == "initial":
        db.cancel_pending_outbound(m["prospect_id"], "rejected by human")
        db.set_status(m["prospect_id"], "paused", reason or "rejected by human")


def regenerate(s: Settings, mid: int, feedback: str) -> int:
    """Rewrite a pending draft using the human's feedback."""
    m = db.get_message(mid)
    if m["purpose"] in SEQUENCE_PURPOSES:
        return writer.draft_email(s, m["prospect_id"], m["step"] or 0, feedback=feedback, replace_message_id=mid)
    p = db.get_prospect(m["prospect_id"])
    inbound = db.get_message(m["meta"]["in_reply_to_message"])
    from .schemas import ReplyDraft
    from . import style
    prev = m["meta"].get("raw_body", m["body"])
    draft = replies.draft_reply(s, p, inbound, f"Rewrite this draft reply:\n<draft>\n{prev}\n</draft>\n"
                                              f"Feedback from the human: {feedback}")
    meta = {**m["meta"], "raw_body": draft.body, "notes_for_human": draft.notes_for_human, "feedback": feedback}
    warnings = []
    if replies.CONFIRM_RE.search(draft.body):
        warnings.append("contains [CONFIRM: ...] placeholders you must fill in before approving")
    meta["warnings"] = warnings + [w for w in style.lint(s, m["subject"], draft.body, max_words=160, allow_links=True,
                                                         first_name=p["first_name"]) if not w.startswith("subject")]
    db.update_message(mid, body=style.compose(s, draft.body, include_opt_out=False), meta=meta, status="pending_approval")
    return mid


# --- sending -------------------------------------------------------------------

def _sent_last_24h() -> int:
    since = (_utcnow() - timedelta(hours=24)).isoformat()
    return db.row(
        "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' "
        "AND purpose IN ('initial', 'followup') AND sent_at >= ?", since)["n"]


def _last_cold_send() -> datetime | None:
    r = db.row("SELECT MAX(sent_at) AS t FROM messages WHERE direction = 'out' AND status = 'sent' "
               "AND purpose IN ('initial', 'followup')")
    return db.parse_ts(r["t"]) if r and r["t"] else None


def send_due(s: Settings, mailer: Mailer, calendar: Calendar | None) -> int:
    now = _utcnow()
    due = db.rows("SELECT id FROM messages WHERE direction = 'out' AND status = 'approved' AND scheduled_for <= ? "
                  "ORDER BY CASE purpose WHEN 'initial' THEN 1 WHEN 'followup' THEN 1 ELSE 0 END, scheduled_for",
                  now.isoformat())
    sent = 0
    for r in due:
        m = db.get_message(r["id"])
        p = db.get_prospect(m["prospect_id"])
        cold = m["purpose"] in SEQUENCE_PURPOSES
        if db.is_suppressed(p["email"]):
            db.update_message(m["id"], status="cancelled", meta={**m["meta"], "cancel_reason": "suppressed"})
            continue
        if cold:
            _, replied = _sequence_state(p["id"])
            if replied or p["status"] not in ("scheduled", "active", "awaiting_approval"):
                db.update_message(m["id"], status="cancelled", meta={**m["meta"], "cancel_reason": f"prospect is {p['status']}"})
                continue
            if _sent_last_24h() >= s.sequence.daily_send_cap:
                break
            last = _last_cold_send()
            if last and (now - last).total_seconds() < s.sequence.min_seconds_between_sends:
                break
            tz = scheduling.prospect_tz(s, p)
            if not scheduling.in_send_window(s, tz, now):
                db.update_message(m["id"], scheduled_for=scheduling.next_send_time(s, tz, now).isoformat())
                continue

        if m["purpose"] == "meeting_confirm" and m["meeting_id"]:
            if not _book_meeting(s, m, p, calendar):
                continue

        thread_id, in_reply_to, references = _threading(m, p)
        try:
            ref = mailer.send(to=p["email"], subject=m["subject"], body=m["body"], from_name=s.sender.name,
                              from_email=s.sender.email, thread_id=thread_id, in_reply_to=in_reply_to,
                              references=references)
        except Exception as e:
            log.exception("send failed for message %s", m["id"])
            db.update_message(m["id"], status="failed", meta={**m["meta"], "error": str(e)})
            db.log(p["id"], "send_failed", str(e))
            continue
        db.update_message(m["id"], status="sent", sent_at=_utcnow().isoformat(), gmail_id=ref.gmail_id,
                          gmail_thread_id=ref.thread_id, rfc_message_id=ref.rfc_message_id)
        if not p["gmail_thread_id"]:
            db.update_prospect(p["id"], gmail_thread_id=ref.thread_id)
        if m["purpose"] == "initial":
            db.set_status(p["id"], "active", "first email sent")
        db.log(p["id"], "sent", f"{m['purpose']} step={m['step']} message={m['id']}")
        sent += 1
        if cold:
            break  # at most one cold email per tick keeps sends spaced out naturally
    return sent


def _threading(m: dict, p: dict) -> tuple[str | None, str | None, str | None]:
    history = [x for x in db.thread(p["id"]) if x["rfc_message_id"] and x["status"] in ("sent", "received", "handled")]
    if m["purpose"] == "initial":
        return None, None, None
    target = None
    if m["meta"].get("in_reply_to_message"):
        target = db.get_message(m["meta"]["in_reply_to_message"])
    elif history:
        target = history[-1]
    refs = " ".join(x["rfc_message_id"] for x in history) or None
    thread_id = (target or {}).get("gmail_thread_id") or p["gmail_thread_id"] or None
    return thread_id, (target or {}).get("rfc_message_id"), refs


def _book_meeting(s: Settings, m: dict, p: dict, calendar: Calendar | None) -> bool:
    meeting = db.row("SELECT * FROM meetings WHERE id = ?", m["meeting_id"])
    if meeting["status"] == "booked":
        return True
    if calendar is None:
        db.update_message(m["id"], status="failed", meta={**m["meta"], "error": "Google Calendar not connected"})
        return False
    start, end = db.parse_ts(meeting["start"]), db.parse_ts(meeting["end"])
    try:
        if calendar.busy(start, end):
            raise RuntimeError("slot is no longer free")
        ev = calendar.create_event(
            summary=f"{s.sender.company} <> {p['company']}",
            description=f"{p['full_name']} ({p['title']}, {p['company']}) and {s.sender.name}.",
            start=start, end=end, attendees=[p["email"]], add_meet=s.meetings.add_google_meet,
        )
    except Exception as e:
        db.update_meeting(meeting["id"], status="failed")
        db.update_message(m["id"], status="failed", meta={**m["meta"], "error": f"booking failed: {e}"})
        db.log(p["id"], "booking_failed", str(e))
        return False
    db.update_meeting(meeting["id"], status="booked", calendar_event_id=ev.event_id, meet_link=ev.meet_link)
    db.set_status(p["id"], "meeting_booked", meeting["start"])
    return True


# --- the loop ------------------------------------------------------------------

def tick(s: Settings, *, mailer: Mailer | None = None, calendar: Calendar | None = None,
         research_limit: int = 5) -> dict:
    if mailer is None and calendar is None:
        mailer, calendar = google_clients(s)
    report = {}
    if mailer:
        report["inbound"] = sync_inbox(s, mailer)
    report["replies_handled"] = process_inbound(s, calendar)
    report["researched"] = run_research(s, limit=research_limit)
    report["drafted_initial"] = draft_initial_emails(s)
    report["drafted_followups"] = draft_followups(s)
    if mailer:
        report["sent"] = send_due(s, mailer, calendar)
    else:
        report["sent"] = 0
        report["warning"] = "Google not connected: nothing sent, inbox not checked"
    return report
