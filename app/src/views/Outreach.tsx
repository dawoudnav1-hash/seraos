import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useModal } from '../components/dialog';
import { ResearchPanel } from '../components/ResearchPanel';
import { Badge, EmailLink, EmptyState, GradeFilter, GradePill, Icon, Segmented, Select } from '../components/ui';
import { MAIL_SERVER, errorCode, getMcp, getSample, mcpErrorInfo, sampleErrorInfo, type McpApi, type McpCallResult, type SampleApi } from '../lib/claude';
import { copyText } from '../lib/csv';
import { buildDraftPrompt, claimFacts, crmFacts, parseDraftReply, validateDraft, type DraftFact } from '../lib/drafting';
import { eventTime } from '../lib/events';
import {
  SECTIONS,
  cityOptions,
  locationSelectOptions,
  stateOptions,
  validGrades,
  visibleSections,
  withState,
  type Section,
} from '../lib/filters';
import { formatDate, relativeTime } from '../lib/format';
import {
  DEFAULT_SEQUENCE,
  DRAFTS_KEY,
  GAP_OPTIONS,
  SENDER_ADDRESS,
  STEP_LABEL,
  buildFirstTouchQueue,
  buildFollowUpQueue,
  contactBlockReason,
  draftKey,
  filterQueue,
  isoDay,
  pickMailbox,
  previewLine,
  replyTarget,
  researchDraftFor,
  resolveDraft,
  searchResults,
  sortQueue,
  upNextItems,
  validateDraftStore,
  type DraftStore,
  type FoundMessage,
  type QueueFilter,
  type QueueItem,
  type QueueKind,
  type ResolvedDraft,
  type SequenceSettings,
} from '../lib/outreach';
import { sourceNumbers } from '../lib/research';
import { TYPE_LABEL } from '../lib/stats';
import { contactActivity } from '../lib/status';
import { readJSON, writeJSON } from '../lib/storage';
import { useAppData } from '../state/AppData';
import { accountHref, replaceHash, type Route } from '../state/router';
import { usePersistentState } from '../state/usePersistentState';
import type { Account, Contact, Dossier } from '../types';

const SECTION_LABEL: Record<Section, string> = { firm: TYPE_LABEL.firm, internal: TYPE_LABEL.internal, solo: TYPE_LABEL.solo, services: TYPE_LABEL.services, all: 'All' };

interface ViewFilters extends QueueFilter {
  queue: QueueKind;
}
const DEFAULT_FILTERS: ViewFilters = { queue: 'followUp', section: 'all', city: '', state: '', grades: [] };

function validateFilters(v: unknown): ViewFilters | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<ViewFilters>;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    queue: r.queue === 'first' ? 'first' : 'followUp',
    section: SECTIONS.includes(r.section as Section) ? (r.section as Section) : 'all',
    city: s(r.city),
    state: s(r.state),
    grades: validGrades(r.grades),
  };
}
function validateSequence(v: unknown): SequenceSettings | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<SequenceSettings>;
  const ok = (n: unknown): n is number => typeof n === 'number' && GAP_OPTIONS.includes(n);
  return { gap1: ok(r.gap1) ? r.gap1 : DEFAULT_SEQUENCE.gap1, gap2: ok(r.gap2) ? r.gap2 : DEFAULT_SEQUENCE.gap2 };
}

