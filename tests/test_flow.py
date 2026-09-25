"""End-to-end pipeline test with the model, Gmail and Calendar faked at their boundaries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from outbound import db, llm, pipeline
from outbound.schemas import Dossier, EmailDraft, ReplyAnalysis, ReplyDraft

DOSSIER = Dossier(
    company_summary="Barry is an Australian RTD seltzer brand.",
    person_summary="Nick is a co-founder and AFL player.",
    contact_name="Nick Daicos",
    contact_title="Co-founder",
    contact_linkedin="",
    email_candidates=[{"email": "nick@drinkbarry.com.au", "kind": "personal", "source_url": "https://drinkbarry.com.au/about"}],
    timezone="Australia/Melbourne",
    facts=[{"id": "F1", "about": "company", "claim": "Ranged in 995 Liquorland stores in 2026",
            "source_url": "https://insidefmcg.com.au/barry", "date": "2026-05"}],
    triggers=["Liquorland rollout [F1]"],
    pain_hypotheses=[{"hypothesis": "Retail growth outpacing D2C retention", "reasoning": "x", "fact_ids": ["F1"]}],
    personalization_hooks=[{"hook": "Liquorland rollout", "fact_ids": ["F1"], "strength": 5}],
    fit_score=4,
    fit_reasoning="Fast-growing D2C beverage brand.",
    disqualifiers=[],
)


class FakeLLM:
    def __init__(self):
        self.reply_intent = "interested"
        self.accepted_time = ""
        self.calls = []

    def run_with_server_tools(self, **kw):
        self.calls.append(("research", kw))
        return [SimpleNamespace(type="text", text="Notes: Barry in 995 Liquorland stores (https://insidefmcg.com.au/barry)",
                                citations=[SimpleNamespace(url="https://insidefmcg.com.au/barry")])]

    def parse(self, *, schema, prompt, **kw):
        self.calls.append((schema.__name__, prompt))
        if schema is Dossier:
            return DOSSIER
        if schema is EmailDraft:
            if "follow-up" in prompt or "final email" in prompt:
                return EmailDraft(subject="x", body="Hi Nick,\n\nOne thing we see at your stage: retail spikes new "
                                  "customers but few come back direct. Worth comparing notes?",
                                  fact_ids_used=[], angle="retention after retail")
            return EmailDraft(subject="liquorland rollout",
                              body="Hi Nick,\n\nSaw Barry just landed in 995 Liquorland stores. That usually brings a "
                                   "wave of first-time buyers who never come back to buy direct.\n\nWe run retention "
                                   "for D2C brands and took a skincare brand from 18% to 31% repeat rate in 5 months.\n\n"
                                   "Worth a quick chat?",
                              fact_ids_used=["F1"], angle="retail rollout creates retention gap")
        if schema is ReplyAnalysis:
            return ReplyAnalysis(intent=self.reply_intent, summary="s", accepted_time_iso=self.accepted_time,
                                 return_date="", referral_name="", referral_email="", follow_up_after="",
                                 needs_human=False, reasoning="r")
        if schema is ReplyDraft:
            return ReplyDraft(body="Hi Nick,\n\nSounds good. How about one of these?", notes_for_human="")
        raise AssertionError(schema)


@pytest.fixture
def fake_llm(monkeypatch):
    f = FakeLLM()
    monkeypatch.setattr(llm, "run_with_server_tools", f.run_with_server_tools)
    monkeypatch.setattr(llm, "parse", f.parse)
    return f


def _clock(monkeypatch, dt):
    monkeypatch.setattr(pipeline, "_utcnow", lambda: dt)


def test_full_cycle(settings, fake_llm, mailer, calendar, monkeypatch):
    pid = db.add_prospect(full_name="Nick Daicos", company="Barry", domain="drinkbarry.com.au", country="Australia",
                          email="hello@drinkbarry.com.au", email_source="import (generic inbox)")

    # Research: dossier stored, generic inbox upgraded to the person's public address.
    assert pipeline.run_research(settings) == 1
    p = db.get_prospect(pid)
    assert p["status"] == "researched" and p["fit_score"] == 4
    assert p["email"] == "nick@drinkbarry.com.au" and p["email_source"].startswith("research")
    assert p["timezone"] == "Australia/Melbourne"

    # Draft: goes to the review queue, nothing sent yet.
    assert pipeline.draft_initial_emails(settings) == 1
    [draft] = db.rows("SELECT id FROM messages WHERE status = 'pending_approval'")
    msg = db.get_message(draft["id"])
    assert msg["meta"]["warnings"] == [], msg["meta"]["warnings"]
    assert msg["body"].rstrip().endswith("won't follow up.")
    assert "\nDana" in msg["body"]
    assert pipeline.send_due(settings, mailer, calendar) == 0 and not mailer.sent

    # Human approves (with an edit); it sends at the scheduled time.
    edited = msg["body"].replace("Worth a quick chat?", "Open to a quick chat?")
    pipeline.approve(settings, msg["id"], subject="liquorland rollout", body=edited)
    t0 = datetime.now(timezone.utc) + timedelta(hours=3)
    _clock(monkeypatch, t0)
    assert pipeline.send_due(settings, mailer, calendar) == 1
    assert mailer.sent[0]["to"] == "nick@drinkbarry.com.au"
    assert "Open to a quick chat?" in mailer.sent[0]["body"]
    assert mailer.sent[0]["in_reply_to"] is None
    p = db.get_prospect(pid)
    assert p["status"] == "active" and p["gmail_thread_id"]
    thread_id = p["gmail_thread_id"]

    # Not yet due: no follow-up. After 3 business days: follow-up drafted in-thread.
    assert pipeline.draft_followups(settings) == 0
    _clock(monkeypatch, t0 + timedelta(days=6))
    assert pipeline.draft_followups(settings) == 1
    fu = db.get_message(db.row("SELECT id FROM messages WHERE purpose = 'followup'")["id"])
    assert fu["subject"] == "Re: liquorland rollout" and fu["step"] == 1
    pipeline.approve(settings, fu["id"])

    # Prospect replies before the follow-up goes out: follow-up is cancelled, reply with times drafted.
    mailer.reply_from(thread_id, "nick@drinkbarry.com.au", "Sure, happy to chat next week.")
    assert pipeline.sync_inbox(settings, mailer) == 1
    assert pipeline.sync_inbox(settings, mailer) == 0  # idempotent
    assert pipeline.process_inbound(settings, calendar) == 1
    assert db.get_message(fu["id"])["status"] == "cancelled"
    reply = db.get_message(db.row("SELECT id FROM messages WHERE purpose = 'reply'")["id"])
    assert reply["status"] == "pending_approval"
    assert len(reply["meta"]["offered_slots"]) == settings.meetings.slots_to_offer
    assert db.get_prospect(pid)["status"] == "replied"

    pipeline.approve(settings, reply["id"])
    _clock(monkeypatch, t0 + timedelta(days=6, minutes=15))
    assert pipeline.send_due(settings, mailer, calendar) == 1
    assert mailer.sent[-1]["thread_id"] == thread_id
    assert mailer.sent[-1]["in_reply_to"].startswith("<r")

    # They pick a slot: meeting pending approval; approving books it and sends the confirmation.
    slot = reply["meta"]["offered_slots"][0]
    fake_llm.reply_intent, fake_llm.accepted_time = "meeting_time", slot
    mailer.reply_from(thread_id, "nick@drinkbarry.com.au", "First one works.")
    pipeline.sync_inbox(settings, mailer)
    pipeline.process_inbound(settings, calendar)
    assert db.get_prospect(pid)["status"] == "meeting_pending"
    confirm = db.get_message(db.row("SELECT id FROM messages WHERE purpose = 'meeting_confirm'")["id"])
    assert not calendar.events
    pipeline.approve(settings, confirm["id"])
    _clock(monkeypatch, t0 + timedelta(days=6, hours=1))
    assert pipeline.send_due(settings, mailer, calendar) == 1
    assert calendar.events[0]["attendees"] == ["nick@drinkbarry.com.au"]
    assert calendar.events[0]["start"] == datetime.fromisoformat(slot)
    assert db.get_prospect(pid)["status"] == "meeting_booked"
    assert db.row("SELECT status, meet_link FROM meetings")["status"] == "booked"


def test_unsubscribe_suppresses_and_stops(settings, fake_llm, mailer, calendar, monkeypatch):
    pid = db.add_prospect(full_name="Sam Lee", company="Acme", email="sam@acme.com")
    pipeline.run_research(settings)
    db.update_prospect(pid, email="sam@acme.com")
    pipeline.draft_initial_emails(settings, force_ids=[pid])
    mid = db.row("SELECT id FROM messages")["id"]
    pipeline.approve(settings, mid)
    _clock(monkeypatch, datetime.now(timezone.utc) + timedelta(hours=3))
    pipeline.send_due(settings, mailer, calendar)
    tid = db.get_prospect(pid)["gmail_thread_id"]

    fake_llm.reply_intent = "unsubscribe"
    mailer.reply_from(tid, "sam@acme.com", "Please remove me from your list.")
    pipeline.sync_inbox(settings, mailer)
    pipeline.process_inbound(settings, calendar)
    assert db.get_prospect(pid)["status"] == "unsubscribed"
    assert db.is_suppressed("sam@acme.com")
    assert not db.rows("SELECT id FROM messages WHERE status = 'pending_approval'")
    # Even a manually created draft can't be approved to a suppressed address.
    m2 = db.add_message(pid, "out", "reply", "pending_approval", subject="x", body="y")
    with pytest.raises(pipeline.ApprovalError):
        pipeline.approve(settings, m2)


def test_daily_cap(settings, fake_llm, mailer, calendar, monkeypatch):
    settings.sequence.daily_send_cap = 2
    for i in range(4):
        pid = db.add_prospect(full_name=f"P {i}", company=f"Co{i}", email=f"p{i}@co{i}.com")
        db.save_dossier(pid, "n", DOSSIER.model_dump(), [])
        db.update_prospect(pid, fit_score=4)
        db.set_status(pid, "researched")
    pipeline.draft_initial_emails(settings)
    for r in db.rows("SELECT id FROM messages"):
        pipeline.approve(settings, r["id"])
    t = datetime.now(timezone.utc) + timedelta(hours=3)
    total = 0
    for k in range(6):
        _clock(monkeypatch, t + timedelta(minutes=k))
        total += pipeline.send_due(settings, mailer, calendar)
    assert total == 2


def test_placeholders_block_approval(settings, fake_llm):
    pid = db.add_prospect(full_name="A B", company="C", email="a@c.com")
    mid = db.add_message(pid, "out", "reply", "pending_approval", subject="Re: x",
                         body="Hi A,\n\nPricing is [CONFIRM: pricing].")
    with pytest.raises(pipeline.ApprovalError):
        pipeline.approve(settings, mid)
    pipeline.approve(settings, mid, subject="Re: x", body="Hi A,\n\nPricing starts at $2k/month.")
    assert db.get_message(mid)["status"] == "approved"


def test_low_fit_and_missing_email(settings, fake_llm):
    a = db.add_prospect(full_name="No Email", company="X")
    db.save_dossier(a, "n", {**DOSSIER.model_dump(), "email_candidates": []}, [])
    db.update_prospect(a, fit_score=5)
    db.set_status(a, "researched")
    b = db.add_prospect(full_name="Low Fit", company="Y", email="l@y.com")
    db.save_dossier(b, "n", DOSSIER.model_dump(), [])
    db.update_prospect(b, fit_score=1)
    db.set_status(b, "researched")
    assert pipeline.draft_initial_emails(settings) == 0
    assert db.get_prospect(a)["status"] == "needs_email"
    assert db.get_prospect(b)["status"] == "low_fit"


def test_transient_research_failure_requeues(settings, monkeypatch):
    import anthropic

    def boom(**kw):
        raise anthropic.APIConnectionError(request=None)

    monkeypatch.setattr(llm, "run_with_server_tools", boom)
    pid = db.add_prospect(full_name="A B", company="C")
    assert pipeline.run_research(settings) == 0
    assert db.get_prospect(pid)["status"] == "queued_research"
