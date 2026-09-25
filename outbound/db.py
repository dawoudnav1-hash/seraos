"""SQLite persistence. One connection per operation; WAL so the web UI and worker can run side by side."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    email_source TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    linkedin_url TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    status_note TEXT NOT NULL DEFAULT '',
    gmail_thread_id TEXT NOT NULL DEFAULT '',
    fit_score INTEGER,
    snooze_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prospects_status ON prospects(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prospects_email ON prospects(email) WHERE email != '';

CREATE TABLE IF NOT EXISTS dossiers (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    notes TEXT NOT NULL,
    data TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    direction TEXT NOT NULL,              -- out | in
    purpose TEXT NOT NULL,                -- initial | followup | reply | meeting_confirm | inbound
    step INTEGER,                         -- 0 = first email, 1.. = follow-ups
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,                 -- pending_approval | approved | sent | rejected | cancelled | failed | received | handled
    scheduled_for TEXT,
    sent_at TEXT,
    gmail_id TEXT,
    gmail_thread_id TEXT,
    rfc_message_id TEXT,
    meeting_id INTEGER,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS ix_messages_prospect ON messages(prospect_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_gmail ON messages(gmail_id) WHERE gmail_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    status TEXT NOT NULL,                 -- pending_approval | booked | rejected | failed
    calendar_event_id TEXT,
    meet_link TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppression (
    value TEXT PRIMARY KEY,               -- email address or @domain
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_prospect ON events(prospect_id);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _path() -> Path:
    return config.DB_PATH


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with connect() as c:
        c.executescript(SCHEMA)


def row(sql: str, *args) -> dict | None:
    with connect() as c:
        r = c.execute(sql, args).fetchone()
        return dict(r) if r else None


def rows(sql: str, *args) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def execute(sql: str, *args) -> int:
    with connect() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid


# --- prospects -----------------------------------------------------------------

PROSPECT_FIELDS = (
    "full_name", "first_name", "email", "email_source", "title", "linkedin_url",
    "company", "domain", "country", "timezone", "context",
)


def add_prospect(**fields: Any) -> int:
    data = {k: (fields.get(k) or "").strip() for k in PROSPECT_FIELDS}
    data["email"] = data["email"].lower()
    if data["full_name"] and not data["first_name"]:
        data["first_name"] = data["full_name"].split()[0]
    ts = now()
    cols = ", ".join(data) + ", status, created_at, updated_at"
    qs = ", ".join("?" for _ in data) + ", ?, ?, ?"
    pid = execute(f"INSERT INTO prospects ({cols}) VALUES ({qs})", *data.values(), "new", ts, ts)
    log(pid, "created", data["company"])
    return pid


def get_prospect(pid: int) -> dict | None:
    return row("SELECT * FROM prospects WHERE id = ?", pid)


def update_prospect(pid: int, **fields: Any) -> None:
    if not fields:
        return
    if "email" in fields and fields["email"]:
        fields["email"] = fields["email"].strip().lower()
    sets = ", ".join(f"{k} = ?" for k in fields)
    execute(f"UPDATE prospects SET {sets}, updated_at = ? WHERE id = ?", *fields.values(), now(), pid)


def set_status(pid: int, status: str, note: str = "") -> None:
    update_prospect(pid, status=status, status_note=note)
    log(pid, f"status:{status}", note)


# --- dossiers ------------------------------------------------------------------

def save_dossier(pid: int, notes: str, data: dict, sources: list[str]) -> int:
    return execute(
        "INSERT INTO dossiers (prospect_id, notes, data, sources, created_at) VALUES (?, ?, ?, ?, ?)",
        pid, notes, json.dumps(data), json.dumps(sources), now(),
    )


def latest_dossier(pid: int) -> dict | None:
    d = row("SELECT * FROM dossiers WHERE prospect_id = ? ORDER BY id DESC LIMIT 1", pid)
    if d:
        d["data"] = json.loads(d["data"])
        d["sources"] = json.loads(d["sources"])
    return d


# --- messages ------------------------------------------------------------------

def add_message(prospect_id: int, direction: str, purpose: str, status: str, subject: str = "",
                body: str = "", step: int | None = None, meta: dict | None = None, **extra: Any) -> int:
    ts = now()
    cols = ["prospect_id", "direction", "purpose", "status", "subject", "body", "step", "meta",
            "created_at", "updated_at", *extra.keys()]
    vals = [prospect_id, direction, purpose, status, subject, body, step, json.dumps(meta or {}),
            ts, ts, *extra.values()]
    mid = execute(
        f"INSERT INTO messages ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", *vals
    )
    return mid


def get_message(mid: int) -> dict | None:
    m = row("SELECT * FROM messages WHERE id = ?", mid)
    if m:
        m["meta"] = json.loads(m["meta"])
    return m


def update_message(mid: int, **fields: Any) -> None:
    if "meta" in fields and not isinstance(fields["meta"], str):
        fields["meta"] = json.dumps(fields["meta"])
    sets = ", ".join(f"{k} = ?" for k in fields)
    execute(f"UPDATE messages SET {sets}, updated_at = ? WHERE id = ?", *fields.values(), now(), mid)


def thread(pid: int) -> list[dict]:
    out = rows(
        "SELECT * FROM messages WHERE prospect_id = ? ORDER BY COALESCE(sent_at, created_at), id", pid
    )
    for m in out:
        m["meta"] = json.loads(m["meta"])
    return out


def cancel_pending_outbound(pid: int, reason: str) -> int:
    """Stop anything queued to go out to this prospect (e.g. because they replied)."""
    with connect() as c:
        cur = c.execute(
            "UPDATE messages SET status = 'cancelled', updated_at = ? "
            "WHERE prospect_id = ? AND direction = 'out' AND status IN ('pending_approval', 'approved') "
            "AND purpose IN ('initial', 'followup')",
            (now(), pid),
        )
        n = cur.rowcount
    if n:
        log(pid, "cancelled_outbound", f"{n} message(s): {reason}")
    return n


# --- meetings ------------------------------------------------------------------

def add_meeting(pid: int, start: str, end: str, status: str = "pending_approval") -> int:
    ts = now()
    return execute(
        "INSERT INTO meetings (prospect_id, start, end, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        pid, start, end, status, ts, ts,
    )


def update_meeting(mid: int, **fields: Any) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    execute(f"UPDATE meetings SET {sets}, updated_at = ? WHERE id = ?", *fields.values(), now(), mid)


# --- suppression ---------------------------------------------------------------

def suppress(value: str, reason: str) -> None:
    execute(
        "INSERT OR REPLACE INTO suppression (value, reason, created_at) VALUES (?, ?, ?)",
        value.strip().lower(), reason, now(),
    )


def is_suppressed(email: str) -> bool:
    email = email.strip().lower()
    if not email:
        return False
    domain = "@" + email.split("@")[-1]
    return row("SELECT 1 FROM suppression WHERE value IN (?, ?)", email, domain) is not None


# --- audit log -----------------------------------------------------------------

def log(pid: int | None, kind: str, detail: str = "") -> None:
    execute("INSERT INTO events (prospect_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
            pid, kind, detail[:2000], now())
