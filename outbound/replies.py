"""Understands inbound replies and drafts the next move (answer, propose times, confirm a meeting)."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

from . import db, llm, scheduling, style
from .config import Settings
from .google_api import Calendar
from .schemas import ReplyAnalysis, ReplyDraft

log = logging.getLogger(__name__)

CONFIRM_RE = re.compile(r"\[CONFIRM[^\]]*\]", re.I)

ANALYZE_SYSTEM = """You read replies to a salesperson's cold email thread and classify them precisely. \
Be conservative: a polite "maybe later" is not_now, not interested. Anything asking to stop or remove \
them is unsubscribe. Auto-replies are out_of_office. Delivery failures are bounce. If they accept one of \
the offered times, or propose a specific time, intent is meeting_time and you must give the exact start \
as ISO-8601 with the correct UTC offset for the timezone they meant (default to their timezone if unstated)."""

REPLY_SYSTEM = """You are {sender_name} ({sender_title}, {company}) replying to a prospect who wrote back \
to your cold email. Voice: {voice}

Rules:
- Reply like a person, not a sales rep: 2-5 short sentences, plain text, contractions, no em dashes, no \
bullet points, no hype, no "Great question!", no "Thanks for getting back to me!".
- Answer exactly what they asked or said. Match their energy and length.
- Only state facts about the seller that appear in <seller>. For anything you don't know (pricing, \
integrations, availability, specifics), insert a placeholder like [CONFIRM: pricing for 2 brands] so the \
human fills it in. Never guess.
- Greet by first name. No sign-off: the signature is added automatically."""


def _sys(s: Settings, template: str) -> str:
    return template.format(sender_name=s.sender.name, sender_title=s.sender.title or "founder",
                           company=s.sender.company, voice=s.style.voice)


def _seller(s: Settings) -> str:
    o = s.offer
    return (f"<seller>\nWhat we sell: {o.one_liner}\nProblem we solve: {o.problem}\n"
            f"Proof points:\n" + "\n".join(f"- {x}" for x in o.proof_points) +
            f"\nMeeting length: {o.meeting_length_minutes} minutes\n</seller>")


def _thread_text(pid: int) -> str:
    parts = []
    for m in db.thread(pid):
        if m["status"] not in ("sent", "received", "handled"):
            continue
        who = "US" if m["direction"] == "out" else "THEM"
        when = m["sent_at"] or m["created_at"]
        parts.append(f"[{who} {when}] Subject: {m['subject']}\n{m['body']}")
    return "\n\n---\n\n".join(parts)


def _last_offered_slots(pid: int) -> list[str]:
    for m in reversed(db.thread(pid)):
        if m["direction"] == "out" and m["meta"].get("offered_slots"):
            return m["meta"]["offered_slots"]
    return []


def analyze(s: Settings, p: dict, inbound: dict) -> ReplyAnalysis:
    ptz = scheduling.prospect_tz(s, p)
    offered = _last_offered_slots(p["id"])
    offered_txt = "\n".join(f"- {iso} ({scheduling.fmt_slot(datetime.fromisoformat(iso), ptz)})" for iso in offered)
    prompt = f"""Reply received at {inbound['created_at']} (UTC).
Prospect timezone: {ptz.key}. Our timezone: {s.sender.timezone}.
{"Times we offered:" + chr(10) + offered_txt if offered else "We have not offered specific times."}

<thread>
{_thread_text(p['id'])}
</thread>

<new_reply from="{p['full_name']} <{p['email']}>">
Subject: {inbound['subject']}
{inbound['body']}
</new_reply>"""
    m = s.models
    return llm.parse(model=m.replies, system=ANALYZE_SYSTEM, prompt=prompt, schema=ReplyAnalysis,
                     effort=m.replies_effort)


