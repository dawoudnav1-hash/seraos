import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Badge, ContactedToggle, EmptyState, Icon, Logo, Popover, SearchBox, Segmented, Select } from '../components/ui';
import { copyText, dateStamp, downloadText, toCsv } from '../lib/csv';
import {
  type AccountFilters,
  type AccountRow,
  type Section,
  type SortDir,
  type TriState,
  CONTACTED_FILTERS,
  DEFAULT_ACCOUNT_FILTERS,
  UNKNOWN,
  activeFilterCount,
  buildAccountRows,
  cityOptions,
  compareSortValues,
  contactedCounts,
  filterAccountRows,
  inSection,
  locationSelectOptions,
  matchesOutreach,
  normalizeOutreach,
  outreachSelectValue,
  SECTIONS,
  sectionCounts,
  stateOptions,
  withContacted,
  withOutreachStatus,
  withoutOutreach,
  withState,
  type ContactedFilter,
} from '../lib/filters';
import { safeUrl, displayUrl } from '../lib/links';
import { compareSegments, segmentOf, TYPE_LABEL } from '../lib/stats';
import { STATUS_LABEL, STATUS_ORDER, type OutreachStatus } from '../lib/status';
import { readJSON } from '../lib/storage';
import { useAppData } from '../state/AppData';
import { replaceHash, accountHref, type Route } from '../state/router';
import { usePersistentState } from '../state/usePersistentState';
import { ACCOUNT_COLUMNS, CSV_HEADERS, accountCsvRow, type AccountColumn, type AccountColumnId } from './accountColumns';
import { AccountDetail } from './AccountDetail';

const SECTION_LABEL: Record<Section, string> = {
  firm: TYPE_LABEL.firm,
  internal: TYPE_LABEL.internal,
  solo: TYPE_LABEL.solo,
  services: TYPE_LABEL.services,
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
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return normalizeOutreach<AccountFilters>({
    query: s(r.query),
    contacted: CONTACTED_FILTERS.includes(r.contacted as ContactedFilter) ? (r.contacted as ContactedFilter) : 'all',
    city: s(r.city),
    state: s(r.state),
    segment: s(r.segment),
    minSignal: typeof r.minSignal === 'number' && r.minSignal >= 0 && r.minSignal <= 5 ? r.minSignal : 0,
    hasEmail: tri(r.hasEmail),
    status: STATUS_ORDER.includes(r.status as OutreachStatus) ? (r.status as OutreachStatus) : '',
    inAttio: tri(r.inAttio),
    source: s(r.source),
  });
}

/** Per-column visibility overrides; columns not listed use their `defaultVisible`. */
type ColumnPrefs = Partial<Record<AccountColumnId, boolean>>;
const COLUMN_PREFS_KEY = 'seraos.accounts.columns.v2';

function validateColumnPrefs(v: unknown): ColumnPrefs | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: ColumnPrefs = {};
  for (const [k, x] of Object.entries(v)) if (COLUMN_IDS.includes(k as AccountColumnId) && typeof x === 'boolean') out[k as AccountColumnId] = x;
  return out;
}

/** Carries over columns hidden with the old (v1) hidden-list preference. */
function legacyColumnPrefs(): ColumnPrefs {
  const old = readJSON<unknown>('seraos.accounts.hiddenColumns.v1', undefined);
  return isStrArr(old) ? (validateColumnPrefs(Object.fromEntries(old.map((id) => [id, false]))) ?? {}) : {};
}

const isColumnVisible = (c: AccountColumn, prefs: ColumnPrefs) => !!c.alwaysVisible || (prefs[c.id] ?? c.defaultVisible);

