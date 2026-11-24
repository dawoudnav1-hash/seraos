import { useDeferredValue, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Badge, ContactedToggle, EmailLink, EmptyState, Icon, LinkedInLink, SearchBox, Segmented, Select, SourceBadges, StatusPill } from '../components/ui';
import { copyText, dateStamp, downloadText, toCsv } from '../lib/csv';
import { kindLabel } from '../lib/events';
import {
  type ContactFilters,
  type ContactRow,
  type Section,
  type SortDir,
  type SortValue,
  type ContactedFilter,
  CONTACTED_FILTERS,
  DEFAULT_CONTACT_FILTERS,
  activeFilterCount,
  buildContactRows,
  cityOf,
  cityOptions,
  citySortKey,
  citySubtitle,
  compareSortValues,
  contactedCounts,
  filterContactRows,
  inSection,
  locationSelectOptions,
  matchesOutreach,
  normalizeOutreach,
  outreachSelectValue,
  SECTIONS,
  stateOptions,
  withContacted,
  withOutreachStatus,
  withoutOutreach,
  withState,
} from '../lib/filters';
import { formatDate, localISODate } from '../lib/format';
import { compareSegments, segmentOf, TYPE_LABEL } from '../lib/stats';
import { STATUS_LABEL, STATUS_ORDER, statusRank, type OutreachStatus } from '../lib/status';
import { useAppData } from '../state/AppData';
import type { Account } from '../types';
import { accountHref } from '../state/router';
import { usePersistentState } from '../state/usePersistentState';

type ColId = 'name' | 'title' | 'account' | 'section' | 'segment' | 'city' | 'email' | 'linkedin' | 'location' | 'status' | 'lastTouch' | 'sources';

const SECTION_SHORT: Record<Section, string> = { firm: 'Firms', internal: 'Internal finance', solo: '1-person', all: 'All' };

const COLS: readonly { id: ColId; label: string; width: number; defaultDir: SortDir; sort: (r: ContactRow) => SortValue }[] = [
  { id: 'name', label: 'Name', width: 220, defaultDir: 'asc', sort: (r) => r.contact.name.toLowerCase() },
  { id: 'title', label: 'Title', width: 200, defaultDir: 'asc', sort: (r) => r.contact.title?.toLowerCase() },
  { id: 'account', label: 'Account', width: 200, defaultDir: 'asc', sort: (r) => r.account.name.toLowerCase() },
  { id: 'section', label: 'Section', width: 150, defaultDir: 'asc', sort: (r) => r.account.type },
  { id: 'segment', label: 'Segment', width: 150, defaultDir: 'asc', sort: (r) => r.account.segment },
  { id: 'city', label: 'City', width: 160, defaultDir: 'asc', sort: (r) => citySortKey(r.account) },
  { id: 'email', label: 'Email', width: 270, defaultDir: 'asc', sort: (r) => r.contact.email?.toLowerCase() },
  { id: 'linkedin', label: 'LinkedIn', width: 90, defaultDir: 'asc', sort: (r) => (r.contact.linkedin ? 0 : 1) },
  { id: 'location', label: 'Location', width: 150, defaultDir: 'asc', sort: (r) => r.contact.location?.toLowerCase() },
  { id: 'status', label: 'Outreach', width: 124, defaultDir: 'desc', sort: (r) => statusRank(r.activity.status) },
  { id: 'lastTouch', label: 'Last touch', width: 150, defaultDir: 'desc', sort: (r) => r.activity.lastTouch },
  { id: 'sources', label: 'Sources', width: 180, defaultDir: 'asc', sort: (r) => r.contact.sources.join(',') },
];
const COL_IDS = COLS.map((c) => c.id);

