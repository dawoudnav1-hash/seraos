import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Funnel, Meter, WeeklyChart } from '../components/charts';
import { EventLine } from '../components/events';
import { Icon, Segmented, EmptyState } from '../components/ui';
import { DATE_RANGES, type DateRange } from '../lib/events';
import { formatInt, formatRate, formatDateTime } from '../lib/format';
import { UNKNOWN } from '../lib/filters';
import { computeDashboardStats, OTHER_CITIES, type BreakdownRow, type CityRow } from '../lib/stats';
import { useAppData } from '../state/AppData';
import { accountsByCityHref } from '../state/router';
import { usePersistentState } from '../state/usePersistentState';

function Kpi({
  id,
  label,
  value,
  sub,
  hint,
  children,
}: {
  id: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="kpi" data-testid={`kpi-${id}`} aria-label={label}>
      <h3 className="kpi-label">{label}</h3>
      <div className="kpi-value" data-testid={`kpi-${id}-value`}>
        {value}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {children}
      {hint && (
        <div className="kpi-hint">
          <Icon name="alert" size={12} />
          <span>{hint}</span>
        </div>
      )}
    </section>
  );
}

function Card({ title, children, actions, className, testId }: { title: string; children: ReactNode; actions?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={'card' + (className ? ' ' + className : '')} data-testid={testId}>
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

function BreakdownTable({ rows, first }: { rows: BreakdownRow[]; first: string }) {
  if (!rows.length) return <EmptyState title="No accounts" />;
  return (
    <div className="mini-table-wrap">
      <table className="mini-table">
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col" className="num">Accounts</th>
            <th scope="col" className="num" title="Accounts with no outreach event at all, over all time (same as the Accounts view)">
              Not contacted
            </th>
            <th scope="col" className="num">Contacts</th>
            <th scope="col" className="num" title="Accounts with at least one event in the selected range">Touched</th>
            <th scope="col" className="num">Sent</th>
            <th scope="col" className="num">Replies</th>
            <th scope="col" className="num">Meetings</th>
            <th scope="col" className="num" title="Unique people who replied (and were messaged) ÷ unique people messaged">Reply rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="num">{formatInt(r.accounts)}</td>
              <td className="num" data-testid="not-contacted-cell">{formatInt(r.accountsNotContacted)}</td>
              <td className="num">{formatInt(r.contacts)}</td>
              <td className="num">
                {formatInt(r.accountsTouched)}
                <span className="muted small"> · {formatRate(r.accounts ? r.accountsTouched / r.accounts : null)}</span>
              </td>
              <td className="num">{formatInt(r.sent)}</td>
              <td className="num">{formatInt(r.replies)}</td>
              <td className="num">{formatInt(r.meetings)}</td>
              <td className="num">{formatRate(r.replyRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PctBar({ value, total }: { value: number; total: number }) {
  const rate = total > 0 ? value / total : null;
  return (
    <span className="pct">
      <span className="pct-bar" aria-hidden="true">
        <i style={{ width: `${Math.min(100, (rate ?? 0) * 100)}%` }} />
      </span>
      <span className="pct-val">{formatRate(rate)}</span>
    </span>
  );
}

function CityTable({ rows, total, range }: { rows: CityRow[]; total: CityRow; range: DateRange }) {
  if (!rows.length) return <EmptyState title="No accounts" />;
  const rangeLabel = DATE_RANGES.find((r) => r.id === range)?.label ?? range;
  const go = (r: CityRow) => {
    window.location.hash = accountsByCityHref(r.key);
  };
  const cells = (r: CityRow) => (
    <>
      <td className="num" data-testid="by-city-accounts">{formatInt(r.accounts)}</td>
      <td className="num">{formatInt(r.accountsContacted)}</td>
      <td className="num" data-testid="by-city-not-contacted">{formatInt(r.accountsNotContacted)}</td>
      <td className="num">
        <PctBar value={r.accountsContacted} total={r.accounts} />
      </td>
      <td className="num col-sep">{formatInt(r.contacts)}</td>
      <td className="num col-sep">{formatInt(r.sent)}</td>
      <td className="num">{formatInt(r.replies)}</td>
      <td className="num">{formatInt(r.meetings)}</td>
    </>
  );
  return (
    <div className="mini-table-wrap">
      <table className="mini-table city-table" data-testid="by-city-table">
        <thead>
          <tr className="group-head">
            <td />
            <th scope="colgroup" colSpan={4}>
              <span>Accounts · all time</span>
            </th>
            <td className="col-sep" />
            <th scope="colgroup" colSpan={3} className="col-sep">
              <span>Activity · {range === 'all' ? 'all time' : `last ${rangeLabel}`}</span>
            </th>
          </tr>
          <tr>
            <th scope="col">City</th>
            <th scope="col" className="num">Accounts</th>
            <th scope="col" className="num" title="Accounts with at least one outreach event (sent, connection, seen, replied or meeting), ever">
              Contacted
            </th>
            <th scope="col" className="num" title="Accounts with no outreach event at all, ever — same as the Accounts view">
              Not contacted
            </th>
            <th scope="col" className="num">% contacted</th>
            <th scope="col" className="num col-sep">Contacts</th>
            <th scope="col" className="num col-sep">Sent</th>
            <th scope="col" className="num">Replies</th>
            <th scope="col" className="num">Meetings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const linkable = r.key !== OTHER_CITIES;
            const name = r.key === UNKNOWN ? <span className="muted">Unknown</span> : r.label;
            return (
              <tr
                key={r.key}
                className={linkable ? 'clickable' : undefined}
                onClick={linkable ? (e) => !(e.target as HTMLElement).closest('a') && go(r) : undefined}
                data-testid="by-city-row"
                data-city={r.key}
              >
                <th scope="row">
                  {linkable ? (
                    <a href={accountsByCityHref(r.key)} title={`Show accounts in ${r.key === UNKNOWN ? 'an unknown city' : r.label}`}>
                      {name}
                    </a>
                  ) : (
                    <span title={r.cities.join(', ')}>{name}</span>
                  )}
                </th>
                {cells(r)}
              </tr>
            );
          })}
          <tr className="total" data-testid="by-city-total">
            <th scope="row">Total</th>
            {cells(total)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const RANGE_IDS = DATE_RANGES.map((r) => r.id);

export function Dashboard() {
  const { accounts, events, outreach, manualEvents, removeManualEvent, toast } = useAppData();
  const [range, setRange] = usePersistentState<DateRange>('seraos.dashboardRange.v1', 'all', (v) =>
    RANGE_IDS.includes(v as DateRange) ? (v as DateRange) : undefined,
  );
  // "now" ticks every minute so relative ranges stay correct on a long-open tab.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  // Also refresh "now" whenever events change (a just-logged event must fall inside "7d").
  useEffect(() => setNow(Date.now()), [events]);

  const s = useMemo(() => computeDashboardStats({ accounts, events, range, now }), [accounts, events, range, now]);
  const email = s.channels.find((c) => c.channel === 'email');
  const li = s.channels.find((c) => c.channel === 'linkedin');
  const cov = s.coverage;

  return (
    <div className="page dashboard">
      <div className="page-head">
        <div>
          <h1>Outreach dashboard</h1>
          <p className="page-sub">
            {formatInt(s.eventsInRange)} events in range
            {manualEvents.length > 0 && <> · {formatInt(manualEvents.length)} logged manually</>}
            {outreach.generatedAt && <> · data generated {formatDateTime(Date.parse(outreach.generatedAt))}</>}
          </p>
        </div>
        <Segmented
          label="Date range"
          value={range}
          onChange={setRange}
          options={DATE_RANGES.map((r) => ({ id: r.id, label: r.id === 'all' ? 'All' : r.id }))}
          testIdPrefix="range"
        />
      </div>

      <div className="kpis">
        <Kpi id="messages-sent" label="Messages sent" value={formatInt(s.sent)} sub={<>{formatInt(s.sentEmail)} email · {formatInt(s.sentLinkedin)} LinkedIn</>} />
        <Kpi
          id="seen"
          label="Seen / opened"
          value={formatInt(s.seen)}
          sub={s.sent > 0 && s.hasSeenTracking ? <>{formatRate(s.seen / s.sent)} of messages sent</> : undefined}
          hint={!s.hasSeenTracking ? <>No open-tracking data — log “Seen” manually</> : undefined}
        />
        <Kpi id="replies" label="Replies" value={formatInt(s.replies)} sub={<>from {formatInt(s.repliedPeople)} {s.repliedPeople === 1 ? 'person' : 'people'}</>} />
        <Kpi
          id="reply-rate"
          label="Reply rate"
          value={formatRate(s.replyRate)}
          sub={
            s.replyRate == null ? (
              <>Nobody messaged in this range</>
            ) : (
              <>
                {formatInt(s.repliedMessagedPeople)} of {formatInt(s.messagedPeople)} people messaged
              </>
            )
          }
        />
        <Kpi
          id="linkedin-connections"
          label="LinkedIn connections"
          value={
            <>
              {formatInt(s.connectionsSent)}
              <span className="kpi-sep">/</span>
              {formatInt(s.connectionsAccepted)}
            </>
          }
          sub={<>sent / accepted</>}
          hint={s.connectionsAccepted > s.connectionsSent ? <>Sent requests aren’t importable — log them manually</> : undefined}
        />
        <Kpi id="meetings" label="Meetings" value={formatInt(s.meetings)} />
        <Kpi
          id="accounts-touched"
          label="Accounts touched"
          value={
            <>
              {formatInt(s.accountsTouched)}
              <span className="kpi-of"> / {formatInt(s.totalAccounts)}</span>
            </>
          }
          sub={formatRate(s.totalAccounts ? s.accountsTouched / s.totalAccounts : null) + ' of accounts'}
        >
          <Meter value={s.accountsTouched} total={s.totalAccounts} />
        </Kpi>
        <Kpi
          id="contacts-reached"
          label="Contacts reached"
          value={
            <>
              {formatInt(s.contactsReached)}
              <span className="kpi-of"> / {formatInt(s.totalContacts)}</span>
            </>
          }
          sub={formatRate(s.totalContacts ? s.contactsReached / s.totalContacts : null) + ' of contacts'}
        >
          <Meter value={s.contactsReached} total={s.totalContacts} />
        </Kpi>
      </div>

      {(s.unmatchedEvents > 0 || s.undatedEvents > 0) && (
        <p className="note">
          <Icon name="alert" size={12} />
          {s.unmatchedEvents > 0 && (
            <>
              {formatInt(s.unmatchedEvents)} event{s.unmatchedEvents === 1 ? '' : 's'} in range could not be matched to an account or contact — they count
              in message totals but not in account/contact coverage.{' '}
            </>
          )}
          {s.undatedEvents > 0 && <>{formatInt(s.undatedEvents)} event(s) have no valid date and are excluded from the weekly chart.</>}
        </p>
      )}

      <div className="grid-2-1">
        <Card title="Weekly activity" testId="weekly-chart">
          <WeeklyChart weeks={s.weekly} />
        </Card>
        <Card title="Funnel (known contacts)">
          <Funnel stages={s.funnel} />
          <p className="card-foot muted small">Each stage counts contacts whose derived status reached at least that stage in the selected range.</p>
        </Card>
      </div>

      <div className="grid-2-1">
        <Card title="By channel">
          <div className="mini-table-wrap">
            <table className="mini-table" data-testid="channel-table">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col" className="num">Sent</th>
                  <th scope="col" className="num">Seen</th>
                  <th scope="col" className="num">Replied</th>
                  <th scope="col" className="num">Accepted</th>
                  <th scope="col" className="num">Meetings</th>
                  <th scope="col" className="num" title="Unique people who replied (and were messaged) ÷ unique people messaged on this channel">Rate</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Email', c: email, cls: 'email' },
                  { label: 'LinkedIn', c: li, cls: 'linkedin' },
                ].map(({ label, c, cls }) =>
                  c ? (
                    <tr key={label}>
                      <th scope="row">
                        <i className={`sw ${cls}`} aria-hidden="true" /> {label}
                      </th>
                      <td className="num">{formatInt(c.sent)}</td>
                      <td className="num">{formatInt(c.seen)}</td>
                      <td className="num">{formatInt(c.replies)}</td>
                      <td className="num">{cls === 'linkedin' ? formatInt(c.connectionsAccepted) : <span className="muted">n/a</span>}</td>
                      <td className="num">{formatInt(c.meetings)}</td>
                      <td className="num">{formatRate(c.replyRate)}</td>
                    </tr>
                  ) : null,
                )}
                <tr className="total">
                  <th scope="row">Total</th>
                  <td className="num">{formatInt(s.sent)}</td>
                  <td className="num">{formatInt(s.seen)}</td>
                  <td className="num">{formatInt(s.replies)}</td>
                  <td className="num">{formatInt(s.connectionsAccepted)}</td>
                  <td className="num">{formatInt(s.meetings)}</td>
                  <td className="num">{formatRate(s.replyRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="card-foot muted small">Rate = unique people who replied (and were messaged) ÷ unique people messaged. “—” means nobody was messaged.</p>
        </Card>
        <Card title="Data coverage" testId="coverage">
          <dl className="coverage">
            <div>
              <dt>Contacts with verified email</dt>
              <dd>
                {formatInt(cov.withVerifiedEmail)} <span className="muted">/ {formatInt(cov.totalContacts)}</span>
              </dd>
            </div>
            <div>
              <dt>Contacts with any email</dt>
              <dd>
                {formatInt(cov.withEmail)}
                {cov.withCautionEmail > 0 && <span className="muted small"> · {formatInt(cov.withCautionEmail)} caution</span>}
              </dd>
            </div>
            <div>
              <dt>Contacts with LinkedIn</dt>
              <dd>{formatInt(cov.withLinkedin)}</dd>
            </div>
            <div>
              <dt>Contacts flagged “likely left”</dt>
              <dd>{formatInt(cov.likelyLeft)}</dd>
            </div>
            <div>
              <dt>Accounts with no contact</dt>
              <dd>
                {formatInt(cov.accountsWithoutContacts)} <span className="muted">/ {formatInt(cov.totalAccounts)}</span>
              </dd>
            </div>
            <div>
              <dt>Accounts with no email address</dt>
              <dd>{formatInt(cov.accountsWithoutEmail)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <div className="grid-2 breakdowns">
        <Card title="By section">
          <BreakdownTable rows={s.byType} first="Section" />
        </Card>
        <Card title="By segment">
          <BreakdownTable rows={s.bySegment} first="Segment" />
        </Card>
      </div>
      <p className="card-foot muted small foot-wide">
        <b>Not contacted</b> = accounts with no outreach event of any kind, ever (imported or logged here) — it ignores the date range so it
        always matches the Accounts view. <b>Touched</b>, Sent, Replies and Meetings count events in the selected range.
      </p>

      <Card
        title="By city"
        testId="by-city"
        actions={
          <span className="muted small">
            {formatInt(s.accountsNotContacted)} of {formatInt(s.totalAccounts)} accounts not contacted yet
          </span>
        }
      >
        <CityTable rows={s.byCity} total={s.byCityTotal} range={range} />
        <p className="card-foot muted small">
          Contacted / Not contacted are <b>all time</b> (any event ever, incl. ones logged here), so they match the Accounts view whatever the
          range. Sent, Replies and Meetings respect the range; each event counts once, under the city of the account it was logged against
          (events matching no account are left out), so rows add up to the Total. “Other” sums the smaller cities — hover it to see which. A
          contact’s city is its account’s. Click a city to open its accounts.
        </p>
      </Card>

      <Card title="Recent activity" testId="recent-activity" actions={<span className="muted small">latest {Math.min(25, s.recent.length)}</span>}>
        {s.recent.length ? (
          <ul className="event-list">
            {s.recent.map((e) => (
              <EventLine
                key={e.id}
                event={e}
                index={s.index}
                now={now}
                onDelete={(ev) => {
                  removeManualEvent(ev.id);
                  toast({ message: 'Manual event deleted.' });
                }}
              />
            ))}
          </ul>
        ) : (
          <EmptyState title="No outreach in this range">Log activity from a contact on the Accounts tab.</EmptyState>
        )}
      </Card>
    </div>
  );
}