/** The tool result's JSON: `payload`, else the first text block parsed. */
function payloadOf(r: McpCallResult | undefined): unknown {
  if (!r) return undefined;
  if (r.payload !== undefined) return r.payload;
  if (r.structuredContent !== undefined) return r.structuredContent;
  const t = (r.content ?? []).find((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text');
  if (!t) return undefined;
  try {
    return JSON.parse(t.text);
  } catch {
    return t.text;
  }
}

/** ⚠ lines of an account's research flags. */
function warnFlags(a: Account): string[] {
  return (a.flags ?? '')
    .split(/\r?\n|(?=⚠)/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('⚠'));
}

function factsFor(item: QueueItem): { facts: Map<string, DraftFact>; researched: boolean } {
  return item.dossier && item.dossier.claims.length ? { facts: claimFacts(item.dossier), researched: true } : { facts: crmFacts(item.account), researched: false };
}

function draftIssues(item: QueueItem, contact: Contact, d: Pick<ResolvedDraft, 'subject' | 'body' | 'claimIds'>): string[] {
  const { facts, researched } = factsFor(item);
  return validateDraft(d, { step: item.step, facts, researched, contact });
}

function OriginChip({ item, draft }: { item: QueueItem; draft: ResolvedDraft | null }) {
  if (draft?.origin === 'research')
    return (
      <Badge tone="ok" title="Drafted by the prospect-research skill from cited claims">
        Ready (researched)
      </Badge>
    );
  if (draft?.origin === 'claude-research') return <Badge tone="ok" title="Drafted by Claude on this page from the dossier's cited claims">Ready (researched)</Badge>;
  return (
    <>
      <Badge tone="caution" title={item.dossier ? 'The dossier has no draft for this step' : 'No research dossier for this account yet'}>
        Needs research
      </Badge>
      {draft?.origin === 'claude-crm' && <Badge title="Drafted from CRM notes — not researched">CRM draft</Badge>}
    </>
  );
}

/* ---------------------------------------------------------------- queue row */

function QueueRow({
  item,
  draft,
  selected,
  onSelect,
  onResearch,
}: {
  item: QueueItem;
  draft: ResolvedDraft | null;
  selected: boolean;
  onSelect: (i: QueueItem) => void;
  onResearch: (i: QueueItem) => void;
}) {
  const a = item.account;
  const last = item.sends[item.sends.length - 1];
  return (
    <li className={'q-row' + (selected ? ' selected' : '')} data-testid="queue-row" data-account-id={a.id} data-contact-id={item.contact.id} data-step={item.step}>
      <button type="button" className="q-row-main" onClick={() => onSelect(item)} aria-current={selected ? 'true' : undefined}>
        <span className="q-row-top">
          <GradePill grade={a.grade} rating={a.rating} />
          <span className="q-name">{a.name}</span>
        </span>
        <span className="q-who">
          {item.contact.name}
          {item.contact.title && <span className="muted"> · {item.contact.title}</span>}
        </span>
        <span className="q-meta">
          <span className={`step-chip step-${item.step}`}>{STEP_LABEL[item.step]}</span>
          {last && <span className="muted small">last email {relativeTime(eventTime(last))}</span>}
          <OriginChip item={item} draft={draft} />
        </span>
        {draft ? (
          <span className="q-draft">
            <b>{draft.subject}</b> <span className="muted">— {previewLine(draft.body)}</span>
          </span>
        ) : (
          <span className="q-draft muted">No draft yet{item.dossier ? '' : ' — opens with a CRM-notes draft when Claude is available'}</span>
        )}
      </button>
      {item.dossier && (
        <button type="button" className="btn btn-sm btn-research" onClick={() => onResearch(item)} data-testid="row-research" aria-label={`Research for ${a.name}`}>
          <Icon name="search" size={12} /> Research
        </button>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- facts used */

function FactsUsed({ ids, item }: { ids: readonly string[]; item: QueueItem }) {
  const { facts } = factsFor(item);
  const d = item.dossier;
  const numbers = d ? sourceNumbers(d) : new Map<string, number>();
  if (!ids.length) return <p className="muted small">No facts listed for this draft.</p>;
  return (
    <ul className="facts" data-testid="facts-used">
      {ids.map((id) => {
        const f = facts.get(id);
        const claim = d?.claims.find((c) => c.id === id);
        return (
          <li key={id} className={'fact-chip' + (f ? '' : ' unknown')} data-testid="fact-chip">
            <span className="claim-id">{id}</span>
            <span>{f ? f.text : 'Unknown fact id'}</span>
            {claim && d && (
              <sup className="fact-sources">
                {claim.sourceIds.map((sid) => {
                  const src = d.sources.find((s) => s.id === sid);
                  const n = numbers.get(sid);
                  return src && n != null ? (
                    <a key={sid} href={src.url} target="_blank" rel="noopener noreferrer" title={src.title ?? src.url}>
                      {n}
                    </a>
                  ) : null;
                })}
              </sup>
            )}
            {!claim && f && <span className="muted small"> (unverified CRM note)</span>}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- send dialog */

interface SendRequest {
  item: QueueItem;
  contact: Contact;
  draft: ResolvedDraft;
  warnings: string[];
}

function SendDialog({
  req,
  busy,
  error,
  ambiguous,
  onSend,
  onClose,
}: {
  req: SendRequest;
  busy: boolean;
  error: string | null;
  ambiguous: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModal(ref, true, () => !busy && onClose(), cancelRef);
  const replyTo = req.item.queue === 'followUp' ? replyTarget(req.item.sends) : null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal send-modal" role="dialog" aria-modal="true" aria-labelledby="send-title" ref={ref} data-testid="send-dialog">
        <h2 id="send-title">Review &amp; send</h2>
        <dl className="send-head">
          <dt>From</dt>
          <dd>Dawoud &lt;{SENDER_ADDRESS}&gt;</dd>
          <dt>To</dt>
          <dd>
            {req.contact.name} &lt;{req.contact.email}&gt;
          </dd>
          <dt>Subject</dt>
          <dd>{req.draft.subject || <span className="muted">(empty)</span>}</dd>
          {replyTo && (
            <>
              <dt>Thread</dt>
              <dd className="muted">Sent as a reply to the earlier email (Sent folder uid {replyTo.uid})</dd>
            </>
          )}
        </dl>
        {req.warnings.length > 0 && (
          <div className="note note-warn send-warnings" role="alert" data-testid="send-warnings">
            <b>
              {req.warnings.length} warning{req.warnings.length === 1 ? '' : 's'} — read before sending
            </b>
            <ul>
              {req.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <pre className="send-body">{req.draft.body}</pre>
        {error && (
          <div className={'note ' + (ambiguous ? 'note-warn' : 'note-error')} role="alert" data-testid="send-error">
            <Icon name="alert" size={12} /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSend} disabled={busy} data-testid="send-confirm">
            <Icon name="send" /> {busy ? 'Sending…' : ambiguous ? 'Send again anyway' : 'Send email'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- composer */

interface Thinking {
  key: string;
  controller: AbortController;
  auto: boolean;
}

function Composer({
  item,
  contact,
  onContact,
  draft,
  onEdit,
  onReset,
  sample,
  sampleNote,
  thinking,
  draftError,
  onDraft,
  onStop,
  mcp,
  replies,
  checking,
  onCheckReplies,
  onReview,
  onCopy,
  onResearch,
}: {
  item: QueueItem;
  contact: Contact;
  onContact: (id: string) => void;
  draft: ResolvedDraft | null;
  onEdit: (patch: Partial<Pick<ResolvedDraft, 'subject' | 'body'>>) => void;
  onReset: () => void;
  sample: SampleApi | null;
  sampleNote: string | null;
  thinking: Thinking | null;
  draftError: { message: string; retry: boolean } | null;
  onDraft: (redraft: boolean) => void;
  onStop: () => void;
  mcp: McpApi | null;
  replies: { found: FoundMessage[]; at: number; error?: string } | undefined;
  checking: boolean;
  onCheckReplies: () => void;
  onReview: () => void;
  onCopy: () => void;
  onResearch: () => void;
}) {
  const { index } = useAppData();
  const a = item.account;
  const issues = draft ? draftIssues(item, contact, draft) : [];
  const researchDraft = researchDraftFor(item, contact.id);
  const isThinking = !!thinking && thinking.key === draftKey(item.step, contact.id);
  const blocked = contactBlockReason(contact, contactActivity(index, contact.id));
  const originNote =
    draft?.origin === 'claude-crm'
      ? 'Drafted from CRM notes — not researched'
      : draft?.origin === 'claude-research'
        ? 'Drafted by Claude from the research claims'
        : draft?.origin === 'research'
          ? 'Research draft (prospect-research skill)'
          : draft
            ? 'Written by hand'
            : null;

  return (
    <section className="composer card" aria-label={`Draft for ${contact.name}`} data-testid="composer" data-account-id={a.id} data-contact-id={contact.id}>
      <header className="composer-head">
        <div>
          <div className="composer-title">
            <GradePill grade={a.grade} rating={a.rating} />
            <h2>{a.name}</h2>
            <span className={`step-chip step-${item.step}`}>{STEP_LABEL[item.step]}</span>
            <OriginChip item={item} draft={draft} />
          </div>
          <p className="sub">
            {[a.city, a.state].filter(Boolean).join(', ') || 'City unknown'} · {a.segment}
            {item.queue === 'followUp' && item.daysSince != null && ` · last email ${item.daysSince} days ago`}
          </p>
        </div>
        <div className="composer-actions">
          {item.dossier && (
            <button type="button" className="btn btn-research btn-primary-outline" onClick={onResearch} data-testid="composer-research">
              <Icon name="search" /> Research
            </button>
          )}
          <a className="btn btn-sm" href={accountHref(a.id, contact.id)}>
            <Icon name="link" /> Account
          </a>
        </div>
      </header>

      {item.sends.length > 0 && (
        <div className="prev-emails">
          <span className="muted small">Earlier emails:</span>
          <ul>
            {item.sends.map((e) => (
              <li key={e.id}>
                <span className="muted">{formatDate(eventTime(e))}</span> · {e.subject ?? <span className="muted">(no subject)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {replies && (replies.error || replies.found.length > 0) && (
        <div className="note note-warn" role="alert" data-testid="replies-warning">
          <Icon name="alert" size={12} />{' '}
          {replies.error ??
            `${replies.found.length} message${replies.found.length === 1 ? '' : 's'} from ${contact.email} since the last email — read ${replies.found.length === 1 ? 'it' : 'them'} before following up.`}
        </div>
      )}
      {replies && !replies.error && replies.found.length === 0 && (
        <p className="note note-ok" data-testid="replies-none">
          <Icon name="check" size={12} /> No reply from {contact.email} in the inbox since {formatDate(eventTime(item.sends[item.sends.length - 1] ?? { date: '' }))}.
        </p>
      )}

      {issues.length > 0 && (
        <div className="note note-warn draft-issues" role="status" data-testid="draft-warnings">
          <b>
            {issues.length} draft check{issues.length === 1 ? '' : 's'} failed
          </b>
          <ul>
            {issues.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="composer-fields">
        <label className="field-row">
          <span className="field-label">To</span>
          <span className="to-row">
            <select value={contact.id} onChange={(e) => onContact(e.target.value)} disabled={item.contacts.length < 2} data-testid="composer-to">
              {item.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.email}
                </option>
              ))}
            </select>
            {contact.emailRisk === 'caution' && (
              <Badge tone="caution" title={contact.emailStatus ?? 'Unconfirmed email'}>
                caution
              </Badge>
            )}
          </span>
        </label>
        <div className="to-meta muted small">
          <EmailLink email={contact.email} />
          {contact.title && ` · ${contact.title}`}
          {contact.emailStatus && ` · ${contact.emailStatus}`}
          {blocked && <span className="warn-text"> · {blocked}</span>}
        </div>
        <label className="field-row">
          <span className="field-label">Subject</span>
          <input type="text" value={draft?.subject ?? ''} onChange={(e) => onEdit({ subject: e.target.value })} placeholder="Subject" data-testid="composer-subject" />
        </label>
        <label className="field-row field-body">
          <span className="field-label">Body</span>
          <textarea
            value={draft?.body ?? ''}
            onChange={(e) => onEdit({ body: e.target.value })}
            rows={13}
            placeholder={isThinking ? 'Claude is drafting…' : 'Write the email, or draft it with Claude.'}
            data-testid="composer-body"
            spellCheck
          />
        </label>
        {originNote && (
          <div className={'muted small origin-note' + (draft?.origin === 'claude-crm' ? ' warn-text' : '')} data-testid="draft-origin">
            {originNote}
            {draft?.edited && ' · edited'}
          </div>
        )}
      </div>

      {!item.dossier && !draft && (
        <p className="note" data-testid="no-research">
          <Icon name="alert" size={12} /> No research yet — run the prospect-research skill for this account.
        </p>
      )}

      <div className="facts-wrap">
        <h3>Facts used</h3>
        <FactsUsed ids={draft?.claimIds ?? []} item={item} />
      </div>

      {draftError && (
        <p className="note note-warn" role="alert">
          <Icon name="alert" size={12} /> {draftError.message}
          {draftError.retry && sample && (
            <button type="button" className="btn btn-sm" onClick={() => onDraft(true)}>
              Try again
            </button>
          )}
        </p>
      )}

      <div className="composer-foot">
        <div className="composer-foot-left">
          {sample ? (
            isThinking ? (
              <>
                <span className="thinking" role="status">
                  <span className="spinner" aria-hidden="true" /> Thinking…
                </span>
                <button type="button" className="btn btn-sm" onClick={onStop} data-testid="draft-stop">
                  Stop
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => onDraft(!!draft)} disabled={!!thinking} data-testid="draft-claude">
                {draft ? 'Redraft' : 'Draft with Claude'}
              </button>
            )
          ) : (
            <span className="muted small" data-testid="sample-note">
              {sampleNote ?? 'Drafting with Claude works on the hosted page.'}
            </span>
          )}
          {researchDraft && draft?.origin !== 'research' && (
            <button type="button" className="btn btn-ghost" onClick={onReset} data-testid="reset-draft">
              Reset to research draft
            </button>
          )}
          {researchDraft && draft?.origin === 'research' && draft.edited && (
            <button type="button" className="btn btn-ghost" onClick={onReset} data-testid="reset-draft">
              Reset to research draft
            </button>
          )}
        </div>
        <div className="composer-foot-right">
          {mcp && item.queue === 'followUp' && (
            <button type="button" className="btn" onClick={onCheckReplies} disabled={checking} data-testid="check-replies">
              <Icon name="reply" /> {checking ? 'Checking…' : 'Check for replies'}
            </button>
          )}
          {mcp ? (
            <button type="button" className="btn btn-primary" onClick={onReview} disabled={!draft || !!blocked} data-testid="review-send">
              <Icon name="send" /> Review &amp; send
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onCopy} disabled={!draft} data-testid="copy-email">
              Copy email
            </button>
          )}
        </div>
      </div>
      {!mcp && (
        <p className="muted small send-note" data-testid="send-note">
          Sending works on the hosted page with the {MAIL_SERVER} connector connected. Here, copy the email and send it from your mail app, then log it on the account.
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- up next */

function UpNext({
  items,
  pos,
  onPos,
  drafts,
  mcp,
  onOpen,
  onResearch,
  onReview,
  onCopy,
}: {
  items: QueueItem[];
  pos: number;
  onPos: (n: number) => void;
  drafts: DraftStore;
  mcp: McpApi | null;
  onOpen: (i: QueueItem) => void;
  onResearch: (i: QueueItem) => void;
  onReview: (i: QueueItem, c: Contact, d: ResolvedDraft) => void;
  onCopy: (i: QueueItem, c: Contact, d: ResolvedDraft) => void;
}) {
  const { index } = useAppData();
  if (!items.length) {
    return (
      <section className="card up-next" data-testid="up-next">
        <div className="up-next-head">
          <h2>Up next</h2>
        </div>
        <p className="muted">Nothing due with the current filters.</p>
      </section>
    );
  }
  const i = Math.min(pos, items.length - 1);
  const item = items[i]!;
  const draft = resolveDraft(item, item.contact.id, drafts);
  const issues = draft ? draftIssues(item, item.contact, draft) : [];
  const blocked = contactBlockReason(item.contact, contactActivity(index, item.contact.id));
  return (
    <section className="card up-next" data-testid="up-next" aria-label="Up next">
      <div className="up-next-head">
        <h2>Up next</h2>
        <span className="muted small" data-testid="up-next-pos">
          {i + 1} of {items.length}
        </span>
        <div className="toolbar-spacer" />
        <button type="button" className="btn btn-sm" onClick={() => onPos(Math.max(0, i - 1))} disabled={i === 0} data-testid="up-next-prev">
          ‹ Prev
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onPos(Math.min(items.length - 1, i + 1))} disabled={i >= items.length - 1} data-testid="up-next-next">
          Next ›
        </button>
      </div>
      <div className="up-next-body" data-testid="up-next-item" data-account-id={item.account.id}>
        <div className="up-next-who">
          <GradePill grade={item.account.grade} rating={item.account.rating} />
          <b>{item.account.name}</b>
          <span className="muted">
            {item.contact.name}
            {item.contact.title && ` · ${item.contact.title}`}
          </span>
          <span className={`step-chip step-${item.step}`}>{STEP_LABEL[item.step]}</span>
          {item.queue === 'followUp' && item.daysSince != null && <span className="muted small">{item.daysSince}d since last email</span>}
          <OriginChip item={item} draft={draft} />
          {issues.length > 0 && <Badge tone="warn">{issues.length} check{issues.length === 1 ? '' : 's'} failed</Badge>}
        </div>
        {draft ? (
          <div className="up-next-draft">
            <div className="up-next-subject">{draft.subject}</div>
            <div className="up-next-text">{draft.body.replace(/\n{2,}/g, '\n')}</div>
          </div>
        ) : (
          <p className="muted">No draft yet — open it to draft{item.dossier ? '' : ' from CRM notes'}.</p>
        )}
      </div>
      <div className="up-next-actions">
        {item.dossier && (
          <button type="button" className="btn btn-research" onClick={() => onResearch(item)} data-testid="up-next-research">
            <Icon name="search" /> Research
          </button>
        )}
        <button type="button" className="btn" onClick={() => onOpen(item)} data-testid="up-next-open">
          Edit draft
        </button>
        {draft &&
          (mcp ? (
            <button type="button" className="btn btn-primary" onClick={() => onReview(item, item.contact, draft)} disabled={!!blocked}>
              <Icon name="send" /> Review &amp; send
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => onCopy(item, item.contact, draft)} data-testid="up-next-copy">
              Copy email
            </button>
          ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- view */

export function Outreach({ route }: { route: Route }) {
  const { accounts, index, research, addManualEvent, toast } = useAppData();
  const [filters, setFilters] = usePersistentState<ViewFilters>('seraos.outreach.filters.v1', DEFAULT_FILTERS, validateFilters);
  const [seq, setSeq] = usePersistentState<SequenceSettings>('seraos.outreach.sequence.v1', DEFAULT_SEQUENCE, validateSequence);
  const [now] = useState(() => Date.now());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [contactFor, setContactFor] = useState<Record<string, string>>({});
  const [researchFor, setResearchFor] = useState<{ dossier: Dossier; name: string } | null>(null);
  const [upPos, setUpPos] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  // Drafts the owner edits (or Claude wrote) persist per contact and step.
  const [drafts, setDrafts] = useState<DraftStore>(() => validateDraftStore(readJSON<unknown>(DRAFTS_KEY, {})));
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    writeJSON(DRAFTS_KEY, drafts);
  }, [drafts]);

  // Capabilities: resolved once; null = not on the hosted page (or not granted).
  const [sample, setSample] = useState<SampleApi | null>(null);
  const [sampleNote, setSampleNote] = useState<string | null>(null);
  const [mcp, setMcp] = useState<McpApi | null>(null);
  useEffect(() => {
    let live = true;
    void getSample().then((s) => live && setSample(s));
    void getMcp().then((m) => live && setMcp(m));
    return () => {
      live = false;
    };
  }, []);

  const followAll = useMemo(() => buildFollowUpQueue(accounts, index, research, { now, ...seq }), [accounts, index, research, now, seq]);
  const firstAll = useMemo(() => buildFirstTouchQueue(accounts, index, research), [accounts, index, research]);
  const followUps = useMemo(() => sortQueue(filterQueue(followAll, filters)), [followAll, filters]);
  const firsts = useMemo(() => sortQueue(filterQueue(firstAll, filters)), [firstAll, filters]);
  const upNext = useMemo(() => upNextItems(followUps, firsts), [followUps, firsts]);
  const rows = filters.queue === 'followUp' ? followUps : firsts;
  const sectionCounts = useMemo(() => {
    const base = filters.queue === 'followUp' ? followAll : firstAll;
    const scoped = filterQueue(base, { ...filters, section: 'all' });
    const out: Record<Section, number> = { all: scoped.length, firm: 0, services: 0, internal: 0, solo: 0 };
    for (const i of scoped) out[i.account.type]++;
    return out;
  }, [filters, followAll, firstAll]);

  const allItems = useMemo(() => [...followAll, ...firstAll], [followAll, firstAll]);
  const selected = useMemo(() => allItems.find((i) => i.key === selectedKey) ?? null, [allItems, selectedKey]);
  const contactOf = (item: QueueItem): Contact => item.contacts.find((c) => c.id === contactFor[item.key]) ?? item.contact;
  const selContact = selected ? contactOf(selected) : null;
  const selDraft = selected && selContact ? resolveDraft(selected, selContact.id, drafts) : null;

  const select = useCallback((item: QueueItem) => {
    setSelectedKey(item.key);
    setSentNote(null);
    replaceHash(`#/outreach/${encodeURIComponent(item.account.id)}`);
  }, []);

  // Deep link #/outreach/<accountId>: open that account's row (follow-up first), switching queue / clearing filters.
  useEffect(() => {
    const id = route.accountId;
    if (!id) return;
    const inFollow = followAll.find((i) => i.account.id === id);
    const target = inFollow ?? firstAll.find((i) => i.account.id === id);
    if (!target) {
      const known = accounts.some((a) => a.id === id);
      setNotice(known ? `${accounts.find((a) => a.id === id)?.name ?? id} is not in either queue (already contacted and not due, or nobody emailable).` : `Account “${id}” was not found.`);
      const d = research[id];
      if (d) setResearchFor({ dossier: d, name: accounts.find((a) => a.id === id)?.name ?? id });
      return;
    }
    const q: QueueKind = inFollow ? 'followUp' : 'first';
    const visible = filterQueue([target], filters).length > 0;
    setFilters((f) => (visible ? { ...f, queue: q } : { ...DEFAULT_FILTERS, queue: q }));
    setNotice(visible ? null : 'Filters were cleared to show the linked account.');
    setSelectedKey(target.key);
    // Keyed on the route only (like the Accounts deep link).
  }, [route.nonce, route.accountId]);

  /* ---- drafting with Claude ---- */
  const [thinking, setThinking] = useState<Thinking | null>(null);
  const thinkingRef = useRef<Thinking | null>(null);
  const [draftErrors, setDraftErrors] = useState<Record<string, { message: string; retry: boolean }>>({});
  const autoTried = useRef(new Set<string>());

  const stopDrafting = useCallback(() => {
    thinkingRef.current?.controller.abort();
  }, []);

  const runDraft = useCallback(
    async (item: QueueItem, contact: Contact, opts: { auto: boolean; redraft: boolean }) => {
      if (!sample) return;
      thinkingRef.current?.controller.abort(); // never more than one in flight
      const key = draftKey(item.step, contact.id);
      const controller = new AbortController();
      const t: Thinking = { key, controller, auto: opts.auto };
      thinkingRef.current = t;
      setThinking(t);
      setDraftErrors((m) => {
        const { [key]: _drop, ...rest } = m;
        return rest;
      });
      const { facts, researched } = factsFor(item);
      const prompt = buildDraftPrompt({ step: item.step, account: item.account, contact, previous: item.sends, facts, researched });
      try {
        const reply = await sample.json<unknown>(prompt, { modelTier: 'default', signal: controller.signal, ...(opts.redraft ? { cache: false } : {}) });
        const d = parseDraftReply(reply);
        if (!d) throw { code: 'invalid_json', message: 'Reply did not have subject, body and claimIds.' };
        setDrafts((s) => ({
          ...s,
          [key]: { ...d, claimIds: d.claimIds, origin: researched ? 'claude-research' : 'claude-crm', edited: false, updatedAt: new Date().toISOString() },
        }));
      } catch (e) {
        const info = sampleErrorInfo(e);
        if (info.hide) {
          setSample(null);
          setSampleNote(info.message);
        } else if (info.message) {
          setDraftErrors((m) => ({ ...m, [key]: { message: info.message, retry: info.retry } }));
        }
        if (errorCode(e) === 'cancelled' && opts.auto) autoTried.current.delete(key); // may auto-draft again when reopened
      } finally {
        if (thinkingRef.current === t) {
          thinkingRef.current = null;
          setThinking(null);
        }
      }
    },
    [sample],
  );

  // Auto-draft once per contact + step when a row without a ready draft is opened (never on load, never in a loop).
  const selDraftKey = selected && selContact ? draftKey(selected.step, selContact.id) : null;
  useEffect(() => {
    if (!sample || !selected || !selContact || !selDraftKey) return;
    if (selDraft || autoTried.current.has(selDraftKey)) return;
    autoTried.current.add(selDraftKey);
    void runDraft(selected, selContact, { auto: true, redraft: false });
  }, [sample, selDraftKey]);
  // Switching rows stops an automatic draft for the previous row.
  useEffect(() => {
    const t = thinkingRef.current;
    if (t && t.auto && t.key !== selDraftKey) t.controller.abort();
  }, [selDraftKey]);
  useEffect(() => () => thinkingRef.current?.controller.abort(), []);

  const editDraft = (item: QueueItem, contact: Contact, patch: Partial<Pick<ResolvedDraft, 'subject' | 'body'>>) => {
    const key = draftKey(item.step, contact.id);
    setDrafts((s) => {
      const cur = s[key] ?? resolveDraft(item, contact.id, s) ?? { subject: '', body: '', claimIds: [], origin: 'manual' as const, edited: false };
      return { ...s, [key]: { subject: cur.subject, body: cur.body, claimIds: cur.claimIds, origin: cur.origin, ...patch, edited: true, updatedAt: new Date().toISOString() } };
    });
  };
  const resetDraft = (item: QueueItem, contact: Contact) => {
    const key = draftKey(item.step, contact.id);
    setDrafts((s) => {
      const { [key]: _drop, ...rest } = s;
      return rest;
    });
  };

  /* ---- Hostinger Mail ---- */
  const mailbox = useRef<string | null>(null);
  const [sendReq, setSendReq] = useState<SendRequest | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<{ message: string; ambiguous: boolean } | null>(null);
  const [replies, setReplies] = useState<Record<string, { found: FoundMessage[]; at: number; error?: string }>>({});
  const [checking, setChecking] = useState(false);

  const getMailbox = async (api: McpApi): Promise<string> => {
    if (mailbox.current) return mailbox.current;
    const res = await api.callTool(MAIL_SERVER, 'account_current', {});
    const box = pickMailbox(payloadOf(res));
    if (!box) throw { code: 'tool_error', message: 'account_current returned no mailbox.' };
    mailbox.current = box.resourceId;
    return box.resourceId;
  };

  const checkReplies = async (item: QueueItem, contact: Contact) => {
    if (!mcp || checking) return;
    const last = item.sends[item.sends.length - 1];
    const t = last ? eventTime(last) : null;
    setChecking(true);
    try {
      const box = await getMailbox(mcp);
      const res = await mcp.callTool(MAIL_SERVER, 'messages_search', { mailboxResourceId: box, folder: 'INBOX', from: contact.email, ...(t != null ? { since: isoDay(t) } : {}) });
      setReplies((r) => ({ ...r, [item.key]: { found: searchResults(payloadOf(res)), at: Date.now() } }));
    } catch (e) {
      setReplies((r) => ({ ...r, [item.key]: { found: [], at: Date.now(), error: mcpErrorInfo(e, false).message } }));
    } finally {
      setChecking(false);
    }
  };

  const openReview = (item: QueueItem, contact: Contact, draft: ResolvedDraft) => {
    const warnings = [...draftIssues(item, contact, draft)];
    if (contact.emailRisk === 'caution') warnings.push(`Email address is unconfirmed${contact.emailStatus ? ` (${contact.emailStatus})` : ''}.`);
    const blocked = contactBlockReason(contact, contactActivity(index, contact.id));
    if (blocked) warnings.push(blocked + '.');
    for (const f of warnFlags(item.account)) warnings.push(`Account flag: ${f.replace(/^⚠️?\s*/, '')}`);
    const r = replies[item.key];
    if (r?.found.length) warnings.push(`${r.found.length} message(s) from ${contact.email} arrived since the last email.`);
    setSendError(null);
    setSendReq({ item, contact, draft, warnings: [...new Set(warnings)] });
  };

  const send = async () => {
    if (!mcp || !sendReq || sendingRef.current) return;
    const { item, contact, draft } = sendReq;
    if (!contact.email) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    let stage: 'mailbox' | 'send' = 'mailbox';
    try {
      const box = await getMailbox(mcp);
      stage = 'send';
      const inReplyTo = item.queue === 'followUp' ? replyTarget(item.sends) : null;
      await mcp.callTool(MAIL_SERVER, 'send_email', {
        mailboxResourceId: box,
        to: [contact.email],
        subject: draft.subject,
        text: draft.body,
        displayName: 'Dawoud',
        ...(inReplyTo ? { inReplyTo } : {}),
      });
      addManualEvent({
        kind: 'sent',
        channel: 'email',
        source: 'page-send',
        accountId: item.account.id,
        contactId: contact.id,
        counterpartyEmails: [contact.email],
        personName: contact.name,
        subject: draft.subject,
        snippet: draft.body.replace(/\s+/g, ' ').slice(0, 160),
      });
      resetDraft(item, contact);
      setSendReq(null);
      setSentNote(`Sent to ${contact.name} (${contact.email}).`);
      toast({ message: `Sent to ${contact.name}` });
    } catch (e) {
      const info = mcpErrorInfo(e, stage === 'send');
      setSendError({ message: info.message, ambiguous: info.ambiguous });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const copyEmail = async (_item: QueueItem, contact: Contact, draft: ResolvedDraft) => {
    const ok = await copyText(`To: ${contact.name} <${contact.email ?? ''}>\nSubject: ${draft.subject}\n\n${draft.body}`);
    toast(ok ? { message: `Copied the email to ${contact.name}.` } : { message: 'Could not copy to the clipboard.', tone: 'error' });
  };

  const openResearch = (item: QueueItem) => item.dossier && setResearchFor({ dossier: item.dossier, name: item.account.name });

  const cityOpts = useMemo(() => locationSelectOptions(cityOptions(accounts, undefined, filters.state), filters.city, 'All', 'Unknown'), [accounts, filters.state, filters.city]);
  const stateOpts = useMemo(() => locationSelectOptions(stateOptions(accounts), filters.state, 'All', 'No state'), [accounts, filters.state]);
  const nResearch = Object.keys(research).length;

  let composer: ReactNode;
  if (selected && selContact) {
    composer = (
      <Composer
        item={selected}
        contact={selContact}
        onContact={(id) => setContactFor((m) => ({ ...m, [selected.key]: id }))}
        draft={selDraft}
        onEdit={(p) => editDraft(selected, selContact, p)}
        onReset={() => resetDraft(selected, selContact)}
        sample={sample}
        sampleNote={sampleNote}
        thinking={thinking}
        draftError={selDraftKey ? (draftErrors[selDraftKey] ?? null) : null}
        onDraft={(redraft) => void runDraft(selected, selContact, { auto: false, redraft })}
        onStop={stopDrafting}
        mcp={mcp}
        replies={replies[selected.key]}
        checking={checking}
        onCheckReplies={() => void checkReplies(selected, selContact)}
        onReview={() => selDraft && openReview(selected, selContact, selDraft)}
        onCopy={() => selDraft && void copyEmail(selected, selContact, selDraft)}
        onResearch={() => openResearch(selected)}
      />
    );
  } else {
    composer = (
      <section className="composer card composer-empty" data-testid="composer-empty">
        {sentNote ? (
          <EmptyState title={sentNote}>It left the queue. Pick the next row, or use Up next.</EmptyState>
        ) : (
          <EmptyState title="Select a row to open its draft">Drafts are ready for researched accounts; others are drafted from CRM notes when Claude is available.</EmptyState>
        )}
      </section>
    );
  }

  return (
    <div className="page outreach">
      <div className="page-head">
        <div>
          <h1>Outreach</h1>
          <p className="page-sub">
            Follow-ups and first touches, best accounts first. {nResearch} account{nResearch === 1 ? ' has' : 's have'} a research dossier. Nothing is sent without your review.
          </p>
        </div>
        <div className="cap-status">
          <Badge tone={sample ? 'ok' : 'neutral'} title={sample ? 'Drafting with Claude is available' : (sampleNote ?? 'Available on the hosted page')}>
            Claude drafting {sample ? 'on' : 'off'}
          </Badge>
          <Badge tone={mcp ? 'ok' : 'neutral'} title={mcp ? `${MAIL_SERVER} connector available` : `Connect ${MAIL_SERVER} on the hosted page to send`}>
            {MAIL_SERVER} {mcp ? 'on' : 'off'}
          </Badge>
        </div>
      </div>

      <Segmented
        label="Account section"
        value={filters.section}
        onChange={(s) => setFilters((f) => ({ ...f, section: s }))}
        options={visibleSections(accounts).map((s) => ({ id: s, label: SECTION_LABEL[s], count: sectionCounts[s] }))}
        testIdPrefix="outreach-section"
      />

      <div className="toolbar">
        <Segmented
          label="Queue"
          value={filters.queue}
          onChange={(q) => setFilters((f) => ({ ...f, queue: q }))}
          options={[
            { id: 'followUp', label: 'Follow-ups due', count: followUps.length, title: 'Emailed contacts whose next follow-up is due, with no reply yet' },
            { id: 'first', label: 'First touch', count: firsts.length, title: 'Accounts never contacted that have an emailable contact' },
          ]}
          testIdPrefix="queue-tab"
        />
        <Select label="City" value={filters.city} onChange={(v) => setFilters((f) => ({ ...f, city: v }))} options={cityOpts} testId="outreach-city" />
        <Select label="State" value={filters.state} onChange={(v) => setFilters((f) => withState(f, v, accounts))} options={stateOpts} />
        <GradeFilter value={filters.grades} onChange={(v) => setFilters((f) => ({ ...f, grades: v }))} testIdPrefix="outreach-grade" />
        <Select
          label="Follow-up 1 after"
          value={String(seq.gap1)}
          onChange={(v) => setSeq((s) => ({ ...s, gap1: Number(v) }))}
          options={GAP_OPTIONS.map((n) => ({ value: String(n), label: `${n} days` }))}
          testId="gap1"
        />
        <Select
          label="Follow-up 2 after"
          value={String(seq.gap2)}
          onChange={(v) => setSeq((s) => ({ ...s, gap2: Number(v) }))}
          options={GAP_OPTIONS.map((n) => ({ value: String(n), label: `${n} days` }))}
          testId="gap2"
        />
        {(filters.city || filters.state || filters.grades.length > 0 || filters.section !== 'all') && (
          <button type="button" className="btn btn-ghost" onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, queue: f.queue }))}>
            <Icon name="x" size={12} /> Clear
          </button>
        )}
      </div>

      {notice && (
        <p className="note" role="status">
          <Icon name="alert" size={12} /> {notice}
          <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </p>
      )}

      <UpNext
        items={upNext}
        pos={upPos}
        onPos={setUpPos}
        drafts={drafts}
        mcp={mcp}
        onOpen={(i) => {
          setFilters((f) => ({ ...f, queue: i.queue }));
          select(i);
        }}
        onResearch={openResearch}
        onReview={openReview}
        onCopy={(i, c, d) => void copyEmail(i, c, d)}
      />

      <div className="outreach-layout">
        <div className="queue card" data-testid="queue">
          <div className="queue-head">
            <span className="result-count" data-testid="queue-count">
              {rows.length.toLocaleString('en-AU')} {filters.queue === 'followUp' ? 'follow-up' : 'account'}
              {rows.length === 1 ? '' : 's'}
            </span>
            <span className="muted small">grade, then research, then signal</span>
          </div>
          {rows.length ? (
            <ul className="q-list">
              {rows.map((item) => (
                <QueueRow
                  key={item.key}
                  item={item}
                  draft={resolveDraft(item, contactOf(item).id, drafts)}
                  selected={item.key === selectedKey}
                  onSelect={select}
                  onResearch={openResearch}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title={filters.queue === 'followUp' ? 'No follow-ups due' : 'No accounts to start'}>
              {filters.queue === 'followUp' ? `Nobody emailed ${seq.gap1}+ days ago is waiting on a follow-up with these filters.` : 'Every account in this section has been contacted or has nobody emailable.'}
            </EmptyState>
          )}
        </div>
        <div className="composer-col">{composer}</div>
      </div>

      {researchFor && <ResearchPanel dossier={researchFor.dossier} accountName={researchFor.name} onClose={() => setResearchFor(null)} />}
      {sendReq && (
        <SendDialog
          req={sendReq}
          busy={sending}
          error={sendError?.message ?? null}
          ambiguous={!!sendError?.ambiguous}
          onSend={() => void send()}
          onClose={() => setSendReq(null)}
        />
      )}
    </div>
  );
}

