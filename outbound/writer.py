"""Writes first-touch and follow-up emails grounded in the research dossier."""

from __future__ import annotations

import json
import logging

from . import db, llm, style
from .config import Settings
from .schemas import EmailDraft

log = logging.getLogger(__name__)

WRITER_SYSTEM = """You write one-to-one cold emails that get replies because they read like a real person \
wrote them for exactly one reader. You are writing as {sender_name} ({sender_title}, {company}).

Voice: {voice}

What makes these work:
- Written like a busy founder typed it in two minutes. Short sentences, contractions, plain words, \
no marketing language, no flattery, no filler.
- The opener is one specific, recent, true observation about them or their company taken from the dossier. \
State it plainly, the way a peer would mention it ("Saw Barry just landed in Liquorland."), then connect it \
to a problem it likely creates for them. Never compliment, never say you "noticed" or "came across" anything, \
never mention that you researched them.
- One line on what we do, framed around their problem, with at most one concrete proof point from the \
seller's list. Never invent results, customers, numbers or claims about the seller.
- End with one low-friction question as the call to action. No calendar links, no attachments, no links at all.
- Never state anything about the prospect that isn't in the dossier facts. If a hook is weak, use a better \
one or go shorter; don't pad.
- Greet by first name only ("Hi Sam," or "Sam,"). No sign-off: the signature is added automatically.
- Subject: 2-5 words, lowercase except proper nouns, like an internal email between colleagues \
(e.g. "liquorland rollout", "repeat rate at bobby"). No questions, no emojis, no hype.
- Plain text only: no bullet points, no bold, no em dashes."""

FOLLOWUP_GUIDANCE = {
    "middle": """This is follow-up #{n}, sent in the same email thread with no reply yet. Do NOT say you're \
following up, checking in, bumping, or reference the previous email's lack of reply. Bring something new: a \
different hook from the dossier, a sharp insight about a problem companies at their stage hit, or a one-line \
example of how a similar company handled it. 2-4 sentences. Same low-friction ask, phrased differently.""",
    "last": """This is the final email in the thread. Short, gracious, zero guilt-tripping. Acknowledge it may \
not be a priority right now, leave one genuinely useful thought or offer, and give an easy out (e.g. ask if \
someone else owns this, or if it's worth revisiting later). 2-3 sentences.""",
}


def _system(s: Settings) -> str:
    return WRITER_SYSTEM.format(
        sender_name=s.sender.name, sender_title=s.sender.title or "founder", company=s.sender.company,
        voice=s.style.voice or "Direct, warm, peer-to-peer.",
    )


def _context(s: Settings, p: dict, dossier: dict) -> str:
    o = s.offer
    d = dossier["data"]
    proof = "\n".join(f"- {x}" for x in o.proof_points)
    facts = "\n".join(f"[{f['id']}] ({f['about']}, {f['date'] or 'undated'}) {f['claim']}" for f in d["facts"])
    hooks = "\n".join(f"- (strength {h['strength']}) {h['hook']} [{', '.join(h['fact_ids'])}]"
                      for h in sorted(d["personalization_hooks"], key=lambda h: -h["strength"]))
    pains = "\n".join(f"- {h['hypothesis']} ({h['reasoning']}) [{', '.join(h['fact_ids'])}]"
                      for h in d["pain_hypotheses"])
    return f"""<seller>
What we sell: {o.one_liner}
Problem we solve: {o.problem}
Proof points (the only claims you may make about us):
{proof}
Call to action style: {o.cta}
</seller>

<prospect>
First name: {p['first_name'] or '(unknown - use "Hi there,")'}
Title: {p['title']}
Company: {p['company']}
</prospect>

<dossier>
Company: {d['company_summary']}
Person: {d['person_summary']}
Why now: {'; '.join(d['triggers']) or 'n/a'}

Facts:
{facts}

Best hooks:
{hooks}

Likely pains:
{pains}
</dossier>"""


def _validate(draft: EmailDraft, dossier: dict, *, require_fact: bool) -> list[str]:
    ids = {f["id"] for f in dossier["data"]["facts"]}
    problems = []
    unknown = [i for i in draft.fact_ids_used if i not in ids]
    if unknown:
        problems.append(f"references facts not in the dossier: {unknown}")
    if require_fact and not draft.fact_ids_used:
        problems.append("does not use any dossier fact; the opener must be grounded in a real fact")
    return problems


