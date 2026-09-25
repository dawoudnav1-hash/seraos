"""Gmail + Google Calendar clients (OAuth installed-app flow, token cached on disk)."""

from __future__ import annotations

import base64
import email.utils
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Protocol

from . import config

log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]


def authorize(port: int = 8765, open_browser: bool = True) -> None:
    """Interactive one-time consent. Needs credentials.json (OAuth client, type 'Desktop app')."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not config.GOOGLE_CREDENTIALS.exists():
        raise FileNotFoundError(
            f"{config.GOOGLE_CREDENTIALS} not found. Create an OAuth client (Desktop app) in Google Cloud "
            "Console with the Gmail and Calendar APIs enabled, and download it there."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(config.GOOGLE_CREDENTIALS), SCOPES)
    creds = flow.run_local_server(port=port, open_browser=open_browser)
    config.GOOGLE_TOKEN.parent.mkdir(parents=True, exist_ok=True)
    config.GOOGLE_TOKEN.write_text(creds.to_json())


def _creds():
    if not config.GOOGLE_TOKEN.exists():
        raise RuntimeError("Google not authorized. Run `outbound google-auth` first.")
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = Credentials.from_authorized_user_file(str(config.GOOGLE_TOKEN), SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            config.GOOGLE_TOKEN.write_text(creds.to_json())
        else:
            raise RuntimeError("Google token invalid. Run `outbound google-auth` again.")
    return creds


def google_ready() -> bool:
    try:
        _creds()
        return True
    except Exception:
        return False


# --- Gmail ---------------------------------------------------------------------

@dataclass
class MailMessage:
    id: str
    thread_id: str
    rfc_message_id: str
    sender: str          # bare address, lowercased
    sender_raw: str
    to: str
    subject: str
    date: datetime
    text: str            # new content, quoted history stripped
    full_text: str
    labels: list[str]


@dataclass
class SentRef:
    gmail_id: str
    thread_id: str
    rfc_message_id: str


class Mailer(Protocol):
    def send(self, *, to: str, subject: str, body: str, from_name: str, from_email: str,
             thread_id: str | None = None, in_reply_to: str | None = None,
             references: str | None = None) -> SentRef: ...

    def thread_messages(self, thread_id: str) -> list[MailMessage]: ...

    def search(self, query: str, max_results: int = 20) -> list[MailMessage]: ...


_QUOTE_MARKERS = [
    re.compile(r"^On .{5,200}wrote:\s*$", re.M | re.S),
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.M | re.I),
    re.compile(r"^From: .+$\n^(Sent|Date): .+$", re.M),
    re.compile(r"^_{10,}$", re.M),
]


def strip_quoted(text: str) -> str:
    cut = len(text)
    for rx in _QUOTE_MARKERS:
        m = rx.search(text)
        if m:
            cut = min(cut, m.start())
    kept = [ln for ln in text[:cut].splitlines() if not ln.startswith(">")]
    return "\n".join(kept).strip()


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", html)
    html = re.sub(r"(?i)<blockquote.*", "", html, flags=re.S)  # quoted history in HTML replies
    text = re.sub(r"<[^>]+>", "", html)
    import html as _h
    return re.sub(r"\n{3,}", "\n\n", _h.unescape(text)).strip()


def _extract_text(payload: dict) -> str:
    def decode(data: str) -> str:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")

    plain, html = [], []

    def walk(part):
        mime = part.get("mimeType", "")
        data = part.get("body", {}).get("data")
        if data and mime == "text/plain":
            plain.append(decode(data))
        elif data and mime == "text/html":
            html.append(decode(data))
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    if plain:
        return "\n".join(plain)
    if html:
        return _html_to_text("\n".join(html))
    return ""


def _parse(msg: dict) -> MailMessage:
    headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
    sender_raw = headers.get("from", "")
    addr = email.utils.parseaddr(sender_raw)[1].lower()
    full = _extract_text(msg["payload"])
    return MailMessage(
        id=msg["id"],
        thread_id=msg["threadId"],
        rfc_message_id=headers.get("message-id", ""),
        sender=addr,
        sender_raw=sender_raw,
        to=headers.get("to", ""),
        subject=headers.get("subject", ""),
        date=datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=timezone.utc),
        text=strip_quoted(full),
        full_text=full,
        labels=msg.get("labelIds", []),
    )


class GmailClient:
    def __init__(self):
        from googleapiclient.discovery import build

        self.svc = build("gmail", "v1", credentials=_creds(), cache_discovery=False)

    def send(self, *, to, subject, body, from_name, from_email, thread_id=None, in_reply_to=None,
             references=None) -> SentRef:
        m = EmailMessage()
        m["To"] = to
        m["From"] = email.utils.formataddr((from_name, from_email))
        m["Subject"] = subject
        domain = from_email.split("@")[-1]
        m["Message-ID"] = f"<{uuid.uuid4().hex}@{domain}>"
        if in_reply_to:
            m["In-Reply-To"] = in_reply_to
            m["References"] = references or in_reply_to
        m.set_content(body)  # plain text only: no tracking pixels, no HTML
        raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
        payload = {"raw": raw}
        if thread_id:
            payload["threadId"] = thread_id
        sent = self.svc.users().messages().send(userId="me", body=payload).execute()
        # Gmail may rewrite Message-ID; read back the real one so later replies thread correctly.
        rfc_id = m["Message-ID"]
        try:
            meta = self.svc.users().messages().get(
                userId="me", id=sent["id"], format="metadata", metadataHeaders=["Message-ID"]).execute()
            for h in meta["payload"].get("headers", []):
                if h["name"].lower() == "message-id":
                    rfc_id = h["value"]
        except Exception:
            log.warning("could not read back Message-ID for %s", sent["id"])
        return SentRef(gmail_id=sent["id"], thread_id=sent["threadId"], rfc_message_id=rfc_id)

    def thread_messages(self, thread_id: str) -> list[MailMessage]:
        t = self.svc.users().threads().get(userId="me", id=thread_id, format="full").execute()
        return [_parse(m) for m in t.get("messages", [])]

    def search(self, query: str, max_results: int = 20) -> list[MailMessage]:
        res = self.svc.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
        out = []
        for ref in res.get("messages", []):
            full = self.svc.users().messages().get(userId="me", id=ref["id"], format="full").execute()
            out.append(_parse(full))
        return out


# --- Calendar ------------------------------------------------------------------

@dataclass
class CreatedEvent:
    event_id: str
    meet_link: str
    html_link: str


class Calendar(Protocol):
    def busy(self, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]: ...

    def create_event(self, *, summary: str, description: str, start: datetime, end: datetime,
                     attendees: list[str], add_meet: bool) -> CreatedEvent: ...


class CalendarClient:
    def __init__(self, calendar_id: str = "primary"):
        from googleapiclient.discovery import build

        self.svc = build("calendar", "v3", credentials=_creds(), cache_discovery=False)
        self.calendar_id = calendar_id

    def busy(self, start, end):
        res = self.svc.freebusy().query(body={
            "timeMin": start.astimezone(timezone.utc).isoformat(),
            "timeMax": end.astimezone(timezone.utc).isoformat(),
            "items": [{"id": self.calendar_id}],
        }).execute()
        periods = res["calendars"][self.calendar_id].get("busy", [])
        return [(datetime.fromisoformat(p["start"].replace("Z", "+00:00")),
                 datetime.fromisoformat(p["end"].replace("Z", "+00:00"))) for p in periods]

    def create_event(self, *, summary, description, start, end, attendees, add_meet) -> CreatedEvent:
        body = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start.isoformat()},
            "end": {"dateTime": end.isoformat()},
            "attendees": [{"email": a} for a in attendees],
            "reminders": {"useDefault": True},
        }
        if add_meet:
            body["conferenceData"] = {"createRequest": {
                "requestId": uuid.uuid4().hex, "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
        ev = self.svc.events().insert(
            calendarId=self.calendar_id, body=body, sendUpdates="all",
            conferenceDataVersion=1 if add_meet else 0,
        ).execute()
        meet = ev.get("hangoutLink", "")
        return CreatedEvent(event_id=ev["id"], meet_link=meet, html_link=ev.get("htmlLink", ""))
