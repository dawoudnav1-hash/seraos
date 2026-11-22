import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Funnel, Meter, WeeklyChart } from '../components/charts';
import { EventLine } from '../components/events';
import { Icon, Segmented, EmptyState } from '../components/ui';
import { DATE_RANGES, type DateRange } from '../lib/events';
import { formatInt, formatRate, formatDateTime } from '../lib/format';
import { computeDashboardStats, type BreakdownRow } from '../lib/stats';
import { useAppData } from '../state/AppData';
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
            <th scope="col" className="num">Contacts</th>
            <th scope="col" className="num">Touched</th>
            <th scope="col" className="num">Sent</th>
            <th scope="col" className="num">Replies</th>
            <th scope="col" className="num">Meetings</th>
            <th scope="col" className="num" title="Unique people who replied ÷ unique people messaged">Reply rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="num">{formatInt(r.accounts)}</td>
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
                {formatInt(s.repliedPeople)} of {formatInt(s.messagedPeople)} people messaged
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
                  <th scope="col" className="num" title="Unique people who replied ÷ unique people messaged on this channel">Rate</th>
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
          <p className="card-foot muted small">Rate = unique people who replied ÷ unique people messaged. “—” means nobody was messaged.</p>
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

      <div className="grid-2">
        <Card title="By section">
          <BreakdownTable rows={s.byType} first="Section" />
        </Card>
        <Card title="By segment">
          <BreakdownTable rows={s.bySegment} first="Segment" />
        </Card>
      </div>

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
