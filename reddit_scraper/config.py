SUBREDDITS = [
    "Accounting",
    "accounting",
    "Bookkeeping",
    "taxpros",
    "CPA",
    "startups",
    "smallbusiness",
    "CFO",
    "fintech",
    "EntrepreneurRideAlong",
    "SaaS",
    "FPandA",
]

SEARCH_PROFILES = {
    "accountants_wanting_ai": {
        "label": "Accountants interested in AI / automation",
        "subreddits": [
            "Accounting", "accounting", "Bookkeeping", "taxpros", "CPA",
        ],
        "queries": [
            "AI tool accounting",
            "AI automation bookkeeping",
            "automate accounting",
            "ChatGPT accounting",
            "AI month end",
            "machine learning accounting",
            "automation software accounting",
            "AI reconciliation",
            "looking for AI",
            "tried AI",
            "want to automate",
            "AI for accountants",
            "copilot accounting",
        ],
        "keyword_filters": [
            "ai", "artificial intelligence", "machine learning", "automate",
            "automation", "chatgpt", "gpt", "copilot", "llm", "bot",
            "software", "tool", "app", "platform", "saas", "try",
            "looking for", "recommend", "suggestion",
        ],
    },
    "startup_finance_month_end": {
        "label": "Startup finance people frustrated with month-end",
        "subreddits": [
            "startups", "smallbusiness", "CFO", "fintech",
            "EntrepreneurRideAlong", "SaaS", "FPandA",
            "Accounting", "accounting", "Bookkeeping",
        ],
        "queries": [
            "month end close",
            "month-end close nightmare",
            "closing the books",
            "month end reconciliation",
            "hate month end",
            "month end takes forever",
            "month end process slow",
            "financial close painful",
            "close process startup",
            "accruals month end",
            "month end spreadsheet",
            "manual reconciliation",
            "finance team burnout",
            "month end hell",
        ],
        "keyword_filters": [
            "month end", "month-end", "close", "closing", "reconciliation",
            "accrual", "journal entry", "spreadsheet", "manual",
            "painful", "nightmare", "hate", "frustrat", "slow",
            "takes forever", "burnout", "overtime", "late nights",
            "error", "mistake", "tedious", "boring",
        ],
    },
}

USER_AGENT = "SeraOS-LeadFinder/1.0 (research bot)"

RESULTS_DIR = "reddit_scraper/results"
STATE_FILE = "reddit_scraper/results/seen_posts.json"
REPORT_FILE = "reddit_scraper/results/leads_report.md"
RAW_DATA_FILE = "reddit_scraper/results/leads_raw.json"

REQUEST_DELAY_SECONDS = 2.5
MAX_POSTS_PER_QUERY = 25
MAX_COMMENTS_PER_POST = 10
POST_AGE_LIMIT_DAYS = 30
