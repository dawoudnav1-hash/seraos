"""Review UI: the human-in-the-loop surface. Approve / edit / regenerate / reject every outbound message."""

from __future__ import annotations

import logging
import os
import secrets
import tempfile
import threading
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.templating import Jinja2Templates

from .. import config, db, pipeline, scheduling
from ..importer import import_csv

log = logging.getLogger(__name__)

security = HTTPBasic(auto_error=False)


def auth(creds: HTTPBasicCredentials | None = Depends(security)):
    password = os.environ.get("OUTBOUND_UI_PASSWORD")
    if not password:
        return
    if not creds or not secrets.compare_digest(creds.password.encode(), password.encode()):
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})


app = FastAPI(title="Outbound", dependencies=[Depends(auth)])
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
_busy: set[int] = set()
_busy_lock = threading.Lock()

ACTIVE = ("active", "scheduled", "replied", "meeting_pending", "nurture")


@app.on_event("startup")
def _startup():
    db.init()


def settings():
    return config.load_settings()


def _render(request: Request, name: str, **ctx):
    counts = db.row(
        "SELECT (SELECT COUNT(*) FROM messages WHERE status = 'pending_approval') AS queue, "
        "(SELECT COUNT(*) FROM messages WHERE status = 'failed') AS failed, "
        "(SELECT COUNT(*) FROM meetings WHERE status = 'booked') AS meetings")
    try:
        problems = settings().problems()
    except FileNotFoundError as e:
        problems = [str(e)]
    return templates.TemplateResponse(request, name, {"counts": counts, "config_problems": problems, **ctx})


def _redirect(url: str):
    return RedirectResponse(url, status_code=303)


def _in_background(pid: int, fn, *args):
    """Run slow LLM work off the request thread; one job per prospect at a time."""
    with _busy_lock:
        if pid in _busy:
            return False
        _busy.add(pid)

    def run():
        try:
            fn(*args)
        except Exception as e:
            log.exception("background job failed")
            db.log(pid, "error", str(e))
        finally:
            with _busy_lock:
                _busy.discard(pid)

    threading.Thread(target=run, daemon=True).start()
    return True


# --- queue ---------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def queue(request: Request):
    items = []
    for m in db.rows("SELECT id FROM messages WHERE status IN ('pending_approval', 'failed') ORDER BY "
                     "CASE purpose WHEN 'initial' THEN 2 WHEN 'followup' THEN 1 ELSE 0 END, id"):
        msg = db.get_message(m["id"])
        p = db.get_prospect(msg["prospect_id"])
        dossier = db.latest_dossier(p["id"])
        facts = {}
        if dossier:
            facts = {f["id"]: f for f in dossier["data"]["facts"]}
        inbound = db.get_message(msg["meta"]["in_reply_to_message"]) if msg["meta"].get("in_reply_to_message") else None
        items.append({"m": msg, "p": p, "facts": [facts[i] for i in msg["meta"].get("fact_ids_used", []) if i in facts],
                      "inbound": inbound, "dossier": dossier, "busy": p["id"] in _busy})
    return _render(request, "queue.html", items=items)


@app.post("/messages/{mid}/approve", response_class=HTMLResponse)
def approve(request: Request, mid: int, subject: str = Form(...), body: str = Form(...)):
    try:
        pipeline.approve(settings(), mid, subject=subject, body=body)
    except pipeline.ApprovalError as e:
        m = db.get_message(mid)
        return _render(request, "error.html", error=str(e), prospect_id=m["prospect_id"] if m else None)
    return _redirect("/")


@app.post("/messages/{mid}/reject")
def reject(mid: int, reason: str = Form(""), stop: str = Form("")):
    pipeline.reject(mid, stop_sequence=bool(stop), reason=reason)
    return _redirect("/")


@app.post("/messages/{mid}/regenerate")
def regenerate(mid: int, feedback: str = Form(...)):
    m = db.get_message(mid)
    _in_background(m["prospect_id"], pipeline.regenerate, settings(), mid, feedback)
    return _redirect("/")


@app.post("/messages/{mid}/unschedule")
def unschedule(mid: int):
    m = db.get_message(mid)
    if m["status"] == "approved":
        db.update_message(mid, status="pending_approval", scheduled_for=None)
    return _redirect(f"/prospects/{m['prospect_id']}")


# --- prospects -----------------------------------------------------------------

@app.get("/prospects", response_class=HTMLResponse)
def prospects(request: Request, status: str = "", q: str = ""):
    sql = "SELECT * FROM prospects WHERE 1=1"
    args: list = []
    if status:
        sql += " AND status = ?"
        args.append(status)
    if q:
        sql += " AND (company LIKE ? OR full_name LIKE ? OR email LIKE ?)"
        args += [f"%{q}%"] * 3
    sql += " ORDER BY updated_at DESC LIMIT 500"
    statuses = db.rows("SELECT status, COUNT(*) AS n FROM prospects GROUP BY status ORDER BY n DESC")
    return _render(request, "prospects.html", prospects=db.rows(sql, *args), statuses=statuses,
                   status=status, q=q)


