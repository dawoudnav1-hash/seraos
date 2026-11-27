import type {
  ClaimCategory,
  Dossier,
  DraftEmail,
  ResearchClaim,
  ResearchData,
  ResearchNote,
  ResearchPerson,
  ResearchSearch,
  ResearchSource,
  ResearchSourceType,
  ResearchStatus,
} from '../types';
import { safeUrl } from './links';

/**
 * Defensive loader for src/data/research.json ({ [accountId]: Dossier }). Never throws: malformed
 * dossiers are skipped, claims citing unknown sources lose those citations (and are dropped when none
 * remain), and every claim reference elsewhere (hooks, risks, people, drafts) is filtered to known claims.
 */

export const SOURCE_TYPES: readonly ResearchSourceType[] = [
  'website', 'blog', 'podcast', 'video', 'linkedin', 'facebook', 'instagram', 'news', 'job', 'directory', 'registry', 'other',
];
export const CLAIM_CATEGORIES: readonly ClaimCategory[] = [
  'identity', 'firm', 'person', 'services', 'clients', 'growth', 'hiring', 'tech', 'content', 'news', 'pain', 'personal',
];
const STATUSES: readonly ResearchStatus[] = ['complete', 'identity_unconfirmed', 'thin'];

export const SOURCE_TYPE_LABEL: Record<ResearchSourceType, string> = {
  website: 'Website',
  blog: 'Blog',
  podcast: 'Podcast',
  video: 'Video',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  news: 'News',
  job: 'Job ad',
  directory: 'Directory',
  registry: 'Registry',
  other: 'Other',
};

export const CATEGORY_LABEL: Record<ClaimCategory, string> = {
  identity: 'Identity',
  firm: 'Firm',
  person: 'People',
  services: 'Services',
  clients: 'Clients',
  growth: 'Growth',
  hiring: 'Hiring',
  tech: 'Tech stack',
  content: 'Content they published',
  news: 'News',
  pain: 'Pain points',
  personal: 'Personal',
};

export const RESEARCH_STATUS_LABEL: Record<ResearchStatus, string> = {
  complete: 'Complete',
  thin: 'Thin',
  identity_unconfirmed: 'Identity unconfirmed',
};

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}
function objs(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
}

function normalizeDraft(raw: unknown, claimIds: ReadonlySet<string>): DraftEmail | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const contactId = str(r.contactId);
  const subject = str(r.subject);
  const body = typeof r.body === 'string' && r.body.trim() ? r.body.replace(/\r\n/g, '\n') : undefined;
  if (!contactId || !subject || !body) return null;
  return { contactId, subject, body, claimIds: strArr(r.claimIds).filter((id) => claimIds.has(id)) };
}

function normalizeNotes(raw: unknown, claimIds: ReadonlySet<string>): ResearchNote[] {
  const out: ResearchNote[] = [];
  for (const r of objs(raw)) {
    const text = str(r.text);
    if (text) out.push({ text, claimIds: strArr(r.claimIds).filter((id) => claimIds.has(id)) });
  }
  return out;
}

