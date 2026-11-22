import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { EmptyState, Icon, Logo, Popover, SearchBox, Segmented, Select } from '../components/ui';
import { dateStamp, downloadText, toCsv } from '../lib/csv';
import {
  type AccountFilters,
  type AccountRow,
  type Section,
  type SortDir,
  type TriState,
  DEFAULT_ACCOUNT_FILTERS,
  activeFilterCount,
  buildAccountRows,
  compareSortValues,
  filterAccountRows,
  inSection,
  SECTIONS,
  sectionCounts,
} from '../lib/filters';
import { safeUrl, displayUrl } from '../lib/links';
import { compareSegments, segmentOf, TYPE_LABEL } from '../lib/stats';
import { STATUS_LABEL, STATUS_ORDER, type OutreachStatus } from '../lib/status';
import { useAppData } from '../state/AppData';
import { replaceHash, accountHref, type Route } from '../state/router';
import { usePersistentState } from '../state/usePersistentState';
import { ACCOUNT_COLUMNS, CSV_HEADERS, accountCsvRow, type AccountColumn, type AccountColumnId } from './accountColumns';
import { AccountDetail } from './AccountDetail';

const SECTION_LABEL: Record<Section, string> = {
  firm: TYPE_LABEL.firm,
  internal: TYPE_LABEL.internal,
  solo: TYPE_LABEL.solo,
  all: 'All',
};

interface SortState {
  col: AccountColumnId;
  dir: SortDir;
}
const DEFAULT_SORT: SortState = { col: 'signal', dir: 'desc' };
const COLUMN_IDS = ACCOUNT_COLUMNS.map((c) => c.id);

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validateFilters(v: unknown): AccountFilters | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<AccountFilters>;
  const tri = (x: unknown): TriState => (x === 'yes' || x === 'no' ? x : 'any');
  return {
    query: typeof r.query === 'string' ? r.query : '',
    segment: typeof r.segment === 'string' ? r.segment : '',
    minSignal: typeof r.minSignal === 'number' && r.minSignal >= 0 && r.minSignal <= 5 ? r.minSignal : 0,
    hasEmail: tri(r.hasEmail),
    status: STATUS_ORDER.includes(r.status as OutreachStatus) ? (r.status as OutreachStatus) : '',
    inAttio: tri(r.inAttio),
    source: typeof r.source === 'string' ? r.source : '',
  };
}

const AccountRowView = memo(function AccountRowView({
  row,
  cols,
  open,
  onToggle,
}: {
  row: AccountRow;
  cols: readonly AccountColumn[];
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const a = row.account;
  const detailId = `detail-${a.id}`;
  const site = safeUrl(a.website ?? a.domain);
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    // Clicks on links/buttons inside the row keep their own behaviour.
    if ((e.target as HTMLElement).closest('a, button, input, select, label')) return;
    if (window.getSelection()?.toString()) return; // user is selecting text
    onToggle(a.id);
  };
  return (
    <tr
      className={'account-row' + (open ? ' open' : '')}
      onClick={onClick}
      data-testid="account-row"
      data-account-id={a.id}
      data-contacts={a.contacts.length}
      id={`row-${a.id}`}
    >
      {cols.map((c) =>
        c.id === 'company' ? (
          <td key={c.id} className="col-company">
            <div className="company">
              <button
                type="button"
                className="row-toggle"
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                onClick={() => onToggle(a.id)}
                data-testid="account-toggle"
                title={open ? 'Collapse' : 'Expand'}
              >
                <Icon name="chevron" size={12} className="chev" />
                <Logo url={a.logoUrl} name={a.name} size={22} />
                <span className="company-name">{a.name}</span>
              </button>
              {site && (
                <a className="company-domain" href={site} target="_blank" rel="noopener noreferrer" title={site}>
                  {a.domain ?? displayUrl(site)}
                </a>
              )}
            </div>
          </td>
        ) : (
          <td key={c.id} className={c.num ? 'num' : undefined}>
            {c.render(row)}
          </td>
        ),
      )}
    </tr>
  );
});

