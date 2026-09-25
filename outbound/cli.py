"""Command line entry point: `outbound <command>`."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time

from . import config, db


def _settings():
    return config.load_settings()


def cmd_init(a):
    db.init()
    print(f"Database ready at {config.DB_PATH}")
    if not config.CONFIG_PATH.exists():
        print(f"Next: cp config/seller.example.toml {config.CONFIG_PATH} and fill it in.")


def cmd_doctor(a):
    ok = True

    def check(label, passed, hint=""):
        nonlocal ok
        ok &= passed
        print(f"[{'ok' if passed else '!!'}] {label}" + ("" if passed else f"  -> {hint}"))

    try:
        s = _settings()
        problems = s.problems()
        check("seller config", not problems, f"fill in: {', '.join(problems)}")
    except FileNotFoundError as e:
        check("seller config", False, str(e))
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    check("Anthropic credentials", has_key, "export ANTHROPIC_API_KEY=... (or `ant auth login`)")
    check("Google OAuth client (credentials.json)", config.GOOGLE_CREDENTIALS.exists(),
          "see README: Google setup")
    from .google_api import google_ready
    check("Google authorized (Gmail + Calendar)", google_ready(), "run `outbound google-auth`")
    db.init()
    check("database", True)
    sys.exit(0 if ok else 1)


def cmd_google_auth(a):
    from .google_api import authorize
    authorize(port=a.port, open_browser=not a.no_browser)
    print(f"Saved Google token to {config.GOOGLE_TOKEN}")


def cmd_import(a):
    db.init()
    from .importer import import_csv
    res = import_csv(a.csv)
    print(f"Added {res['added']}, skipped {res['skipped']}")
    for r in res["reasons"][:20]:
        print("  ", r)


def cmd_add(a):
    db.init()
    pid = db.add_prospect(full_name=a.name, email=a.email or "", title=a.title or "", company=a.company,
                          domain=a.domain or "", linkedin_url=a.linkedin or "", country=a.country or "",
                          context=a.notes or "")
    print(f"Added prospect {pid}")


def cmd_research(a):
    from .research import research_prospect
    s = _settings()
    for pid in a.ids:
        d = research_prospect(s, pid)
        print(json.dumps(d, indent=2) if a.json else
              f"#{pid}: fit {d['fit_score']}/5, {len(d['facts'])} facts. {d['fit_reasoning']}")


def cmd_draft(a):
    from . import pipeline
    s = _settings()
    n = pipeline.draft_initial_emails(s, force_ids=a.ids)
    print(f"Drafted {n} email(s). Review them in the UI (`outbound serve`) or with `outbound queue`.")


def cmd_queue(a):
    for m in db.rows("SELECT m.id, m.purpose, m.subject, m.body, m.meta, p.full_name, p.company, p.email "
                     "FROM messages m JOIN prospects p ON p.id = m.prospect_id "
                     "WHERE m.status = 'pending_approval' ORDER BY m.id"):
        meta = json.loads(m["meta"])
        print(f"\n=== #{m['id']} [{m['purpose']}] to {m['full_name']} <{m['email']}> at {m['company']}")
        print(f"Subject: {m['subject']}\n\n{m['body']}")
        if meta.get("warnings"):
            print("\nWarnings:", "; ".join(meta["warnings"]))


def cmd_approve(a):
    from . import pipeline
    m = pipeline.approve(_settings(), a.id)
    print(f"Approved #{a.id}; scheduled for {m['scheduled_for']}")


def cmd_reject(a):
    from . import pipeline
    pipeline.reject(a.id, stop_sequence=a.stop, reason=a.reason or "")
    print(f"Rejected #{a.id}")


def cmd_tick(a):
    from . import pipeline
    db.init()
    print(json.dumps(pipeline.tick(_settings(), research_limit=a.research_limit), indent=2))


def cmd_worker(a):
    from . import pipeline
    db.init()
    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log = logging.getLogger("outbound.worker")
    log.info("worker started, interval %ss", a.interval)
    while not stop:
        try:
            s = _settings()  # re-read so config edits apply without a restart
            log.info("tick: %s", pipeline.tick(s, research_limit=a.research_limit))
        except Exception:
            log.exception("tick failed")
        for _ in range(a.interval):
            if stop:
                break
            time.sleep(1)


def cmd_serve(a):
    import uvicorn
    db.init()
    uvicorn.run("outbound.web.app:app", host=a.host, port=a.port, log_level="info")


def cmd_suppress(a):
    db.init()
    db.suppress(a.value, a.reason)
    print(f"Suppressed {a.value}")


def main(argv=None):
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(prog="outbound", description="Outbound sales agent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create the database").set_defaults(fn=cmd_init)
    sub.add_parser("doctor", help="check configuration and credentials").set_defaults(fn=cmd_doctor)

    p = sub.add_parser("google-auth", help="authorize Gmail + Calendar access")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")
    p.set_defaults(fn=cmd_google_auth)

    p = sub.add_parser("import", help="import prospects from CSV")
    p.add_argument("csv")
    p.set_defaults(fn=cmd_import)

    p = sub.add_parser("add", help="add one prospect")
    p.add_argument("--name", default="")
    p.add_argument("--company", required=True)
    p.add_argument("--email")
    p.add_argument("--title")
    p.add_argument("--domain")
    p.add_argument("--linkedin")
    p.add_argument("--country")
    p.add_argument("--notes")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("research", help="run deep research now")
    p.add_argument("ids", type=int, nargs="+")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_research)

    p = sub.add_parser("draft", help="draft first emails for researched prospects now")
    p.add_argument("ids", type=int, nargs="+")
    p.set_defaults(fn=cmd_draft)

    sub.add_parser("queue", help="show drafts waiting for approval").set_defaults(fn=cmd_queue)

    p = sub.add_parser("approve", help="approve a draft as-is")
    p.add_argument("id", type=int)
    p.set_defaults(fn=cmd_approve)

    p = sub.add_parser("reject", help="reject a draft")
    p.add_argument("id", type=int)
    p.add_argument("--stop", action="store_true", help="also stop the sequence for this prospect")
    p.add_argument("--reason")
    p.set_defaults(fn=cmd_reject)

    p = sub.add_parser("suppress", help="never email an address or @domain")
    p.add_argument("value")
    p.add_argument("--reason", default="manual")
    p.set_defaults(fn=cmd_suppress)

    p = sub.add_parser("tick", help="run one pipeline pass")
    p.add_argument("--research-limit", type=int, default=5)
    p.set_defaults(fn=cmd_tick)

    p = sub.add_parser("worker", help="run the pipeline continuously")
    p.add_argument("--interval", type=int, default=120)
    p.add_argument("--research-limit", type=int, default=5)
    p.set_defaults(fn=cmd_worker)

    p = sub.add_parser("serve", help="run the review UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(fn=cmd_serve)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
