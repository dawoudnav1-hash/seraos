import type { Account, Contact, Dossier, ResearchClaim } from '../types';
import type { DraftStep } from './outreach';
import { isDoNotContact } from './outreach';

/**
 * Draft rules from .claude/skills/prospect-research/SKILL.md, and a TypeScript port of the draft checks in
 * pipeline/validate_research.py. Violations are shown as warnings above the draft; nothing is sent
 * without the owner confirming.
 */

export const SIGNOFF = 'Best,\nDawoud\nVert | https://vertfinance.tech';

export const WORD_LIMITS: Record<DraftStep, readonly [number, number]> = {
  first: [60, 110],
  followUp: [35, 80],
  followUp2: [25, 60],
};

export const BANNED_PATTERNS: readonly RegExp[] = [
  /hope (this|you).{0,20}well/i,
  /quick question/i,
  /\{\{/i,
  /\[(name|firm|company)\]/i,
  /lorem/i,
  /I came across your (profile|company)/i,
];

/** Vert's own numbers ("4 hours … in 5 minutes", "$100 … for $2–4", "10 min", "2x") need no citation. */
export const VERT_NUMBERS: ReadonlySet<string> = new Set(['4', '5', '100', '2', '2-4', '10', '2x']);

/** Claim categories that count as "about the person or something they did / published". */
const PERSONAL_CATEGORIES = new Set(['person', 'content', 'news', 'hiring', 'growth', 'personal']);

/** Word count, as validate_research.py counts it (\b[\w'’$%-]+\b), Unicode-aware. */
export function countWords(s: string): number {
  return (s.match(/[\p{L}\p{N}_$%]+(?:['’-]+[\p{L}\p{N}_$%]+)*/gu) ?? []).length;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

export function stripSignoff(body: string): string {
  return normalizeBody(body).split(SIGNOFF).join('');
}

/** A fact the draft may use: a dossier claim, or (without research) an unverified CRM note. */
export interface DraftFact {
  id: string;
  text: string;
  quote?: string;
  category?: string;
  /** "<publisher>, <date>" for claims; "unverified CRM notes" for notes */
  source: string;
}

export interface DraftInput {
  subject: string;
  body: string;
  claimIds: readonly string[];
}

export interface DraftCheckContext {
  step: DraftStep;
  facts: ReadonlyMap<string, DraftFact>;
  /** true when `facts` are research claims (enables the person/published-claim rule) */
  researched: boolean;
  contact?: Contact;
}

/** Every rule violation, as short human-readable warnings. An empty list means the draft passes. */
export function validateDraft(d: DraftInput, ctx: DraftCheckContext): string[] {
  const issues: string[] = [];
  const body = normalizeBody(d.body);
  const main = stripSignoff(body);
  if (!d.subject.trim()) issues.push('Subject is empty.');
  if (!body.trimEnd().endsWith(SIGNOFF)) issues.push('Must end with the exact sign-off: “Best, / Dawoud / Vert | https://vertfinance.tech”.');
  const [lo, hi] = WORD_LIMITS[ctx.step];
  const n = countWords(main);
  if (n < lo || n > hi) issues.push(`${n} words — allowed ${lo}–${hi} (sign-off excluded).`);
  const ids = [...d.claimIds];
  if (ids.length < 2) issues.push('Uses fewer than 2 facts (needs at least 2 listed facts).');
  const unknown = ids.filter((id) => !ctx.facts.has(id));
  if (unknown.length) issues.push(`Uses unknown fact id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  if (ctx.researched && ids.length && !ids.some((id) => PERSONAL_CATEGORIES.has(ctx.facts.get(id)?.category ?? ''))) {
    issues.push('Uses no fact about the person or something they did or published.');
  }
  for (const re of BANNED_PATTERNS) {
    if (re.test(body)) issues.push(`Contains a banned phrase (${re.source}).`);
  }
  if (/https?:\/\//i.test(main)) issues.push('Has a link outside the signature.');
  const cited = ids.map((id) => `${ctx.facts.get(id)?.text ?? ''} ${ctx.facts.get(id)?.quote ?? ''}`).join(' ');
  const flagged = new Set<string>();
  for (const raw of main.match(/\d[\d,.]*/g) ?? []) {
    const num = raw.replace(/[.,]+$/, '');
    if (VERT_NUMBERS.has(num) || cited.includes(num) || flagged.has(num)) continue;
    flagged.add(num);
    issues.push(`Mentions “${num}”, which no cited fact contains.`);
  }
  const c = ctx.contact;
  if (c) {
    if (!c.email) issues.push('Recipient has no email address.');
    if (isDoNotContact(c)) issues.push('Recipient is marked “Do not contact”.');
    if (c.likelyLeft) issues.push('Recipient is flagged as likely left the company.');
    const first = firstName(c.name);
    const greeted = greetingName(main);
    if (first && greeted && !sameFirstName(first, greeted)) issues.push(`Greeting addresses “${greeted}”, but the recipient is ${c.name}.`);
  }
  return issues;
}

/** The name after "Hi" / "Hello" / "Dear" on the first line, if any. */
export function greetingName(body: string): string | null {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  const m = /^\s*(?:hi|hello|hey|dear|g'day)\s+([\p{L}'’-]+)/iu.exec(line);
  return m ? m[1]! : null;
}

/** "Alex" greets "Alexander"; "Kate" greets "Katherine" (shared 3-letter start). */
export function sameFirstName(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x) || (x.length >= 3 && y.length >= 3 && x.slice(0, 3) === y.slice(0, 3));
}

export function firstName(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const t = parts.find((p) => !/^(dr|mr|mrs|ms|prof)\.?$/i.test(p));
  return t ?? '';
}

/* ---------------- facts ---------------- */

export function claimSource(claim: ResearchClaim, dossier: Dossier): string {
  const src = claim.sourceIds.map((sid) => dossier.sources.find((s) => s.id === sid)).find(Boolean);
  const publisher = src?.publisher ?? src?.title ?? (src ? safeHost(src.url) : 'unknown');
  const date = claim.date ?? src?.date ?? 'undated';
  return `${publisher}, ${date}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Research claims as draft facts (C1, C2, …). */
export function claimFacts(dossier: Dossier): Map<string, DraftFact> {
  const m = new Map<string, DraftFact>();
  for (const c of dossier.claims) {
    m.set(c.id, { id: c.id, text: c.text, ...(c.quote ? { quote: c.quote } : {}), category: c.category, source: claimSource(c, dossier) });
  }
  return m;
}

/** Without research: the account's own CRM text as N1, N2, … marked unverified. */
export function crmFacts(a: Account): Map<string, DraftFact> {
  const notes: string[] = [];
  const push = (label: string, v: string | undefined) => {
    const t = v?.replace(/\s+/g, ' ').trim();
    if (t) notes.push(`${label}: ${t.length > 600 ? t.slice(0, 600) + '…' : t}`);
  };
  push('Description', a.description);
  push('Signal', a.signal ?? a.signalSummary);
  push('Why fit', a.whyFit);
  push('Service signal', a.serviceSignal);
  push('Key signals', a.keySignals);
  if (a.services?.length) push('Services', a.services.join(', '));
  const m = new Map<string, DraftFact>();
  notes.forEach((text, i) => m.set(`N${i + 1}`, { id: `N${i + 1}`, text, source: 'unverified CRM notes' }));
  return m;
}

/* ---------------- prompt ---------------- */

const VERT_ONE_LINER =
  'Vert is AI software that automates reconciliation, cash coding and month-end close for accounting firms and in-house finance teams ("4 hours of manual reconciliations in 5 minutes; $100 of billable work for $2–4"; traceable, doesn\'t guess). The sender is Dawoud, the founder (dawoud@vertfinance.tech).';

/** Copied from the "Voice reference" section of .claude/skills/prospect-research/SKILL.md. */
const VOICE_EXAMPLES = [
  "Hi Shannon, Most accounting firms are stuck between burning hours reconciling by hand, or using AI that auto-codes without a trustworthy audit trail. I built a tool that turns hours of manual reconciliation into minutes and $100 worth of billable outputs into $2-4. We are already piloting Xero Platinum Partners, I'd love to get to know more about your firm. Open to a 10 min walkthrough this week?",
  "Hi Bryn, Noticed HelloCFO is built around virtual and fractional CFO work, so reconciling is the part that slows down the advice clients pay for. I've spent the past year asking finance leaders at Employment Hero, Startmate and Relevance why AI automation in accounting sticks or quietly fails. That became Vert, which helps firms reconcile and cash code 2x faster. How much of your CFO team's month goes on reconciling before the advisory work can start?",
];

export interface PromptInput {
  step: DraftStep;
  account: Account;
  contact: Contact;
  /** earlier emails to this contact, oldest first */
  previous: readonly { date: string; subject?: string }[];
  facts: ReadonlyMap<string, DraftFact>;
  researched: boolean;
}

const STEP_BRIEF: Record<DraftStep, string> = {
  first: 'a FIRST-TOUCH cold email',
  followUp: 'FOLLOW-UP 1: a short follow-up to the earlier email, with a new angle (a different fact or a concrete question)',
  followUp2: 'FOLLOW-UP 2: the final, shorter nudge with a third distinct angle',
};

export function buildDraftPrompt(p: PromptInput): string {
  const [lo, hi] = WORD_LIMITS[p.step];
  const a = p.account;
  const keyFields = [
    ['Company', a.name],
    ['Domain', a.domain],
    ['Location', [a.suburb, a.city, a.state].filter(Boolean).join(', ') || a.location],
    ['Segment', a.segment],
    ['Sector', a.sector],
    ['Employees', a.employees ?? a.employeeRange],
    ['Finance headcount', a.financeHeadcount != null ? String(a.financeHeadcount) : undefined],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const prev = p.previous.length
    ? p.previous.map((e) => `- ${e.date.slice(0, 10)}: "${e.subject ?? '(no subject)'}"`).join('\n')
    : '- none';
  const facts = [...p.facts.values()].map((f) => `${f.id}: ${f.text} [source: ${f.source}]`).join('\n');
  const lastSubject = [...p.previous].reverse().find((e) => e.subject)?.subject;
  const subjectRule =
    p.step === 'first'
      ? 'Subject: short and specific to this firm.'
      : lastSubject
        ? `Subject: exactly "${/^re:/i.test(lastSubject) ? lastSubject : 'Re: ' + lastSubject}".`
        : 'Subject: a fresh short subject.';
  return [
    `Write ${STEP_BRIEF[p.step]} from Dawoud to ${p.contact.name}${p.contact.title ? ` (${p.contact.title})` : ''} at ${a.name}.`,
    '',
    'ABOUT VERT',
    VERT_ONE_LINER,
    '',
    "DAWOUD'S VOICE — match the rhythm, plainness and length of these real emails, not their exact words. The second is the target: it opens with something specific to the firm.",
    ...VOICE_EXAMPLES.map((e) => `> ${e}`),
    '',
    'RECIPIENT',
    `- Name: ${p.contact.name}`,
    p.contact.title ? `- Title: ${p.contact.title}` : '- Title: unknown',
    '',
    'ACCOUNT',
    keyFields,
    '',
    'PREVIOUS EMAILS TO THIS PERSON',
    prev,
    '',
    p.researched ? 'FACTS (verified research claims — the ONLY facts you may use)' : 'FACTS (unverified CRM notes — the ONLY facts you may use; do not overstate them)',
    facts || '(none)',
    '',
    'RULES',
    '- Use ONLY the facts listed above; list every fact id you used in "claimIds". No invented numbers, clients or compliments. Vert\'s own numbers above are fine.',
    '- Reference at least 2 facts' + (p.researched ? ', at least one about the person or something they published or did.' : '.'),
    '- Specificity test: with the firm name deleted, the email must still obviously be about THIS firm.',
    `- ${lo}–${hi} words, excluding the sign-off. Plain text, short paragraphs. No links except the signature. No "I hope this finds you well", no "quick question", no emojis, no bullet lists.`,
    `- Address ${firstName(p.contact.name) || p.contact.name} by first name.`,
    p.step === 'first' ? '- End with one concrete, low-effort question.' : '- Reference the earlier email lightly ("Following up on my note last week…").',
    `- ${subjectRule}`,
    '- End the body with exactly these three lines:',
    SIGNOFF,
    '',
    'Reply with ONLY a JSON object: {"subject": string, "body": string, "claimIds": string[]} — body uses \\n for line breaks.',
  ].join('\n');
}

/** Checks the shape of a sample.json reply; returns null when unusable. */
export function parseDraftReply(v: unknown): DraftInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.subject !== 'string' || typeof r.body !== 'string' || !r.body.trim()) return null;
  const claimIds = Array.isArray(r.claimIds) ? r.claimIds.filter((x): x is string => typeof x === 'string') : [];
  return { subject: r.subject.trim(), body: normalizeBody(r.body).trim(), claimIds };
}
