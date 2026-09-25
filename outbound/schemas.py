"""Structured-output schemas the model fills in."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Fact(BaseModel):
    id: str = Field(description="Short id like F1, F2 ... unique within this dossier")
    about: Literal["person", "company", "market"]
    claim: str = Field(description="One specific, verifiable statement. No speculation.")
    source_url: str = Field(description="URL the claim came from")
    date: str = Field(description="When it happened / was published, YYYY-MM or YYYY-MM-DD; empty if unknown")


class EmailCandidate(BaseModel):
    email: str
    kind: Literal["personal", "role", "generic"] = Field(
        description="personal = the named person's own address; role = e.g. founders@; generic = hello@/info@/support@"
    )
    source_url: str = Field(description="Public page where this exact address appears")


class Hypothesis(BaseModel):
    hypothesis: str = Field(description="A pain or priority this person likely has right now that the seller's offer addresses")
    reasoning: str
    fact_ids: list[str]


class Hook(BaseModel):
    hook: str = Field(description="A specific observation a peer would genuinely notice, usable as an opener")
    fact_ids: list[str]
    strength: int = Field(description="1-5: 5 = recent, specific, about them personally, clearly linked to the offer")


class Dossier(BaseModel):
    company_summary: str = Field(description="3-5 sentences: what they sell, to whom, stage, size, channels")
    person_summary: str = Field(description="2-4 sentences on the contact: role, background, what they talk about publicly")
    contact_name: str = Field(description="Best decision-maker for this offer (the given prospect unless clearly wrong)")
    contact_title: str
    contact_linkedin: str
    email_candidates: list[EmailCandidate]
    timezone: str = Field(description="Best-guess IANA timezone for the contact, e.g. Australia/Sydney")
    facts: list[Fact]
    triggers: list[str] = Field(description="Why NOW: recent events (funding, launch, hire, expansion) with fact ids in brackets")
    pain_hypotheses: list[Hypothesis]
    personalization_hooks: list[Hook]
    fit_score: int = Field(description="1-5 fit against the seller's ideal customer. 1 = clearly not a fit")
    fit_reasoning: str
    disqualifiers: list[str] = Field(description="Hard reasons not to email (acquired, shut down, wrong segment...). Empty if none")


class EmailDraft(BaseModel):
    subject: str = Field(description="2-5 words, lowercase except proper nouns, no clickbait, no punctuation tricks")
    body: str = Field(description="Plain-text email body starting with the greeting. Do NOT include a sign-off or signature")
    fact_ids_used: list[str] = Field(description="Ids of dossier facts the email relies on")
    angle: str = Field(description="One line: the angle this email takes and why it should land for this person")


ReplyIntent = Literal[
    "interested",        # positive, wants to learn more / open to a chat
    "meeting_time",      # accepts or proposes a specific time
    "question",          # asks something before deciding
    "referral",          # points to someone else
    "not_now",           # timing is wrong, maybe later
    "not_interested",    # clear no
    "unsubscribe",       # stop emailing me / remove me
    "out_of_office",     # auto-reply
    "bounce",            # delivery failure
    "other",
]


class ReplyAnalysis(BaseModel):
    intent: ReplyIntent
    summary: str = Field(description="One sentence: what they said")
    accepted_time_iso: str = Field(
        description="If intent is meeting_time: the exact start time they accepted or proposed as ISO-8601 WITH UTC offset. Else empty"
    )
    return_date: str = Field(description="If out_of_office: the date they are back, YYYY-MM-DD. Else empty")
    referral_name: str
    referral_email: str
    follow_up_after: str = Field(description="If not_now and they mention when to reconnect: YYYY-MM-DD. Else empty")
    needs_human: bool = Field(description="True if the reply is sensitive, ambiguous, angry, or asks something only the seller can answer")
    reasoning: str


class ReplyDraft(BaseModel):
    body: str = Field(description="Plain-text reply body starting with the greeting. No sign-off or signature")
    notes_for_human: str = Field(description="Anything the human should check before sending (facts you were unsure of, pricing questions, etc.)")
