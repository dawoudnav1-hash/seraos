import type { ReactNode } from 'react';
import { ExtLink, GradePill, LinkedInLink, ScorePill, SourceBadges, StatusPill } from '../components/ui';
import type { CsvValue } from '../lib/csv';
import { DASH, formatDate, localISODate } from '../lib/format';
import { type AccountRow, type SortDir, type SortValue, cityOf, citySortKey, citySubtitle, leadingNumber, moneyValue, ratingSortValue } from '../lib/filters';
import { safeUrl } from '../lib/links';
import { STATUS_LABEL, statusRank } from '../lib/status';
import { TYPE_LABEL } from '../lib/stats';

export type AccountColumnId =
  | 'company'
  | 'rating'
  | 'segment'
  | 'city'
  | 'description'
  | 'website'
  | 'linkedin'
  | 'location'
  | 'employees'
  | 'finance'
  | 'revenue'
  | 'funding'
  | 'signal'
  | 'fit'
  | 'summary'
  | 'contacts'
  | 'status'
  | 'lastTouch'
  | 'sources';

export interface AccountColumn {
  id: AccountColumnId;
  label: string;
  width: number;
  num?: boolean;
  defaultVisible: boolean;
  alwaysVisible?: boolean;
  defaultDir: SortDir;
  title?: string;
  sort: (r: AccountRow) => SortValue;
  render: (r: AccountRow) => ReactNode;
}

const text = (v: string | undefined | null): ReactNode => (v ? v : <span className="muted">{DASH}</span>);

function Clamp({ value }: { value?: string }) {
  if (!value) return <span className="muted">{DASH}</span>;
  return (
    <span className="clamp-2" title={value.length > 80 ? value : undefined}>
      {value}
    </span>
  );
}

export function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const line = s.split(/\r?\n/).find((l) => l.trim());
  return line?.trim();
}

export function summaryOf(r: AccountRow): string | undefined {
  const a = r.account;
  return a.signalSummary ?? firstLine(a.signal) ?? firstLine(a.keySignals) ?? firstLine(a.serviceSignal);
}