def draft_reply(s: Settings, p: dict, inbound: dict, instruction: str) -> ReplyDraft:
    dossier = db.latest_dossier(p["id"])
    brief = ""
    if dossier:
        d = dossier["data"]
        brief = f"<prospect_brief>\n{d['company_summary']}\n{d['person_summary']}\n</prospect_brief>\n\n"
    prompt = f"""{_seller(s)}

{brief}<thread>
{_thread_text(p['id'])}
</thread>

<their_latest_reply>
{inbound['body']}
</their_latest_reply>

Prospect first name: {p['first_name'] or 'there'}

<what_to_do>
{instruction}
</what_to_do>"""
    m = s.models
    return llm.parse(model=m.writing, system=_sys(s, REPLY_SYSTEM), prompt=prompt, schema=ReplyDraft,
                     effort=m.writing_effort)


def _queue_reply(s: Settings, p: dict, inbound: dict, draft: ReplyDraft, *, purpose: str = "reply",
                 extra_meta: dict | None = None, meeting_id: int | None = None) -> int:
    subject = inbound["subject"] if inbound["subject"].lower().startswith("re:") else f"Re: {inbound['subject']}"
    warnings = style.lint(s, subject, draft.body, max_words=160, allow_links=True, first_name=p["first_name"])
    warnings = [w for w in warnings if not w.startswith("subject too long")]
    if CONFIRM_RE.search(draft.body):
        warnings.insert(0, "contains [CONFIRM: ...] placeholders you must fill in before approving")
    meta = {"raw_body": draft.body, "notes_for_human": draft.notes_for_human, "warnings": warnings,
            "in_reply_to_message": inbound["id"], **(extra_meta or {})}
    extra = {"meeting_id": meeting_id} if meeting_id else {}
    return db.add_message(p["id"], "out", purpose, "pending_approval", subject=subject,
                          body=style.compose(s, draft.body, include_opt_out=False), meta=meta, **extra)


def _propose_times(s: Settings, p: dict, inbound: dict, calendar: Calendar | None, lead: str) -> int:
    ptz = scheduling.prospect_tz(s, p)
    now = datetime.now(timezone.utc)
    slots: list[datetime] = []
    if calendar is not None:
        busy = calendar.busy(now, now + timedelta(days=s.meetings.lookahead_business_days * 2 + 4))
        slots = scheduling.candidate_slots(s, busy, now, ptz)
    if slots:
        listed = "\n".join(scheduling.fmt_slot(x, ptz) for x in slots)
        instruction = (f"{lead} Offer these times for a {s.offer.meeting_length_minutes}-minute call, written "
                       f"exactly as given, each on its own line, and say you'll send an invite for whichever works "
                       f"(or they can suggest another time):\n{listed}")
    elif s.offer.booking_link:
        instruction = f"{lead} Suggest a {s.offer.meeting_length_minutes}-minute call and share this link to grab a time: {s.offer.booking_link}"
    else:
        instruction = f"{lead} Ask what time suits them next week for a {s.offer.meeting_length_minutes}-minute call."
    draft = draft_reply(s, p, inbound, instruction)
    return _queue_reply(s, p, inbound, draft, extra_meta={"offered_slots": [x.isoformat() for x in slots]})