function validate(v: unknown): ContactFilters | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<ContactFilters>;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return normalizeOutreach<ContactFilters>({
    query: s(r.query),
    section: SECTIONS.includes(r.section as Section) ? (r.section as Section) : 'all',
    contacted: CONTACTED_FILTERS.includes(r.contacted as ContactedFilter) ? (r.contacted as ContactedFilter) : 'all',
    city: s(r.city),
    state: s(r.state),
    segment: s(r.segment),
    emailRisk: r.emailRisk === 'ok' || r.emailRisk === 'caution' || r.emailRisk === 'none' ? r.emailRisk : '',
    status: STATUS_ORDER.includes(r.status as OutreachStatus) ? (r.status as OutreachStatus) : '',
  });
}

/** City / State option counts on this page are contact counts. */
const contactCount = (a: Account) => a.contacts.length;

/** Rows rendered per "page"; the rest load on demand to keep huge lists snappy. */
const PAGE = 300;

export function Contacts() {
  const { accounts, index, toast } = useAppData();
  const [filters, setFilters] = usePersistentState<ContactFilters>('seraos.contacts.filters.v1', DEFAULT_CONTACT_FILTERS, validate);
  const [sort, setSort] = usePersistentState<{ col: ColId; dir: SortDir }>('seraos.contacts.sort.v1', { col: 'name', dir: 'asc' }, (v) => {
    const r = v as { col?: ColId; dir?: SortDir } | null;
    return r && COL_IDS.includes(r.col as ColId) && (r.dir === 'asc' || r.dir === 'desc') ? { col: r.col as ColId, dir: r.dir } : undefined;
  });
  const [limit, setLimit] = useState(PAGE);
  const deferred = useDeferredValue(filters);

  const rows = useMemo(() => buildContactRows(accounts, index), [accounts, index]);
  // Every filter except section / outreach; the section tabs and the contacted toggle each count from here.
  const baseFiltered = useMemo(() => filterContactRows(rows, withoutOutreach({ ...deferred, section: 'all' })), [rows, deferred]);
  const sectionFiltered = useMemo(() => baseFiltered.filter((r) => matchesOutreach(r.activity.status, deferred)), [baseFiltered, deferred]);
  const outreachCounts = useMemo(() => contactedCounts(baseFiltered.filter((r) => inSection(r, deferred.section))), [baseFiltered, deferred.section]);
  const counts = useMemo(() => {
    const c: Record<Section, number> = { all: sectionFiltered.length, firm: 0, internal: 0, solo: 0 };
    for (const r of sectionFiltered) c[r.account.type]++;
    return c;
  }, [sectionFiltered]);
  const sorted = useMemo(() => {
    const col = COLS.find((c) => c.id === sort.col) ?? COLS[0]!;
    return sectionFiltered
      .filter((r) => deferred.section === 'all' || r.account.type === deferred.section)
      .map((r) => ({ r, v: col.sort(r) }))
      .sort((a, b) => compareSortValues(a.v, b.v, sort.dir) || a.r.contact.name.localeCompare(b.r.contact.name))
      .map((x) => x.r);
  }, [sectionFiltered, deferred.section, sort]);
  const segments = useMemo(() => [...new Set(accounts.map(segmentOf))].sort(compareSegments), [accounts]);
  const cityOpts = useMemo(
    () => locationSelectOptions(cityOptions(accounts, contactCount, filters.state), filters.city, 'All', 'Unknown'),
    [accounts, filters.state, filters.city],
  );
  const stateOpts = useMemo(() => locationSelectOptions(stateOptions(accounts, contactCount), filters.state, 'All', 'No state'), [accounts, filters.state]);

  const update = (fn: (f: ContactFilters) => ContactFilters) => {
    setLimit(PAGE);
    setFilters(fn);
  };
  const setFilter = <K extends keyof ContactFilters>(k: K, v: ContactFilters[K]) => update((f) => ({ ...f, [k]: v }));

  const go = (r: ContactRow) => {
    window.location.hash = accountHref(r.account.id, r.contact.id);
  };
  const onRowClick = (e: MouseEvent, r: ContactRow) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    go(r);
  };
  const onRowKey = (e: KeyboardEvent, r: ContactRow) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      go(r);
    }
  };

  const buildCsv = () =>
    toCsv(
      ['Contact ID', 'Name', 'Title', 'Role type', 'Account', 'Account ID', 'Section', 'Segment', 'City', 'Suburb', 'State', 'Email', 'Email risk', 'Email status', 'LinkedIn', 'Location', 'Primary', 'Likely left', 'Outreach status', 'Last touch', 'Sources'],
      sorted.map((r) => [
        r.contact.id,
        r.contact.name,
        r.contact.title,
        r.contact.roleType,
        r.account.name,
        r.account.id,
        TYPE_LABEL[r.account.type],
        r.account.segment,
        r.account.city,
        r.account.suburb,
        r.account.state,
        r.contact.email,
        r.contact.emailRisk,
        r.contact.emailStatus,
        r.contact.linkedin,
        r.contact.location,
        !!r.contact.isPrimary,
        !!r.contact.likelyLeft,
        STATUS_LABEL[r.activity.status],
        r.activity.lastTouch ? localISODate(r.activity.lastTouch) : '',
        r.contact.sources.join('; '),
      ]),
    );
  const exportCsv = () => downloadText(`contacts-${filters.section}-${dateStamp()}.csv`, buildCsv(), 'text/csv;charset=utf-8');
  const copyCsv = async () => {
    const ok = await copyText(buildCsv());
    toast(ok ? { message: `Copied ${sorted.length} contacts as CSV — paste into Sheets or Excel.` } : { message: 'Could not copy to the clipboard.', tone: 'error' });
  };

  const shown = sorted.slice(0, limit);

  return (
    <div className="page contacts">
      <div className="page-head">
        <div>
          <h1>Contacts</h1>
          <p className="page-sub">Every lead across all accounts. Click a row to open the account.</p>
        </div>
      </div>
      <Segmented
        label="Contact section"
        value={filters.section}
        onChange={(v) => setFilter('section', v)}
        options={SECTIONS.map((s) => ({ id: s, label: SECTION_SHORT[s], count: counts[s] }))}
        testIdPrefix="contact-section-tab"
      />
      <div className="toolbar">
        <ContactedToggle value={filters.contacted} counts={outreachCounts} onChange={(v) => update((f) => withContacted(f, v))} noun="contacts" testIdPrefix="contact-contacted" />
        <SearchBox value={filters.query} onChange={(v) => setFilter('query', v)} placeholder="Search name, email, account, city…" testId="contacts-search" />
        <Select label="City" value={filters.city} onChange={(v) => setFilter('city', v)} options={cityOpts} testId="contacts-filter-city" />
        <Select label="State" value={filters.state} onChange={(v) => update((f) => withState(f, v, accounts))} options={stateOpts} testId="contacts-filter-state" />
        <Select
          label="Segment"
          value={filters.segment}
          onChange={(v) => setFilter('segment', v)}
          options={[{ value: '', label: 'All' }, ...segments.map((s) => ({ value: s, label: s }))]}
        />
        <Select
          label="Email"
          value={filters.emailRisk}
          onChange={(v) => setFilter('emailRisk', v)}
          options={[
            { value: '', label: 'Any' },
            { value: 'ok', label: 'Verified / ok' },
            { value: 'caution', label: 'Caution' },
            { value: 'none', label: 'No email' },
          ]}
        />
        <Select
          label="Outreach"
          value={outreachSelectValue(filters)}
          onChange={(v) => update((f) => withOutreachStatus(f, v))}
          options={[{ value: '', label: filters.contacted === 'contacted' ? 'Any contacted' : 'Any' }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        {(activeFilterCount(filters) > 0 || filters.query) && (
          <button type="button" className="btn btn-ghost" onClick={() => update(() => DEFAULT_CONTACT_FILTERS)}>
            <Icon name="x" size={12} /> Clear
          </button>
        )}
      </div>

      <div className="toolbar results-bar">
        <span className="result-count" data-testid="contacts-count">
          {sorted.length.toLocaleString('en-AU')} {sorted.length === 1 ? 'contact' : 'contacts'}
        </span>
        <div className="toolbar-spacer" />
        <button type="button" className="btn" onClick={exportCsv} disabled={!sorted.length}>
          <Icon name="download" /> CSV
        </button>
        <button type="button" className="btn" onClick={copyCsv} disabled={!sorted.length} title="Copy the visible rows as CSV">
          Copy
        </button>
      </div>

      <div className="table-wrap">
        {sorted.length === 0 ? (
          <EmptyState title="No contacts match">{rows.length === 0 ? 'No contact data loaded.' : 'Clear the search or reset filters.'}</EmptyState>
        ) : (
          <table className="grid" style={{ minWidth: COLS.reduce((n, c) => n + c.width, 0) }} data-testid="contacts-table">
            <colgroup>
              {COLS.map((c) => (
                <col key={c.id} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLS.map((c) => {
                  const active = sort.col === c.id;
                  return (
                    <th key={c.id} scope="col" className={c.id === 'name' ? 'col-company' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        className={'th-btn' + (active ? ' active' : '')}
                        onClick={() => setSort((s) => (s.col === c.id ? { col: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col: c.id, dir: c.defaultDir }))}
                      >
                        <span>{c.label}</span>
                        <span className="sort-ind" aria-hidden="true">
                          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const c = r.contact;
                const last = r.activity.events[0];
                return (
                  <tr
                    key={c.id}
                    className={'contact-list-row' + (c.likelyLeft ? ' left' : '')}
                    tabIndex={0}
                    onClick={(e) => onRowClick(e, r)}
                    onKeyDown={(e) => onRowKey(e, r)}
                    data-testid="contact-list-row"
                    data-account-id={r.account.id}
                    aria-label={`${c.name} at ${r.account.name} — open account`}
                  >
                    <td className="col-company">
                      <div className="stack">
                        <span className="strong">{c.name}</span>
                        <span className="badges">
                          {c.isPrimary && <Badge tone="primary">Primary</Badge>}
                          {c.likelyLeft && (
                            <Badge tone="warn" title={c.notes}>
                              Likely left
                            </Badge>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="stack">
                        <span className="clamp-1" title={c.title}>{c.title ?? <span className="muted">—</span>}</span>
                        {c.roleType && <span className="sub">{c.roleType}</span>}
                      </div>
                    </td>
                    <td>
                      <a href={accountHref(r.account.id, c.id)} className="clamp-1">
                        {r.account.name}
                      </a>
                    </td>
                    <td>
                      <span className={`badge badge-type-${r.account.type}`}>{SECTION_SHORT[r.account.type]}</span>
                    </td>
                    <td>{r.account.segment}</td>
                    <td>
                      {cityOf(r.account) ? (
                        <div className="stack" data-testid="contact-city-cell" data-city={cityOf(r.account)}>
                          <span className="clamp-1">{cityOf(r.account)}</span>
                          {citySubtitle(r.account) && <span className="sub clamp-1">{citySubtitle(r.account)}</span>}
                        </div>
                      ) : (
                        <span className="muted" data-testid="contact-city-cell" data-city="">
                          —
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="email-cell">
                        <EmailLink email={c.email} />
                        {c.email && c.emailRisk === 'caution' && (
                          <Badge tone="caution" title={c.emailStatus}>
                            caution
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="center">
                      <LinkedInLink href={c.linkedin} name={c.name} />
                    </td>
                    <td>
                      <span className="clamp-1" title={c.location}>{c.location ?? <span className="muted">—</span>}</span>
                    </td>
                    <td>
                      <StatusPill status={r.activity.status} />
                    </td>
                    <td>
                      {last ? (
                        <div className="stack">
                          <span>{formatDate(r.activity.lastTouch)}</span>
                          <span className="sub">{kindLabel(last)}</span>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <SourceBadges sources={c.sources} max={2} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sorted.length > limit && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, sorted.length - limit)} more
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setLimit(sorted.length)}>
              Show all {sorted.length.toLocaleString('en-AU')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