@app.get("/prospects/{pid}", response_class=HTMLResponse)
def prospect(request: Request, pid: int):
    p = db.get_prospect(pid)
    if not p:
        raise HTTPException(404)
    s = settings()
    tz = scheduling.prospect_tz(s, p)
    return _render(request, "prospect.html", p=p, dossier=db.latest_dossier(pid), thread=db.thread(pid),
                   events=db.rows("SELECT * FROM events WHERE prospect_id = ? ORDER BY id DESC LIMIT 50", pid),
                   meetings=db.rows("SELECT * FROM meetings WHERE prospect_id = ? ORDER BY id DESC", pid),
                   tz=tz.key, busy=pid in _busy, suppressed=db.is_suppressed(p["email"]))


@app.post("/prospects/{pid}/edit")
def edit_prospect(pid: int, full_name: str = Form(""), email: str = Form(""), title: str = Form(""),
                  timezone: str = Form(""), company: str = Form(""), domain: str = Form("")):
    p = db.get_prospect(pid)
    updates = {"full_name": full_name.strip(), "title": title.strip(), "timezone": timezone.strip(),
               "company": company.strip(), "domain": domain.strip()}
    if full_name.strip() and full_name.strip() != p["full_name"]:
        updates["first_name"] = full_name.strip().split()[0]
    if email.strip().lower() != p["email"]:
        updates["email"] = email.strip().lower()
        updates["email_source"] = "manual"
    db.update_prospect(pid, **updates)
    if p["status"] == "needs_email" and email.strip():
        db.set_status(pid, "researched", "email added")
    return _redirect(f"/prospects/{pid}")


@app.post("/prospects/{pid}/research")
def research_now(pid: int):
    from ..research import research_prospect
    _in_background(pid, research_prospect, settings(), pid)
    return _redirect(f"/prospects/{pid}")


@app.post("/prospects/{pid}/draft-now")
def draft_forced(pid: int):
    _in_background(pid, lambda: pipeline.draft_initial_emails(settings(), force_ids=[pid]))
    return _redirect(f"/prospects/{pid}")


@app.post("/prospects/{pid}/status")
def change_status(pid: int, status: str = Form(...), note: str = Form("")):
    allowed = {"paused", "active", "closed_lost", "closed_won", "queued_research", "researched", "disqualified"}
    if status not in allowed:
        raise HTTPException(400, "bad status")
    if status in ("paused", "closed_lost", "closed_won", "disqualified"):
        db.cancel_pending_outbound(pid, f"manually set to {status}")
    if status == "active" and not db.row(
            "SELECT 1 FROM messages WHERE prospect_id = ? AND purpose = 'initial' AND status = 'sent'", pid):
        status = "researched"  # never emailed: resume from drafting the first email
    db.set_status(pid, status, note or "manual")
    return _redirect(f"/prospects/{pid}")


@app.post("/prospects/{pid}/suppress")
def suppress(pid: int):
    p = db.get_prospect(pid)
    if p["email"]:
        db.suppress(p["email"], "manual")
    db.cancel_pending_outbound(pid, "suppressed")
    db.set_status(pid, "suppressed", "manual")
    return _redirect(f"/prospects/{pid}")


# --- add / import --------------------------------------------------------------

@app.get("/add", response_class=HTMLResponse)
def add_form(request: Request):
    return _render(request, "add.html")


@app.post("/add")
def add(full_name: str = Form(""), email: str = Form(""), title: str = Form(""), company: str = Form(...),
        domain: str = Form(""), linkedin_url: str = Form(""), country: str = Form(""), context: str = Form("")):
    pid = db.add_prospect(full_name=full_name, email=email, email_source="manual" if email else "", title=title,
                          company=company, domain=domain, linkedin_url=linkedin_url, country=country, context=context)
    db.set_status(pid, "queued_research", "added manually")
    return _redirect(f"/prospects/{pid}")


@app.post("/import", response_class=HTMLResponse)
async def do_import(request: Request, file: UploadFile = File(...)):
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        tmp.write(await file.read())
    try:
        res = import_csv(tmp.name)
    finally:
        os.unlink(tmp.name)
    return _render(request, "add.html", result=res)


# --- meetings / activity -------------------------------------------------------

@app.get("/meetings", response_class=HTMLResponse)
def meetings(request: Request):
    rows = db.rows("SELECT m.*, p.full_name, p.company, p.email FROM meetings m JOIN prospects p ON p.id = m.prospect_id "
                   "ORDER BY m.start DESC")
    return _render(request, "meetings.html", meetings=rows)


@app.get("/activity", response_class=HTMLResponse)
def activity(request: Request):
    rows = db.rows("SELECT e.*, p.company, p.full_name FROM events e LEFT JOIN prospects p ON p.id = e.prospect_id "
                   "ORDER BY e.id DESC LIMIT 300")
    scheduled = db.rows("SELECT m.id, m.purpose, m.subject, m.scheduled_for, p.id AS pid, p.full_name, p.company "
                        "FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE m.status = 'approved' "
                        "ORDER BY m.scheduled_for")
    return _render(request, "activity.html", events=rows, scheduled=scheduled)
