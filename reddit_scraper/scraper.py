"""
Reddit & Web Finance Leads Scraper

Designed to run inside a Claude Code session using Exa web search MCP tools.
The scraper searches for two profiles:
  1. Accountants interested in AI tools / automation
  2. Startup finance people frustrated with month-end close

Since Exa tools are MCP-based (invoked by Claude, not by Python),
this module handles data processing, deduplication, and report generation.
Raw leads are added via add_lead() and then saved/reported.
"""

import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from . import config


class LeadProcessor:
    def __init__(self):
        self.results_dir = Path(config.RESULTS_DIR)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self.seen_ids = self._load_seen()
        self.leads = []
        self.stats = {"new_leads": 0, "duplicates_skipped": 0}

    def _load_seen(self):
        path = Path(config.STATE_FILE)
        if path.exists():
            return set(json.loads(path.read_text()))
        return set()

    def _save_seen(self):
        path = Path(config.STATE_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(self.seen_ids), indent=2))

    def _make_id(self, url):
        return hashlib.md5(url.encode()).hexdigest()[:12]

    def add_lead(self, profile, title, url, author="unknown", source="web",
                 highlights="", published="", score=0, subreddit="",
                 relevant_comments=None):
        lead_id = self._make_id(url)
        if lead_id in self.seen_ids:
            self.stats["duplicates_skipped"] += 1
            return False

        self.seen_ids.add(lead_id)

        profile_cfg = config.SEARCH_PROFILES.get(profile, {})
        combined = f"{title} {highlights}"
        matched_keywords = self._matches_keywords(
            combined, profile_cfg.get("keyword_filters", [])
        )

        lead = {
            "id": lead_id,
            "profile": profile,
            "profile_label": profile_cfg.get("label", profile),
            "title": title,
            "url": url,
            "author": author,
            "source": source,
            "subreddit": subreddit,
            "highlights": highlights[:3000],
            "published": published,
            "score": score,
            "matched_keywords": matched_keywords,
            "relevant_comments": relevant_comments or [],
            "scraped_at": datetime.now(tz=timezone.utc).isoformat(),
        }

        self.leads.append(lead)
        self.stats["new_leads"] += 1
        return True

    def _matches_keywords(self, text, keywords):
        text_lower = text.lower()
        return [kw for kw in keywords if kw.lower() in text_lower]

    def save(self):
        self._save_seen()
        self._save_raw()
        self._generate_report()

    def _save_raw(self):
        path = Path(config.RAW_DATA_FILE)
        existing = []
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except json.JSONDecodeError:
                pass
        existing.extend(self.leads)
        path.write_text(json.dumps(existing, indent=2, default=str))

    def _load_all_leads(self):
        path = Path(config.RAW_DATA_FILE)
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                pass
        return []

    def _generate_report(self):
        all_leads = self._load_all_leads()

        by_profile = {}
        for lead in all_leads:
            p = lead.get("profile", "unknown")
            by_profile.setdefault(p, []).append(lead)

        lines = [
            "# Reddit & Web Finance Leads Report",
            "",
            f"**Last updated:** {datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}  ",
            f"**Total leads:** {len(all_leads)}  ",
            f"**New this run:** {len(self.leads)}  ",
            f"**Duplicates skipped:** {self.stats['duplicates_skipped']}",
            "",
            "---",
            "",
        ]

        if self.leads:
            lines.append("## NEW LEADS THIS RUN")
            lines.append("")
            for lead in self.leads:
                lines.extend(self._format_lead(lead, is_new=True))
            lines.append("---")
            lines.append("")

        for profile_name, leads in by_profile.items():
            label = leads[0].get("profile_label", profile_name)
            leads_sorted = sorted(
                leads,
                key=lambda x: x.get("published", ""),
                reverse=True,
            )
            lines.append(f"## {label}")
            lines.append(f"*{len(leads)} leads total*")
            lines.append("")

            for lead in leads_sorted:
                lines.extend(self._format_lead(lead))

        path = Path(config.REPORT_FILE)
        path.write_text("\n".join(lines))
        return path

    def _format_lead(self, lead, is_new=False):
        lines = []
        prefix = "NEW " if is_new else ""
        lines.append(f"### {prefix}{lead['title']}")
        lines.append("")
        lines.append(f"| Field | Value |")
        lines.append(f"|-------|-------|")
        lines.append(f"| **Author** | {lead.get('author', '?')} |")
        lines.append(f"| **Source** | {lead.get('source', '?')} |")
        if lead.get("subreddit"):
            lines.append(f"| **Subreddit** | r/{lead['subreddit']} |")
        lines.append(f"| **Published** | {lead.get('published', '?')} |")
        kws = lead.get("matched_keywords", [])
        if kws:
            lines.append(f"| **Keywords** | {', '.join(kws[:10])} |")
        lines.append(f"| **Link** | {lead['url']} |")
        lines.append("")

        highlights = lead.get("highlights", "").strip()
        if highlights:
            preview = highlights[:800].replace("\n", " ")
            lines.append(f"> {preview}")
            if len(highlights) > 800:
                lines.append("> *(truncated)*")
            lines.append("")

        comments = lead.get("relevant_comments", [])
        if comments:
            lines.append(f"**Relevant comments ({len(comments)}):**")
            lines.append("")
            for c in comments[:5]:
                body = str(c.get("body", c) if isinstance(c, dict) else c)[:300]
                body = body.replace("\n", " ")
                author = c.get("author", "?") if isinstance(c, dict) else "?"
                lines.append(f"- **{author}**: {body}")
            lines.append("")

        lines.append("---")
        lines.append("")
        return lines

    def get_summary(self):
        all_leads = self._load_all_leads()
        by_profile = {}
        authors = set()
        sources = {}

        for lead in all_leads:
            p = lead.get("profile", "unknown")
            by_profile[p] = by_profile.get(p, 0) + 1
            authors.add(lead.get("author", ""))
            s = lead.get("source", "unknown")
            sources[s] = sources.get(s, 0) + 1

        return {
            "total_leads": len(all_leads),
            "unique_authors": len(authors),
            "by_profile": by_profile,
            "by_source": sources,
            "new_this_run": len(self.leads),
        }