/** Tooltip for a city cell: the raw location text, plus the basis when it isn't the company's own location. */
export function cityTitle(r: AccountRow): string | undefined {
  const a = r.account;
  const parts = [a.location, a.cityBasis && a.cityBasis !== 'Company location' ? `City basis: ${a.cityBasis}` : undefined].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

function CityCell({ row }: { row: AccountRow }) {
  const city = cityOf(row.account);
  if (!city) {
    return (
      <span className="muted" data-testid="city-cell" data-city="" title={cityTitle(row) ?? 'City unknown'}>
        {DASH}
      </span>
    );
  }
  const sub = citySubtitle(row.account);
  return (
    <div className="stack" data-testid="city-cell" data-city={city} title={cityTitle(row)}>
      <span className="clamp-1">{city}</span>
      {sub && <span className="sub clamp-1">{sub}</span>}
    </div>
  );
}

export const ACCOUNT_COLUMNS: readonly AccountColumn[] = [
  {
    id: 'company',
    label: 'Company',
    width: 260,
    defaultVisible: true,
    alwaysVisible: true,
    defaultDir: 'asc',
    sort: (r) => r.account.name.toLowerCase(),
    render: () => null, // rendered by the row (expand toggle)
  },
  {
    id: 'rating',
    label: 'Rating',
    width: 92,
    num: true,
    defaultVisible: true,
    defaultDir: 'desc',
    title: 'Sort by account rating (0-100) and grade A-D',
    sort: (r) => ratingSortValue(r.account),
    render: (r) => (
      <span title={r.account.ratingReasons.join('\n') || undefined}>
        <GradePill grade={r.account.grade} rating={r.account.rating} />
      </span>
    ),
  },
  {
    id: 'segment',
    label: 'Segment / Sector',
    width: 170,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => `${r.account.segment} ${r.account.sector ?? ''}`.toLowerCase(),
    render: (r) => (
      <div className="stack">
        <span>{r.account.segment}</span>
        {r.account.sector && <span className="sub clamp-1" title={r.account.sector}>{r.account.sector}</span>}
      </div>
    ),
  },
  {
    id: 'city',
    label: 'City',
    width: 160,
    defaultVisible: true,
    defaultDir: 'asc',
    title: 'City (suburb, state). Unknown sorts last.',
    sort: (r) => citySortKey(r.account),
    render: (r) => <CityCell row={r} />,
  },
  {
    id: 'description',
    label: 'Description',
    width: 260,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => r.account.description?.toLowerCase(),
    render: (r) => <Clamp value={r.account.description ?? r.account.typeReason} />,
  },
  {
    id: 'website',
    label: 'Website',
    width: 150,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => (r.account.website ?? r.account.domain)?.toLowerCase(),
    render: (r) => {
      const url = safeUrl(r.account.website ?? r.account.domain);
      return url ? <ExtLink href={url} className="clamp-1 link-subtle" /> : <span className="muted">{DASH}</span>;
    },
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    width: 88,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => (r.account.linkedin ? 0 : 1),
    render: (r) => <LinkedInLink href={r.account.linkedin} name={r.account.name} />,
  },
  {
    id: 'location',
    label: 'Location',
    width: 150,
    defaultVisible: false, // raw source text; the City column covers it
    title: 'Location as recorded in the source',
    defaultDir: 'asc',
    sort: (r) => r.account.location?.toLowerCase(),
    render: (r) => <span className="clamp-1" title={r.account.location}>{text(r.account.location)}</span>,
  },
  {
    id: 'employees',
    label: 'Employees',
    width: 96,
    num: true,
    defaultVisible: true,
    defaultDir: 'desc',
    sort: (r) => leadingNumber(r.account.employees ?? r.account.employeeRange),
    render: (r) => text(r.account.employees ?? r.account.employeeRange),
  },
  {
    id: 'finance',
    label: 'Finance HC',
    width: 104,
    num: true,
    defaultVisible: true,
    defaultDir: 'desc',
    title: 'Finance headcount',
    sort: (r) => r.account.financeHeadcount ?? null,
    render: (r) => (typeof r.account.financeHeadcount === 'number' ? r.account.financeHeadcount : <span className="muted">{DASH}</span>),
  },
  {
    id: 'revenue',
    label: 'Revenue / ARR',
    width: 130,
    defaultVisible: true,
    defaultDir: 'desc',
    sort: (r) => moneyValue(r.account.revenue ?? r.account.arr),
    render: (r) =>
      r.account.revenue || r.account.arr ? (
        <div className="stack">
          {r.account.revenue && <span className="clamp-1" title={r.account.revenue}>{r.account.revenue}</span>}
          {r.account.arr && <span className="sub clamp-1" title={`ARR ${r.account.arr}`}>ARR {r.account.arr}</span>}
        </div>
      ) : (
        <span className="muted">{DASH}</span>
      ),
  },
  {
    id: 'funding',
    label: 'Funding',
    width: 150,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => (r.account.funding ?? r.account.fundingStage)?.toLowerCase(),
    render: (r) => <Clamp value={r.account.funding ?? r.account.fundingStage} />,
  },
  {
    id: 'signal',
    label: 'Signal',
    width: 76,
    defaultVisible: true,
    defaultDir: 'desc',
    title: 'Signal score (1–5)',
    sort: (r) => r.account.signalScore ?? null,
    render: (r) => <ScorePill score={r.account.signalScore} />,
  },
  {
    id: 'fit',
    label: 'Fit',
    width: 64,
    defaultVisible: true,
    defaultDir: 'desc',
    title: 'Fit score (1–5) from the master prospect list',
    sort: (r) => r.account.fitScore ?? null,
    render: (r) => <ScorePill score={r.account.fitScore} label="Fit" />,
  },
  {
    id: 'summary',
    label: 'Signal summary',
    width: 280,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => summaryOf(r)?.toLowerCase(),
    render: (r) => <Clamp value={summaryOf(r)} />,
  },
  {
    id: 'contacts',
    label: 'Contacts',
    width: 80,
    num: true,
    defaultVisible: true,
    defaultDir: 'desc',
    sort: (r) => r.account.contacts.length,
    render: (r) => (r.account.contacts.length ? r.account.contacts.length : <span className="muted">0</span>),
  },
  {
    id: 'status',
    label: 'Outreach',
    width: 124,
    defaultVisible: true,
    defaultDir: 'desc',
    title: 'Derived from outreach events',
    sort: (r) => statusRank(r.activity.status),
    render: (r) => <StatusPill status={r.activity.status} />,
  },
  {
    id: 'lastTouch',
    label: 'Last touch',
    width: 108,
    defaultVisible: true,
    defaultDir: 'desc',
    sort: (r) => r.activity.lastTouch,
    render: (r) => <span className={r.activity.lastTouch ? '' : 'muted'}>{formatDate(r.activity.lastTouch)}</span>,
  },
  {
    id: 'sources',
    label: 'Sources',
    width: 190,
    defaultVisible: true,
    defaultDir: 'asc',
    sort: (r) => r.account.sources.join(',').toLowerCase(),
    render: (r) => <SourceBadges sources={r.account.sources} max={2} />,
  },
];

export const CSV_HEADERS = [
  'Account ID',
  'Company',
  'Rating',
  'Grade',
  'Section',
  'Segment',
  'Sector',
  'Domain',
  'Website',
  'LinkedIn',
  'Location',
  'City',
  'Suburb',
  'State',
  'Employees',
  'Finance headcount',
  'Revenue',
  'ARR',
  'Funding',
  'Funding stage',
  'Signal score',
  'Fit score',
  'Signal source',
  'Signal summary',
  'Why fit',
  'Description',
  'Contacts',
  'Contacts with email',
  'Outreach status',
  'Last touch',
  'In Attio',
  'Sources',
];

export function accountCsvRow(r: AccountRow): CsvValue[] {
  const a = r.account;
  return [
    a.id,
    a.name,
    a.rating,
    a.grade,
    TYPE_LABEL[a.type] ?? a.type,
    a.segment,
    a.sector,
    a.domain,
    a.website,
    a.linkedin,
    a.location,
    a.city,
    a.suburb,
    a.state,
    a.employees ?? a.employeeRange,
    a.financeHeadcount ?? null,
    a.revenue,
    a.arr,
    a.funding,
    a.fundingStage,
    a.signalScore ?? null,
    a.fitScore ?? null,
    a.signalSource,
    summaryOf(r),
    a.whyFit,
    a.description,
    a.contacts.length,
    a.contacts.filter((c) => !!c.email).length,
    STATUS_LABEL[r.activity.status],
    r.activity.lastTouch ? localISODate(r.activity.lastTouch) : '',
    a.inAttio,
    a.sources.join('; '),
  ];
}
