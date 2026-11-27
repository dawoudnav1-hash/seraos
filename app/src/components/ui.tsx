import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { displayUrl, mailtoHref, safeUrl } from '../lib/links';
import { initials } from '../lib/format';
import { CONTACTED_FILTERS, type ContactedFilter } from '../lib/filters';
import { STATUS_LABEL, type OutreachStatus } from '../lib/status';
import type { Grade } from '../types';

/* ---------------- icons (inline SVG, currentColor) ---------------- */

type IconName =
  | 'chevron'
  | 'linkedin'
  | 'mail'
  | 'globe'
  | 'external'
  | 'search'
  | 'download'
  | 'upload'
  | 'columns'
  | 'x'
  | 'trash'
  | 'check'
  | 'alert'
  | 'calendar'
  | 'eye'
  | 'reply'
  | 'send'
  | 'user'
  | 'link'
  | 'filter';

const PATHS: Record<IconName, ReactNode> = {
  chevron: <path d="M6 4l4 4-4 4" />,
  linkedin: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 7v4M5 5v.01M8 11V7m0 2c0-1.1.9-2 2-2s1.5.7 1.5 1.8V11" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5L8 8.5l5.5-4" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" />
    </>
  ),
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  download: <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />,
  upload: <path d="M8 10.5v-8M4.5 6L8 2.5 11.5 6M3 13.5h10" />,
  columns: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10M10 3v10" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  alert: (
    <>
      <path d="M8 2l6.5 11.5h-13z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  reply: <path d="M6.5 4L3 7.5 6.5 11M3.5 7.5H10a3 3 0 013 3V12" />,
  send: <path d="M14 2L7 9M14 2l-4.5 12L7 9 2 6.5z" />,
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5" />
    </>
  ),
  link: <path d="M7 9a3 3 0 004.2 0l2-2a3 3 0 00-4.2-4.2l-.8.8M9 7a3 3 0 00-4.2 0l-2 2a3 3 0 004.2 4.2l.8-.8" />,
  filter: <path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z" />,
};

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={'icon' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ---------------- pills / badges ---------------- */

export function StatusPill({ status }: { status: OutreachStatus }) {
  return (
    <span className={`pill status status-${status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ScorePill({ score, label = 'Signal' }: { score: number | null | undefined; label?: string }) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return <span className="muted">—</span>;
  const s = Math.max(1, Math.min(5, Math.round(score)));
  return (
    <span className={`pill score score-${s}`} title={`${label} score ${s} of 5`} aria-label={`${label} score ${s} of 5`}>
      {s}
      <span className="score-of">/5</span>
    </span>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function SourceBadges({ sources, max = 3 }: { sources: readonly string[]; max?: number }) {
  if (!sources.length) return <span className="muted">—</span>;
  const shown = sources.slice(0, max);
  const rest = sources.length - shown.length;
  return (
    <span className="badges">
      {shown.map((s) => (
        <Badge key={s} tone={s === 'Attio' ? 'attio' : 'neutral'} title={s}>
          {shortSource(s)}
        </Badge>
      ))}
      {rest > 0 && (
        <Badge title={sources.slice(max).join(', ')}>+{rest}</Badge>
      )}
    </span>
  );
}

export function shortSource(s: string): string {
  const map: Record<string, string> = {
    Vert_AU_finance_team_contacts: 'Finance teams',
    Vert_AU_prospects_Origami: 'Origami',
    AU_ecommerce_AI_finance_leads: 'Ecom leads',
    'Melbourne Accounting Firm Contacts': 'Melb firms',
  };
  return map[s] ?? (s.length > 22 ? s.slice(0, 20) + '…' : s);
}

/* ---------------- links ---------------- */

export function ExtLink({
  href,
  children,
  className,
  title,
  label,
}: {
  href: string | undefined | null;
  children?: ReactNode;
  className?: string;
  title?: string;
  label?: string;
}) {
  const url = safeUrl(href ?? undefined);
  if (!url) return children ? <span className={className}>{children}</span> : null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className} title={title ?? url} aria-label={label}>
      {children ?? displayUrl(url)}
    </a>
  );
}

export function LinkedInLink({ href, name }: { href?: string; name?: string }) {
  const url = safeUrl(href);
  if (!url) return <span className="muted">—</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="icon-link li" title={url} aria-label={`LinkedIn${name ? ' — ' + name : ''}`}>
      <Icon name="linkedin" />
    </a>
  );
}

export function EmailLink({ email }: { email?: string }) {
  const href = mailtoHref(email);
  if (!email) return <span className="muted">—</span>;
  if (!href) return <span>{email}</span>;
  return (
    <a href={href} className="email-link" title={`Email ${email}`}>
      {email}
    </a>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Renders text as text, turning http(s) URLs into safe links. Preserves line breaks via CSS. */
export function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 1) {
          const trimmed = p.replace(/[.,;:!?]+$/, '');
          const tail = p.slice(trimmed.length);
          const url = safeUrl(trimmed);
          return (
            <Fragment key={i}>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {displayUrl(url)}
                </a>
              ) : (
                trimmed
              )}
              {tail}
            </Fragment>
          );
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/* ---------------- logo ---------------- */

export function Logo({ url, name, size = 24 }: { url?: string; name: string; size?: number }) {
  const safe = safeUrl(url);
  const [failed, setFailed] = useState(false);
  if (!safe || failed) {
    return (
      <span className="logo logo-fallback" style={{ width: size, height: size }} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className="logo"
      src={safe}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/* ---------------- segmented control ---------------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testIdPrefix,
  className,
}: {
  options: readonly { id: T; label: ReactNode; count?: number; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testIdPrefix?: string;
  className?: string;
}) {
  return (
    <div className={'segmented' + (className ? ' ' + className : '')} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          title={o.title}
          className={`seg-${o.id}` + (o.id === value ? ' active' : '')}
          onClick={() => onChange(o.id)}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}
        >
          <span>{o.label}</span>
          {o.count !== undefined && (
            <span className="count" data-testid={testIdPrefix ? `${testIdPrefix}-count-${o.id}` : undefined}>
              {o.count.toLocaleString('en-AU')}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------- contacted / not contacted toggle ---------------- */

const CONTACTED_OPTION: Record<ContactedFilter, { label: string; title: string }> = {
  all: { label: 'All', title: 'Contacted and not contacted' },
  not_contacted: { label: 'Not contacted', title: 'No outreach event of any kind yet (imported or logged manually)' },
  contacted: { label: 'Contacted', title: 'At least one event: sent, connection, seen, replied or meeting' },
};

export function ContactedToggle({
  value,
  counts,
  onChange,
  noun,
  testIdPrefix,
}: {
  value: ContactedFilter;
  counts: Record<ContactedFilter, number>;
  onChange: (v: ContactedFilter) => void;
  noun: string;
  testIdPrefix: string;
}) {
  return (
    <Segmented
      className="segmented-contacted"
      label={`Show ${noun} by outreach`}
      value={value}
      onChange={onChange}
      testIdPrefix={testIdPrefix}
      options={CONTACTED_FILTERS.map((id) => ({
        id,
        title: CONTACTED_OPTION[id].title,
        count: counts[id],
        label:
          id === 'all' ? (
            CONTACTED_OPTION[id].label
          ) : (
            <>
              <i className="dot" aria-hidden="true" />
              {CONTACTED_OPTION[id].label}
            </>
          ),
      }))}
    />
  );
}

/* ---------------- select ---------------- */

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  testId?: string;
}) {
  const id = useId();
  return (
    <label className={'select' + (value && value !== ('any' as T) && value !== ('0' as T) && value !== ('all' as T) ? ' is-set' : '')} htmlFor={id}>
      <span className="select-label">{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ---------------- search ---------------- */

export function SearchBox({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId?: string;
}) {
  return (
    <div className="search">
      <Icon name="search" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        spellCheck={false}
      />
      {value && (
        <button type="button" className="icon-btn" onClick={() => onChange('')} aria-label="Clear search">
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/* ---------------- popover menu (column picker) ---------------- */

export function Popover({ label, icon, children, testId }: { label: string; icon?: IconName; children: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      <button type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        {icon && <Icon name={icon} />}
        {label}
      </button>
      {open && (
        <div className="popover" id={id} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------------- confirm dialog ---------------- */

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} data-testid="confirm-ok">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/* ---------------- rating / grade ---------------- */

export function GradePill({ grade, rating, showRating = true }: { grade: Grade; rating?: number; showRating?: boolean }) {
  const title = `Grade ${grade}${typeof rating === 'number' ? ` · rating ${rating}/100` : ''}`;
  return (
    <span className="grade-cell" title={title} aria-label={title} data-testid="grade-pill" data-grade={grade}>
      <span className={`pill grade grade-${grade}`}>{grade}</span>
      {showRating && typeof rating === 'number' && <span className="grade-score">{rating}</span>}
    </span>
  );
}

const GRADE_LIST: readonly Grade[] = ['A', 'B', 'C', 'D'];

/** Multi-select grade chips (none selected = any grade) with a "B or better" shortcut. */
export function GradeFilter({ value, onChange, testIdPrefix = 'grade-filter' }: { value: readonly Grade[]; onChange: (v: Grade[]) => void; testIdPrefix?: string }) {
  const toggle = (g: Grade) => onChange(GRADE_LIST.filter((x) => (x === g ? !value.includes(g) : value.includes(x))));
  const bOrBetter = value.length === 2 && value.includes('A') && value.includes('B');
  return (
    <div className={'grade-filter' + (value.length ? ' is-set' : '')} role="group" aria-label="Filter by grade">
      <span className="select-label">Grade</span>
      {GRADE_LIST.map((g) => (
        <button
          key={g}
          type="button"
          className={`grade-chip grade-${g}` + (value.includes(g) ? ' active' : '')}
          aria-pressed={value.includes(g)}
          onClick={() => toggle(g)}
          data-testid={`${testIdPrefix}-${g}`}
          title={`Show grade ${g}`}
        >
          {g}
        </button>
      ))}
      <button
        type="button"
        className={'grade-chip grade-any' + (bOrBetter ? ' active' : '')}
        aria-pressed={bOrBetter}
        onClick={() => onChange(bOrBetter ? [] : ['A', 'B'])}
        title="Grade B or better"
        data-testid={`${testIdPrefix}-b-plus`}
      >
        B+
      </button>
    </div>
  );
}