def handle_inbound(s: Settings, inbound_id: int, calendar: Calendar | None) -> dict:
    inbound = db.get_message(inbound_id)
    p = db.get_prospect(inbound["prospect_id"])
    pid = p["id"]
    a = analyze(s, p, inbound)
    db.update_message(inbound_id, status="handled", meta={**inbound["meta"], "analysis": a.model_dump()})
    db.log(pid, f"reply:{a.intent}", a.summary)

    if a.intent == "out_of_office":
        try:
            back = datetime.fromisoformat(a.return_date).replace(tzinfo=timezone.utc) + timedelta(days=1)
        except ValueError:
            back = None
        if back:
            db.update_prospect(pid, snooze_until=back.isoformat())
            for m in db.rows("SELECT id FROM messages WHERE prospect_id = ? AND status = 'approved'", pid):
                db.update_message(m["id"], scheduled_for=scheduling.next_send_time(
                    s, scheduling.prospect_tz(s, p), back).isoformat())
        return a.model_dump()

    # A human replied: stop the automated sequence.
    db.cancel_pending_outbound(pid, f"prospect replied ({a.intent})")

    if a.intent == "bounce":
        db.suppress(p["email"], "bounced")
        db.set_status(pid, "bounced", a.summary)
    elif a.intent == "unsubscribe":
        db.suppress(p["email"], "unsubscribe request")
        db.set_status(pid, "unsubscribed", a.summary)
    elif a.intent == "not_interested":
        db.set_status(pid, "closed_lost", a.summary)
    elif a.intent == "not_now":
        if a.follow_up_after:
            db.update_prospect(pid, snooze_until=a.follow_up_after)
        db.set_status(pid, "nurture", a.summary)
        draft = draft_reply(s, p, inbound, "Short, gracious acknowledgement. If they gave a timeframe, say you'll "
                                           "reach back out then. No pitch.")
        _queue_reply(s, p, inbound, draft)
    elif a.intent == "interested":
        db.set_status(pid, "replied", a.summary)
        _propose_times(s, p, inbound, calendar, "They're open to talking. Keep it brief and warm.")
    elif a.intent == "meeting_time":
        _handle_meeting_time(s, p, inbound, a, calendar)
    elif a.intent == "referral":
        db.set_status(pid, "replied", a.summary)
        if a.referral_email and not db.is_suppressed(a.referral_email) and \
                not db.row("SELECT 1 FROM prospects WHERE email = ?", a.referral_email.lower()):
            new_id = db.add_prospect(full_name=a.referral_name, email=a.referral_email,
                                     email_source=f"referral from {p['full_name']}", company=p["company"],
                                     domain=p["domain"], country=p["country"],
                                     context=f"Referred by {p['full_name']} ({p['title']}): \"{inbound['body'][:500]}\"")
            db.log(new_id, "referral", f"from prospect {pid}")
        draft = draft_reply(s, p, inbound, "Thank them briefly for pointing you to the right person. One sentence is fine.")
        _queue_reply(s, p, inbound, draft)
    else:  # question / other
        db.set_status(pid, "replied", a.summary)
        draft = draft_reply(s, p, inbound, "Answer what they asked directly and honestly. If it's natural, "
                                           "close with a light suggestion to talk, without pushing.")
        _queue_reply(s, p, inbound, draft, extra_meta={"needs_human": True})

    if a.needs_human:
        db.log(pid, "needs_human", a.reasoning)
    return a.model_dump()


def _handle_meeting_time(s: Settings, p: dict, inbound: dict, a: ReplyAnalysis, calendar: Calendar | None) -> None:
    pid = p["id"]
    try:
        start = datetime.fromisoformat(a.accepted_time_iso)
        if start.tzinfo is None:
            start = start.replace(tzinfo=scheduling.prospect_tz(s, p))
    except ValueError:
        db.set_status(pid, "replied", "wants to meet; time unclear")
        _propose_times(s, p, inbound, calendar, "They want to meet but the time wasn't clear.")
        return
    end = start + timedelta(minutes=s.offer.meeting_length_minutes)
    if calendar is not None:
        clash = calendar.busy(start - timedelta(minutes=1), end + timedelta(minutes=1))
        if clash:
            db.set_status(pid, "replied", f"asked for {start.isoformat()} but calendar is busy")
            _propose_times(s, p, inbound, calendar, "The time they asked for no longer works for you; apologise briefly.")
            return
    meeting_id = db.add_meeting(pid, start.isoformat(), end.isoformat())
    ptz = scheduling.prospect_tz(s, p)
    draft = draft_reply(s, p, inbound, f"Confirm the meeting for {scheduling.fmt_slot(start, ptz)} and say a "
                                       f"calendar invite is on its way. One or two sentences.")
    _queue_reply(s, p, inbound, draft, purpose="meeting_confirm", meeting_id=meeting_id,
                 extra_meta={"meeting_start": start.isoformat()})
    db.set_status(pid, "meeting_pending", scheduling.fmt_slot(start, ptz))
    db.log(pid, "meeting_proposed", json.dumps({"meeting": meeting_id, "start": start.isoformat()}))