const AccountRowView = memo(function AccountRowView({
  row,
  cols,
  open,
  onToggle,
  moved,
}: {
  row: AccountRow;
  cols: readonly AccountColumn[];
  open: boolean;
  onToggle: (id: string) => void;
  /** kept on screen while open although it no longer matches the outreach filter */
  moved?: boolean;
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
      className={'account-row' + (open ? ' open' : '') + (moved ? ' moved' : '')}
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
              {moved && (
                <Badge tone="moved" title="No longer matches the Outreach filter — it leaves the list when you collapse it.">
                  Now {STATUS_LABEL[row.activity.status].toLowerCase()}
                </Badge>
              )}
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
  const { accounts, index, toast } = useAppData();
  const [section, setSection] = usePersistentState<Section>('seraos.accounts.section.v1', 'firm', (v) =>
    SECTIONS.includes(v as Section) ? (v as Section) : undefined,
  );
  const [filters, setFilters] = usePersistentState<AccountFilters>('seraos.accounts.filters.v1', DEFAULT_ACCOUNT_FILTERS, validateFilters);
  const [sort, setSort] = usePersistentState<SortState>('seraos.accounts.sort.v1', DEFAULT_SORT, (v) => {
    const r = v as Partial<SortState> | null;
    return r && COLUMN_IDS.includes(r.col as AccountColumnId) && (r.dir === 'asc' || r.dir === 'desc') ? (r as SortState) : undefined;
  });
  const [colPrefs, setColPrefs] = usePersistentState<ColumnPrefs>(COLUMN_PREFS_KEY, legacyColumnPrefs(), validateColumnPrefs);
  const [collapsed, setCollapsed] = usePersistentState<string[]>('seraos.accounts.collapsedGroups.v1', [], (v) => (isStrArr(v) ? v : undefined));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const openRef = useRef(open);
  openRef.current = open;
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const deferredFilters = useDeferredValue(filters);
  const rows = useMemo(() => buildAccountRows(accounts, index), [accounts, index]);
  // Every filter except Contacted / Outreach status: the base for the toggle counts.
  const baseFiltered = useMemo(() => filterAccountRows(rows, withoutOutreach(deferredFilters)), [rows, deferredFilters]);
  const filtered = useMemo(() => baseFiltered.filter((r) => matchesOutreach(r.activity.status, deferredFilters)), [baseFiltered, deferredFilters]);
  const counts = useMemo(() => sectionCounts(filtered), [filtered]);
  const outreachCounts = useMemo(() => contactedCounts(baseFiltered.filter((r) => inSection(r, section))), [baseFiltered, section]);
  const cols = useMemo(() => ACCOUNT_COLUMNS.filter((c) => isColumnVisible(c, colPrefs)), [colPrefs]);

  // An open account whose status changes (e.g. you log "Email sent" while viewing "Not contacted") stays on
  // screen, marked "Now contacted", until it is collapsed or the filters change — so you can keep working on it.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const matchingIds = useMemo(() => new Set(filtered.filter((r) => inSection(r, section)).map((r) => r.account.id)), [filtered, section]);
  const matchingRef = useRef(matchingIds);
  matchingRef.current = matchingIds;
  const filterKey = JSON.stringify(deferredFilters) + '|' + section;
  useEffect(() => {
    setKept(new Set([...openRef.current].filter((id) => matchingRef.current.has(id))));
  }, [filterKey]);

  const sorted = useMemo(() => {
    const col = ACCOUNT_COLUMNS.find((c) => c.id === sort.col) ?? ACCOUNT_COLUMNS[0]!;
    return baseFiltered
      .filter((r) => inSection(r, section) && (matchingIds.has(r.account.id) || (kept.has(r.account.id) && open.has(r.account.id))))
      .map((r) => ({ r, v: col.sort(r) }))
      .sort((x, y) => compareSortValues(x.v, y.v, sort.dir) || x.r.account.name.localeCompare(y.r.account.name))
      .map((x) => x.r);
  }, [baseFiltered, section, sort, matchingIds, kept, open]);
  const nMatching = sorted.length - sorted.filter((r) => !matchingIds.has(r.account.id)).length;

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
  const cityOpts = useMemo(
    () => locationSelectOptions(cityOptions(accounts, undefined, filters.state), filters.city, 'All', 'Unknown'),
    [accounts, filters.state, filters.city],
  );
  const stateOpts = useMemo(() => locationSelectOptions(stateOptions(accounts), filters.state, 'All', 'No state'), [accounts, filters.state]);
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
    setKept((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(id);
      else next.delete(id);
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
    setKept((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setNotice(msgs.length ? msgs.join(' ') : null);
    setScrollTarget(id);
    // Intentionally keyed on the route only: re-running when filters change would undo the user's edits.
  }, [route.nonce, route.accountId, rows.length]);

  // #/accounts?city=<city> (from the dashboard By-city table): All accounts in that city, nothing else filtered.
  useEffect(() => {
    const city = route.city;
    if (!city) return;
    const hadFilters = activeFilterCount(filters) > 0 || !!filters.query;
    setSection('all');
    setFilters({ ...DEFAULT_ACCOUNT_FILTERS, city });
    setNotice(hadFilters ? `Showing all accounts in ${city === UNKNOWN ? 'an unknown city' : city}; other filters were cleared.` : null);
    replaceHash('#/accounts');
    // Keyed on the route only, like the deep link above.
  }, [route.nonce, route.city]);

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
  const setContacted = (v: ContactedFilter) => setFilters((f) => withContacted(f, v));
  const toggleGroup = (seg: string) => setCollapsed((c) => (c.includes(seg) ? c.filter((x) => x !== seg) : [...c, seg]));
  const onSort = (c: AccountColumn) =>
    setSort((s) => (s.col === c.id ? { col: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col: c.id, dir: c.defaultDir }));

  // Same order as on screen: grouped by segment, sorted within each group.
  const buildCsv = () => toCsv(CSV_HEADERS, groups.flatMap(([, list]) => list).map(accountCsvRow));
  const exportCsv = () => downloadText(`accounts-${section}-${dateStamp()}.csv`, buildCsv(), 'text/csv;charset=utf-8');
  const copyCsv = async () => {
    const ok = await copyText(buildCsv());
    toast(ok ? { message: `Copied ${sorted.length} accounts as CSV — paste into Sheets or Excel.` } : { message: 'Could not copy to the clipboard.', tone: 'error' });
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
        <ContactedToggle value={filters.contacted} counts={outreachCounts} onChange={setContacted} noun="accounts" testIdPrefix="contacted" />
        <SearchBox
          value={filters.query}
          onChange={(v) => setFilter('query', v)}
          placeholder="Search companies, contacts, cities…"
          testId="accounts-search"
        />
        <Select label="City" value={filters.city} onChange={(v) => setFilter('city', v)} options={cityOpts} testId="filter-city" />
        <Select label="State" value={filters.state} onChange={(v) => setFilters((f) => withState(f, v, accounts))} options={stateOpts} testId="filter-state" />
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
          value={outreachSelectValue(filters)}
          onChange={(v) => setFilters((f) => withOutreachStatus(f, v))}
          options={[{ value: '', label: filters.contacted === 'contacted' ? 'Any contacted' : 'Any' }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
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
      </div>

      <div className="toolbar results-bar">
        <span className="result-count" data-testid="result-count" aria-live="polite">
          {nMatching.toLocaleString('en-AU')} {nMatching === 1 ? 'account' : 'accounts'}
          {sorted.length > nMatching && <span className="muted"> + {sorted.length - nMatching} kept open</span>}
        </span>
        <div className="toolbar-spacer" />
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
                  checked={isColumnVisible(c, colPrefs)}
                  onChange={(e) => setColPrefs((p) => ({ ...p, [c.id]: e.target.checked }))}
                  data-testid={`column-toggle-${c.id}`}
                />
                {c.label}
              </label>
            ))}
            <div className="col-picker-actions">
              <button type="button" className="btn btn-sm" onClick={() => setColPrefs(Object.fromEntries(COLUMN_IDS.map((id) => [id, true])))}>
                Show all
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setColPrefs({})}>
                Defaults
              </button>
            </div>
          </div>
        </Popover>
        <button type="button" className="btn" onClick={exportCsv} data-testid="export-csv" disabled={!sorted.length}>
          <Icon name="download" /> CSV
        </button>
        <button type="button" className="btn" onClick={copyCsv} data-testid="copy-csv" disabled={!sorted.length} title="Copy the visible rows as CSV">
          Copy
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
                        <AccountWithDetail
                          key={r.account.id}
                          row={r}
                          cols={cols}
                          onToggle={onToggle}
                          moved={!matchingIds.has(r.account.id)}
                          highlightContactId={route.accountId === r.account.id ? highlightContact : undefined}
                        />
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
  moved,
  highlightContactId,
}: {
  row: AccountRow;
  cols: readonly AccountColumn[];
  onToggle: (id: string) => void;
  moved: boolean;
  highlightContactId?: string;
}) {
  return (
    <>
      <AccountRowView row={row} cols={cols} open onToggle={onToggle} moved={moved} />
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