/** One dossier, or null when unusable. `stats` collects counts for warnings. */
export function normalizeDossier(raw: unknown, key: string, stats = { droppedClaims: 0 }): Dossier | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const sources: ResearchSource[] = [];
  const sourceIds = new Set<string>();
  for (const s of objs(r.sources)) {
    const id = str(s.id);
    const url = safeUrl(s.url);
    if (!id || !url || sourceIds.has(id) || !/^https?:/i.test(String(s.url).trim())) continue;
    sourceIds.add(id);
    const src: ResearchSource = {
      id,
      url,
      type: SOURCE_TYPES.includes(s.type as ResearchSourceType) ? (s.type as ResearchSourceType) : 'other',
    };
    const title = str(s.title);
    if (title) src.title = title;
    const publisher = str(s.publisher);
    if (publisher) src.publisher = publisher;
    src.date = str(s.date) ?? null;
    sources.push(src);
  }

  const claims: ResearchClaim[] = [];
  const claimIds = new Set<string>();
  for (const c of objs(r.claims)) {
    const id = str(c.id);
    const text = str(c.text);
    const sids = strArr(c.sourceIds).filter((sid) => sourceIds.has(sid));
    if (!id || !text || claimIds.has(id) || !sids.length) {
      stats.droppedClaims++;
      continue;
    }
    claimIds.add(id);
    const claim: ResearchClaim = {
      id,
      text,
      sourceIds: [...new Set(sids)],
      category: CLAIM_CATEGORIES.includes(c.category as ClaimCategory) ? (c.category as ClaimCategory) : 'firm',
      confidence: c.confidence === 'high' ? 'high' : 'medium',
      date: str(c.date) ?? null,
    };
    const quote = str(c.quote);
    if (quote) claim.quote = quote;
    claims.push(claim);
  }

  const people: ResearchPerson[] = [];
  for (const p of objs(r.people)) {
    const name = str(p.name);
    if (!name) continue;
    const person: ResearchPerson = { name, claimIds: strArr(p.claimIds).filter((id) => claimIds.has(id)) };
    const title = str(p.title);
    if (title) person.title = title;
    person.contactId = str(p.contactId) ?? null;
    person.linkedin = safeUrl(p.linkedin) ?? null;
    people.push(person);
  }

  const searches: ResearchSearch[] = [];
  for (const s of objs(r.searches)) {
    const query = str(s.query);
    if (!query) continue;
    const n = typeof s.results === 'number' && Number.isFinite(s.results) ? Math.max(0, Math.round(s.results)) : 0;
    searches.push({ query, results: n });
  }

  const status: ResearchStatus = STATUSES.includes(r.status as ResearchStatus) ? (r.status as ResearchStatus) : 'thin';
  const d = (r.drafts && typeof r.drafts === 'object' ? r.drafts : {}) as Record<string, unknown>;
  const noDrafts = status === 'identity_unconfirmed';
  const dossier: Dossier = {
    accountId: key,
    status,
    sources,
    claims,
    people,
    hooks: normalizeNotes(r.hooks, claimIds),
    risks: normalizeNotes(r.risks, claimIds),
    gaps: strArr(r.gaps),
    searches,
    drafts: {
      first: noDrafts ? null : normalizeDraft(d.first, claimIds),
      followUp: noDrafts ? null : normalizeDraft(d.followUp, claimIds),
      followUp2: noDrafts ? null : normalizeDraft(d.followUp2, claimIds),
    },
  };
  const accountName = str(r.accountName);
  if (accountName) dossier.accountName = accountName;
  const researchedAt = str(r.researchedAt);
  if (researchedAt) dossier.researchedAt = researchedAt;
  const summary = str(r.summary);
  if (summary) dossier.summary = summary;
  return dossier;
}

/**
 * Normalises the whole research.json. `knownAccountIds`, when given, drops dossiers for accounts that
 * are not in accounts.json (with a warning).
 */
export function normalizeResearch(raw: unknown, knownAccountIds?: ReadonlySet<string>): { research: ResearchData; warnings: string[] } {
  const warnings: string[] = [];
  const research: ResearchData = {};
  if (raw === undefined) return { research, warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('research.json is not an object keyed by account id — no research loaded.');
    return { research, warnings };
  }
  const stats = { droppedClaims: 0 };
  let invalid = 0,
    unknown = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) {
      invalid++;
      continue;
    }
    if (knownAccountIds && !knownAccountIds.has(key)) {
      unknown++;
      continue;
    }
    const d = normalizeDossier(value, key, stats);
    if (d) research[key] = d;
    else invalid++;
  }
  if (invalid) warnings.push(`${invalid} malformed research dossier(s) ignored.`);
  if (unknown) warnings.push(`${unknown} research dossier(s) for unknown accounts ignored.`);
  if (stats.droppedClaims) warnings.push(`${stats.droppedClaims} research claim(s) without a valid source ignored.`);
  return { research, warnings };
}

/** Claims of a dossier by id. */
export function claimMap(d: Dossier | undefined): Map<string, ResearchClaim> {
  return new Map((d?.claims ?? []).map((c) => [c.id, c]));
}

/** 1-based citation numbers for sources, in the dossier's source order. */
export function sourceNumbers(d: Dossier): Map<string, number> {
  return new Map(d.sources.map((s, i) => [s.id, i + 1]));
}
