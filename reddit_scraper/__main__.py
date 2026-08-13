#!/usr/bin/env python3
"""
Reddit & Web Finance Leads Processor

Processes leads collected via Exa web search into structured reports.

Usage:
  python -m reddit_scraper --stats        # show stats from collected data
  python -m reddit_scraper --report       # regenerate report from raw data
  python -m reddit_scraper --add-json F   # add leads from a JSON file
"""

import argparse
import json
import sys
from pathlib import Path

from . import config
from .scraper import LeadProcessor


def show_stats():
    proc = LeadProcessor()
    summary = proc.get_summary()

    print(f"\nTotal leads: {summary['total_leads']}")
    print(f"Unique authors: {summary['unique_authors']}")
    print(f"\nBy profile:")
    for p, count in sorted(summary["by_profile"].items(), key=lambda x: -x[1]):
        label = config.SEARCH_PROFILES.get(p, {}).get("label", p)
        print(f"  {label}: {count}")
    print(f"\nBy source:")
    for s, count in sorted(summary["by_source"].items(), key=lambda x: -x[1]):
        print(f"  {s}: {count}")


def regenerate_report():
    proc = LeadProcessor()
    proc._generate_report()
    print(f"Report regenerated at {config.REPORT_FILE}")


def add_from_json(filepath):
    data = json.loads(Path(filepath).read_text())
    proc = LeadProcessor()
    for lead in data:
        proc.add_lead(**lead)
    proc.save()
    print(f"Added {proc.stats['new_leads']} leads, skipped {proc.stats['duplicates_skipped']} duplicates")


def main():
    parser = argparse.ArgumentParser(description="Reddit & Web Finance Leads Processor")
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--add-json", type=str)
    args = parser.parse_args()

    if args.stats:
        show_stats()
    elif args.report:
        regenerate_report()
    elif args.add_json:
        add_from_json(args.add_json)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