def _generate(s: Settings, p: dict, dossier: dict, task: str, *, max_words: int, require_fact: bool,
              prior: list[dict] | None = None, feedback: str = "", previous_draft: EmailDraft | None = None
              ) -> tuple[EmailDraft, list[str]]:
    history = ""
    if prior:
        history = "\n\n<emails_already_sent_in_this_thread>\n" + "\n---\n".join(
            f"Subject: {m['subject']}\n{m['body']}" for m in prior) + "\n</emails_already_sent_in_this_thread>"
    prompt = f"{_context(s, p, dossier)}{history}\n\n<task>\n{task}\nHard limit: {max_words} words in the body.\n</task>"
    if previous_draft is not None:
        prompt += (f"\n\n<previous_draft>\nSubject: {previous_draft.subject}\n{previous_draft.body}\n</previous_draft>"
                   f"\n\n<revision_request>\n{feedback}\n</revision_request>\nRewrite the email addressing the revision request.")
    m = s.models
    draft = llm.parse(model=m.writing, system=_system(s), prompt=prompt, schema=EmailDraft, effort=m.writing_effort)
    problems = style.lint(s, draft.subject, draft.body, max_words=max_words, allow_links=False,
                          first_name=p["first_name"]) + _validate(draft, dossier, require_fact=require_fact)
    if problems:
        # One automatic repair pass on deterministic failures.
        fix = "Fix these problems while keeping what works:\n- " + "\n- ".join(problems)
        if feedback:
            fix = f"{feedback}\n\n{fix}"
        repaired = llm.parse(
            model=m.writing, system=_system(s),
            prompt=f"{_context(s, p, dossier)}{history}\n\n<task>\n{task}\nHard limit: {max_words} words.\n</task>"
                   f"\n\n<previous_draft>\nSubject: {draft.subject}\n{draft.body}\n</previous_draft>"
                   f"\n\n<revision_request>\n{fix}\n</revision_request>\nRewrite the email.",
            schema=EmailDraft, effort=m.writing_effort,
        )
        draft = repaired
        problems = style.lint(s, draft.subject, draft.body, max_words=max_words, allow_links=False,
                              first_name=p["first_name"]) + _validate(draft, dossier, require_fact=require_fact)
    return draft, problems


def _task_for_step(s: Settings, step: int) -> tuple[str, int, bool]:
    total_followups = len(s.sequence.followup_gaps_business_days)
    if step == 0:
        return "Write the first cold email.", s.style.max_words, True
    kind = "last" if step == total_followups else "middle"
    return FOLLOWUP_GUIDANCE[kind].format(n=step), s.style.followup_max_words, False


def draft_email(s: Settings, pid: int, step: int, *, feedback: str = "", replace_message_id: int | None = None) -> int:
    """Create a pending-approval email for `step` (0 = first touch). Returns the message id."""
    p = db.get_prospect(pid)
    dossier = db.latest_dossier(pid)
    if not dossier:
        raise ValueError("prospect has no research dossier yet")
    prior = [m for m in db.thread(pid) if m["direction"] == "out" and m["status"] == "sent"]
    task, max_words, require_fact = _task_for_step(s, step)

    previous = None
    if replace_message_id:
        old = db.get_message(replace_message_id)
        previous = EmailDraft(subject=old["subject"], body=old["meta"].get("raw_body", old["body"]),
                              fact_ids_used=old["meta"].get("fact_ids_used", []), angle=old["meta"].get("angle", ""))

    draft, problems = _generate(s, p, dossier, task, max_words=max_words, require_fact=require_fact,
                                prior=prior, feedback=feedback, previous_draft=previous)

    subject = draft.subject.strip()
    if step > 0 and prior:
        first_subject = prior[0]["subject"]
        subject = first_subject if first_subject.lower().startswith("re:") else f"Re: {first_subject}"
    body = style.compose(s, draft.body, include_opt_out=True)
    meta = {"raw_body": draft.body, "fact_ids_used": draft.fact_ids_used, "angle": draft.angle,
            "warnings": problems, "feedback": feedback}

    if replace_message_id:
        db.update_message(replace_message_id, subject=subject, body=body, meta=meta, status="pending_approval")
        mid = replace_message_id
    else:
        mid = db.add_message(pid, "out", "initial" if step == 0 else "followup", "pending_approval",
                             subject=subject, body=body, step=step, meta=meta)
    db.log(pid, "drafted", json.dumps({"message": mid, "step": step, "warnings": problems}))
    if step == 0:
        db.set_status(pid, "awaiting_approval")
    return mid