export function Accounts({ route }: { route: Route }) {
  const { accounts, index } = useAppData();
  const [section, setSection] = usePersistentState<Section>('seraos.accounts.section.v1', 'firm', (v) =>
    SECTIONS.includes(v as Section) ? (v as Section) : undefined,
  );
  const [filters, setFilters] = usePersistentState<AccountFilters>('seraos.accounts.filters.v1', DEFAULT_ACCOUNT_FILTERS, validateFilters);
  const [sort, setSort] = usePersistentState<SortState>('seraos.accounts.sort.v1', DEFAULT_SORT, (v) => {
    const r = v as Partial<SortState> | null;
    return r && COLUMN_IDS.includes(r.col as AccountColumnId) && (r.dir === 'asc' || r.dir === 'desc') ? (r as SortState) : undefined;
  });
  const [hidden, setHidden] = usePersistentState<string[]>('seraos.accounts.hiddenColumns.v1', [], (v) => (isStrArr(v) ? v : undefined));
  const [collapsed, setCollapsed] = usePersistentState<string[]>('seraos.accounts.collapsedGroups.v1', [], (v) => (isStrArr(v) ? v : undefined));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const openRef = useRef(open);
  openRef.current = open;
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const deferredFilters = useDeferredValue(filters);
  const rows = useMemo(() => buildAccountRows(accounts, index), [accounts, index]);
  const filtered = useMemo(() => filterAccountRows(rows, deferredFilters), [rows, deferredFilters]);
  const counts = useMemo(() => sectionCounts(filtered), [filtered]);
  const cols = useMemo(() => ACCOUNT_COLUMNS.filter((c) => c.alwaysVisible || !hidden.includes(c.id)), [hidden]);

  const sorted = useMemo(() => {
    const col = ACCOUNT_COLUMNS.find((c) => c.id === sort.col) ?? ACCOUNT_COLUMNS[0]!;
    return filtered
      .filter((r) => inSection(r, section))
      .map((r) => ({ r, v: col.sort(r) }))
      .sort((x, y) => compareSortValues(x.v, y.v, sort.dir) || x.r.account.name.localeCompare(y.r.account.name))
      .map((x) => x.r);
  }, [filtered, section, sort]);

  const groups = useMemo(() => {
    const m = new Map<string, AccountRow[]>();
    for (const r of sorted) {
      const k = segmentOf(r.account);
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    return [...m.entries()].sort((a, b) => compareSegments(a[0], b[0]));
  }, [sorted]);

  const segments = useMemo(() => [...new Set(accounts.map(segmentOf))].sort(compareSegments), [accounts]);
  const sources = useMemo(() => [...new Set(accounts.flatMap((a) => a.sources))].sort(), [accounts]);

  // Keep the detail panel as wide as the visible table area (not the full scroll width).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const set = () => el.style.setProperty('--wrap-w', `${el.clientWidth}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onToggle = useCallback((id: string) => {
    const willOpen = !openRef.current.has(id);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willOpen) replaceHash(accountHref(id));
    else if (decodeURIComponent(window.location.hash).startsWith(`#/accounts/${id}`)) replaceHash('#/accounts');
  }, []);

  // Deep link: #/accounts/<id> → make the account visible, expand it and scroll to it.
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  useEffect(() => {
    const id = route.accountId;
    if (!id) return;
    const row = rows.find((r) => r.account.id === id);
    if (!row) {
      setNotice(`Account “${id}” was not found in the current data.`);
      return;
    }
    const msgs: string[] = [];
    if (section !== 'all' && row.account.type !== section) setSection(row.account.type);
    if (!filterAccountRows([row], filters).length) {
      setFilters(DEFAULT_ACCOUNT_FILTERS);
      msgs.push('Filters were cleared to show the linked account.');
    }
    const seg = segmentOf(row.account);
    setCollapsed((c) => (c.includes(seg) ? c.filter((x) => x !== seg) : c));
    setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setNotice(msgs.length ? msgs.join(' ') : null);
    setScrollTarget(id);
    // Intentionally keyed on the route only: re-running when filters change would undo the user's edits.
  }, [route.nonce, route.accountId, rows.length]);

  useEffect(() => {
    if (!scrollTarget) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`row-${scrollTarget}`);
      const wrap = wrapRef.current;
      if (el && wrap) {
        // Bring the table into view, then scroll only inside it (keeps the toolbar on screen and
        // leaves room for the sticky column + group headers).
        const topbar = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0;
        const wrapTop = wrap.getBoundingClientRect().top;
        if (wrapTop < topbar || wrapTop > window.innerHeight / 2) window.scrollBy({ top: wrapTop - topbar - 12 });
        const offset = el.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
        wrap.scrollTop += offset - 66;
        (el.querySelector('.row-toggle') as HTMLElement | null)?.focus({ preventScroll: true });
        setScrollTarget(null);
      }
    });
    return () => cancelAnimationFrame(raf);
  });

  const setFilter = <K extends keyof AccountFilters>(k: K, v: AccountFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const toggleGroup = (seg: string) => setCollapsed((c) => (c.includes(seg) ? c.filter((x) => x !== seg) : [...c, seg]));
  const onSort = (c: AccountColumn) =>
    setSort((s) => (s.col === c.id ? { col: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col: c.id, dir: c.defaultDir }));

  const exportCsv = () => {
    // Same order as on screen: grouped by segment, sorted within each group.
    const csv = toCsv(CSV_HEADERS, groups.flatMap(([, list]) => list).map(accountCsvRow));
    downloadText(`accounts-${section}-${dateStamp()}.csv`, csv, 'text/csv;charset=utf-8');
  };

  const nFilters = activeFilterCount(filters);
  const highlightContact = route.contactId;

  return (
    <div className="page accounts">
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="page-sub">Click a row to open the account, its contacts and timeline. Log outreach from each contact.</p>
        </div>
      </div>

      <Segmented
        label="Account section"
        value={section}
        onChange={setSection}
        options={SECTIONS.map((s) => ({ id: s, label: SECTION_LABEL[s], count: counts[s] }))}
        testIdPrefix="section-tab"
      />

      <div className="toolbar">
        <SearchBox
          value={filters.query}
          onChange={(v) => setFilter('query', v)}
          placeholder="Search companies, contacts, signals…"
          testId="accounts-search"
        />
        <Select
          label="Segment"
          value={filters.segment}
          onChange={(v) => setFilter('segment', v)}
          options={[{ value: '', label: 'All' }, ...segments.map((s) => ({ value: s, label: s }))]}
          testId="filter-segment"
        />
        <Select
          label="Signal ≥"
          value={String(filters.minSignal)}
          onChange={(v) => setFilter('minSignal', Number(v))}
          options={[{ value: '0', label: 'Any' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}+` }))]}
          testId="filter-signal"
        />
        <Select
          label="Has email"
          value={filters.hasEmail}
          onChange={(v) => setFilter('hasEmail', v)}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
        />
        <Select
          label="Outreach"
          value={filters.status}
          onChange={(v) => setFilter('status', v)}
          options={[{ value: '', label: 'Any' }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
          testId="filter-status"
        />
        <Select
          label="In Attio"
          value={filters.inAttio}
          onChange={(v) => setFilter('inAttio', v)}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
        />
        <Select
          label="Source"
          value={filters.source}
          onChange={(v) => setFilter('source', v)}
          options={[{ value: '', label: 'Any' }, ...sources.map((s) => ({ value: s, label: s }))]}
        />
        {(nFilters > 0 || filters.query) && (
          <button type="button" className="btn btn-ghost" onClick={() => setFilters(DEFAULT_ACCOUNT_FILTERS)} data-testid="clear-filters">
            <Icon name="x" size={12} /> Clear
          </button>
        )}
        <div className="toolbar-spacer" />
        <span className="result-count" data-testid="result-count" aria-live="polite">
          {sorted.length.toLocaleString('en-AU')} {sorted.length === 1 ? 'account' : 'accounts'}
        </span>
        <button type="button" className="btn" onClick={() => setCollapsed([])} data-testid="expand-groups" disabled={!collapsed.length}>
          Expand groups
        </button>
        <button type="button" className="btn" onClick={() => setCollapsed(groups.map(([g]) => g))}>
          Collapse groups
        </button>
        <Popover label="Columns" icon="columns" testId="columns-button">
          <div className="col-picker">
            {ACCOUNT_COLUMNS.filter((c) => !c.alwaysVisible).map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.id)}
                  onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((x) => x !== c.id) : [...h, c.id]))}
                />
                {c.label}
              </label>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setHidden([])}>
              Show all
            </button>
          </div>
        </Popover>
        <button type="button" className="btn" onClick={exportCsv} data-testid="export-csv" disabled={!sorted.length}>
          <Icon name="download" /> CSV
        </button>
      </div>

      {notice && (
        <p className="note" role="status">
          <Icon name="alert" size={12} /> {notice}
          <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </p>
      )}

      <div className="table-wrap" ref={wrapRef} data-testid="accounts-table-wrap">
        {sorted.length === 0 ? (
          <EmptyState title="No accounts match">
            {accounts.length === 0 ? 'No account data loaded.' : 'Try another section, clear the search or reset filters.'}
          </EmptyState>
        ) : (
          <table className="grid" style={{ minWidth: cols.reduce((n, c) => n + c.width, 0) }} data-testid="accounts-table">
            <colgroup>
              {cols.map((c) => (
                <col key={c.id} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {cols.map((c) => {
                  const active = sort.col === c.id;
                  return (
                    <th
                      key={c.id}
                      scope="col"
                      className={(c.id === 'company' ? 'col-company ' : '') + (c.num ? 'num' : '')}
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button type="button" className={'th-btn' + (active ? ' active' : '')} onClick={() => onSort(c)} title={c.title ?? `Sort by ${c.label}`}>
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
            {groups.map(([seg, list]) => {
              const isCollapsed = collapsed.includes(seg);
              return (
                <tbody key={seg} className="group" data-group={seg}>
                  <tr className="group-row">
                    <th colSpan={cols.length} scope="rowgroup">
                      <button
                        type="button"
                        className="group-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleGroup(seg)}
                        data-testid="group-toggle"
                      >
                        <Icon name="chevron" size={12} className="chev" />
                        <span className="group-name">{seg}</span>
                        <span className="count">{list.length}</span>
                      </button>
                    </th>
                  </tr>
                  {!isCollapsed &&
                    list.map((r) => {
                      const isOpen = open.has(r.account.id);
                      return isOpen ? (
                        <AccountWithDetail key={r.account.id} row={r} cols={cols} onToggle={onToggle} highlightContactId={route.accountId === r.account.id ? highlightContact : undefined} />
                      ) : (
                        <AccountRowView key={r.account.id} row={r} cols={cols} open={false} onToggle={onToggle} />
                      );
                    })}
                </tbody>
              );
            })}
          </table>
        )}
      </div>
    </div>
  );
}

function AccountWithDetail({
  row,
  cols,
  onToggle,
  highlightContactId,
}: {
  row: AccountRow;
  cols: readonly AccountColumn[];
  onToggle: (id: string) => void;
  highlightContactId?: string;
}) {
  return (
    <>
      <AccountRowView row={row} cols={cols} open onToggle={onToggle} />
      <tr className="detail-row" id={`detail-${row.account.id}`}>
        <td colSpan={cols.length}>
          <div className="detail-sticky">
            <AccountDetail account={row.account} activity={row.activity} highlightContactId={highlightContactId} />
          </div>
        </td>
      </tr>
    </>
  );
}
