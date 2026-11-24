import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { EventLine } from '../components/events';
import { Badge, EmailLink, ExtLink, Icon, Linkify, LinkedInLink, ScorePill, SourceBadges, StatusPill } from '../components/ui';
import { kindLabel } from '../lib/events';
import { cityDisplay, cityOf, stateOf } from '../lib/filters';
import { formatDate } from '../lib/format';
import { displayUrl, safeUrl } from '../lib/links';
import { TYPE_LABEL } from '../lib/stats';
import { contactActivity, sortContacts, type EntityActivity } from '../lib/status';
import { useAppData, type NewManualEvent } from '../state/AppData';
import { accountHref } from '../state/router';
import type { Account, Contact, OutreachEvent } from '../types';

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={'field' + (wide ? ' wide' : '')}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Renders a text field only when it has a value. */
function TextField({ label, value, wide, pre }: { label: string; value?: string | null; wide?: boolean; pre?: boolean }) {
  if (!value || !value.trim()) return null;
  return (
    <Field label={label} wide={wide}>
      <span className={pre ? 'pre' : undefined}>
        <Linkify text={value} />
      </span>
    </Field>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={'detail-section' + (className ? ' ' + className : '')}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** "⚠ text" flags are shown as warnings; other flags as neutral notes. */
function Flags({ flags }: { flags?: string }) {
  if (!flags || !flags.trim()) return null;
  const lines = flags
    .split(/\r?\n|(?=⚠)/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="flags" data-testid="account-flags">
      {lines.map((l, i) => {
        const warn = l.startsWith('⚠');
        return (
          <div key={i} className={'flag' + (warn ? ' flag-warn' : '')} role={warn ? 'note' : undefined}>
            <Icon name="alert" size={13} />
            <span>
              <Linkify text={warn ? l.replace(/^⚠️?\s*/, '') : l} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

type QuickAction = { id: string; label: string; testId: string; make: (c: Contact, act: EntityActivity) => Pick<NewManualEvent, 'kind' | 'channel'> };

/** Channel for Seen/Replied/Meeting: the channel of the contact's most recent outbound event, else email if they have one. */
function inferChannel(c: Contact, act: EntityActivity): OutreachEvent['channel'] {
  const lastOutbound = act.events.find((e) => e.kind === 'sent' || e.kind === 'message_sent' || e.kind === 'connection_sent' || e.kind === 'connection_accepted');
  if (lastOutbound) return lastOutbound.channel;
  return c.email ? 'email' : 'linkedin';
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'email', label: 'Email sent', testId: 'log-email-sent', make: () => ({ kind: 'sent', channel: 'email' }) },
  { id: 'linkedin', label: 'LinkedIn sent', testId: 'log-linkedin-sent', make: () => ({ kind: 'message_sent', channel: 'linkedin' }) },
  {
    id: 'seen',
    label: 'Seen',
    testId: 'log-seen',
    make: (c, act) => {
      const ch = inferChannel(c, act);
      return { kind: ch === 'email' ? 'opened' : 'message_seen', channel: ch };
    },
  },
  { id: 'reply', label: 'Replied', testId: 'log-replied', make: (c, act) => ({ kind: 'reply', channel: inferChannel(c, act) }) },
  { id: 'meeting', label: 'Meeting', testId: 'log-meeting', make: (c, act) => ({ kind: 'meeting', channel: inferChannel(c, act) }) },
];

function ContactRow({ contact: c, account, highlight, colCount }: { contact: Contact; account: Account; highlight: boolean; colCount: number }) {
  const { index, addManualEvent, removeManualEvent, toast } = useAppData();
  const act = contactActivity(index, c.id);
  const [showHistory, setShowHistory] = useState(false);
  const ref = useRef<HTMLTableRowElement>(null);
  const historyId = `hist-${c.id}`;
  const last = act.events[0];

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);

  const log = (qa: QuickAction) => {
    const base = qa.make(c, act);
    const e = addManualEvent({
      ...base,
      accountId: account.id,
      contactId: c.id,
      personName: c.name,
      ...(c.email && base.channel === 'email' ? { counterpartyEmails: [c.email] } : {}),
    });
    toast({ message: `Logged “${kindLabel(e)}” for ${c.name}.`, actionLabel: 'Undo', onAction: () => removeManualEvent(e.id) });
  };

  const del = (e: OutreachEvent) => {
    removeManualEvent(e.id);
    toast({ message: `Deleted “${kindLabel(e)}” for ${c.name}.` });
  };

  return (
    <>
      <tr ref={ref} className={'contact-row' + (c.likelyLeft ? ' left' : '') + (highlight ? ' highlight' : '')} data-testid="contact-row" data-contact-id={c.id}>
        <td>
          <div className="contact-name">
            <span className="name">{c.name}</span>
            <span className="badges">
              {c.isPrimary && <Badge tone="primary">Primary</Badge>}
              {c.inAttio && <Badge tone="attio">Attio</Badge>}
              {c.priority && <Badge>{c.priority}</Badge>}
            </span>
          </div>
          {c.likelyLeft && (
            <div className="left-note">
              <Badge tone="warn">Likely left</Badge>
              {c.notes && <span>{c.notes}</span>}
            </div>
          )}
          {!c.likelyLeft && c.notes && <div className="sub">{c.notes}</div>}
        </td>
        <td>
          <div className="stack">
            <span>{c.title ?? <span className="muted">—</span>}</span>
            {c.roleType && <span className="sub">{c.roleType}</span>}
          </div>
        </td>
        <td>
          <div className="stack">
            <span className="email-cell">
              <EmailLink email={c.email} />
              {c.email && c.emailRisk === 'caution' && (
                <Badge tone="caution" title={c.emailStatus ?? 'Unconfirmed email'}>
                  caution
                </Badge>
              )}
            </span>
            {c.email && c.emailStatus && <span className="sub clamp-1" title={c.emailStatus}>{c.emailStatus}</span>}
          </div>
        </td>
        <td className="center">
          <LinkedInLink href={c.linkedin} name={c.name} />
        </td>
        <td>
          <div className="stack">
            <span>{c.location ?? <span className="muted">—</span>}</span>
            {c.inRoleSince && <span className="sub">in role since {c.inRoleSince}</span>}
          </div>
        </td>
        <td>
          <SourceBadges sources={c.sources} max={2} />
        </td>
        <td>
          <div className="stack">
            <StatusPill status={act.status} />
            {last ? (
              <button
                type="button"
                className="link-btn sub"
                aria-expanded={showHistory}
                aria-controls={historyId}
                onClick={() => setShowHistory((s) => !s)}
                data-testid="toggle-history"
              >
                {kindLabel(last)} · {formatDate(Date.parse(last.date))} · {act.events.length} event{act.events.length === 1 ? '' : 's'}
              </button>
            ) : (
              <span className="sub">No events</span>
            )}
          </div>
        </td>
        <td>
          <div className="quick-actions" role="group" aria-label={`Log outreach for ${c.name}`}>
            {QUICK_ACTIONS.map((qa) => (
              <button key={qa.id} type="button" className={`qa qa-${qa.id}`} onClick={() => log(qa)} data-testid={qa.testId} title={`Log “${qa.label}” now`}>
                {qa.label}
              </button>
            ))}
          </div>
        </td>
      </tr>
      {showHistory && act.events.length > 0 && (
        <tr className="history-row" id={historyId}>
          <td colSpan={colCount}>
            <ul className="event-list compact">
              {act.events.map((e) => (
                <EventLine key={e.id} event={e} index={index} showAccount={false} showPerson={false} onDelete={del} />
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export const AccountDetail = memo(function AccountDetail({
  account: a,
  activity,
  highlightContactId,
}: {
  account: Account;
  activity: EntityActivity;
  highlightContactId?: string;
}) {
  const { index, removeManualEvent, toast } = useAppData();
  const contacts = sortContacts(a.contacts);
  const sourceUrls = (a.sourceUrls ?? []).map((u) => safeUrl(u)).filter((u): u is string => !!u);
  const website = safeUrl(a.website ?? a.domain);
  const hasFinance = a.financeHeadcount != null || a.headcountBasis || a.cfo || a.financeTeam || a.founder || a.decisionMaker;
  const contactCols = 8;

  return (
    <div className="detail" data-testid="account-detail" data-account-id={a.id}>
      <div className="detail-head">
        <div>
          <div className="detail-title">
            <h2>{a.name}</h2>
            <StatusPill status={activity.status} />
            <Badge tone={`type-${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</Badge>
            {a.inAttio && <Badge tone="attio">In Attio</Badge>}
            {a.otherAttioIds && a.otherAttioIds.length > 0 && (
              <Badge tone="warn" title={`Merged Attio records: ${a.otherAttioIds.join(', ')}`}>
                Attio duplicate ×{a.otherAttioIds.length + 1}
              </Badge>
            )}
          </div>
          {a.typeReason && <p className="sub">{a.typeReason}</p>}
        </div>
        <div className="detail-links">
          {website && (
            <ExtLink href={website} className="btn btn-sm">
              <Icon name="globe" /> {displayUrl(website)}
            </ExtLink>
          )}
          {safeUrl(a.linkedin) && (
            <ExtLink href={a.linkedin} className="btn btn-sm">
              <Icon name="linkedin" /> LinkedIn
            </ExtLink>
          )}
          <a className="btn btn-sm" href={accountHref(a.id)} title="Permalink to this account">
            <Icon name="link" /> Link
          </a>
        </div>
      </div>

      <Flags flags={a.flags} />

      <div className="detail-grid">
        <Section title="Overview">
          <dl className="fields">
            <TextField label="Description" value={a.description} wide />
            <Field label="Segment">{a.segment}</Field>
            <TextField label="Sector" value={a.sector} />
            {(cityOf(a) || stateOf(a)) && (
              <Field label="City">
                <span data-testid="account-city">{cityDisplay(a) || <span className="muted">Unknown{stateOf(a) ? ` (${stateOf(a)})` : ''}</span>}</span>
                {a.cityBasis && a.cityBasis !== 'Company location' && (
                  <span className="field-note" data-testid="account-city-basis">
                    Based on: {a.cityBasis}
                  </span>
                )}
              </Field>
            )}
            <TextField label="Location" value={a.location} />
            {(a.employees || a.employeeRange) && (
              <Field label="Employees">
                {a.employees ?? a.employeeRange}
                {a.employees && a.employeeRange && a.employeeRange !== a.employees && <span className="muted"> ({a.employeeRange})</span>}
              </Field>
            )}
            <TextField label="Founded" value={a.founded} />
            {website && (
              <Field label="Website">
                <ExtLink href={website} />
              </Field>
            )}
            {safeUrl(a.linkedin) && (
              <Field label="LinkedIn">
                <ExtLink href={a.linkedin} />
              </Field>
            )}
            {a.otherDomains && a.otherDomains.length > 0 && <Field label="Other domains">{a.otherDomains.join(', ')}</Field>}
            <Field label="Sources">
              <SourceBadges sources={a.sources} max={6} />
            </Field>
          </dl>
        </Section>

        <Section title="Alpha / signal" className="span-2">
          <div className="score-row">
            <span className="score-item">
              <span className="muted">Signal</span> <ScorePill score={a.signalScore} />
            </span>
            <span className="score-item">
              <span className="muted">Fit</span> <ScorePill score={a.fitScore} label="Fit" />
            </span>
            {a.fitConfidence && (
              <span className="score-item">
                <span className="muted">Fit confidence</span> <Badge>{a.fitConfidence}</Badge>
              </span>
            )}
            {a.icpStatus && (
              <span className="score-item">
                <span className="muted">ICP</span> <Badge>{a.icpStatus}</Badge>
              </span>
            )}
            {a.listStatus && (
              <span className="score-item">
                <span className="muted">List status</span> <Badge>{a.listStatus}</Badge>
              </span>
            )}
          </div>
          {a.signal ? (
            <div className="signal-text">
              <div className="provenance">Signal{a.signalSource ? ` · source: ${a.signalSource}` : ''}</div>
              <div className="pre" data-testid="signal-text">
                <Linkify text={a.signal} />
              </div>
            </div>
          ) : (
            a.signalSummary && (
              <div className="signal-text">
                <div className="provenance">Signal summary{a.signalSource ? ` · source: ${a.signalSource}` : ''}</div>
                <div className="pre">{a.signalSummary}</div>
              </div>
            )
          )}
          <dl className="fields">
            <TextField label="Why fit" value={a.whyFit} wide pre />
            <TextField label="Key signals" value={a.keySignals} wide pre />
            <TextField label="Service signal" value={a.serviceSignal} wide pre />
            {a.services && a.services.length > 0 && (
              <Field label="Services" wide>
                <span className="chips">
                  {a.services.map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </span>
              </Field>
            )}
            <TextField label="Tech stack" value={a.techStack} wide />
            <TextField label="Funding" value={a.funding} />
            <TextField label="Funding stage" value={a.fundingStage} />
            <TextField label="Valuation" value={a.valuation} />
            <TextField label="Revenue" value={a.revenue} />
            <TextField label="ARR" value={a.arr} />
            <TextField label="Growth" value={a.growth} />
            <TextField label="Notes" value={a.notes} wide pre />
            {sourceUrls.length > 0 && (
              <Field label="Research sources" wide>
                <ul className="source-links">
                  {sourceUrls.map((u) => (
                    <li key={u}>
                      <ExtLink href={u} />
                    </li>
                  ))}
                </ul>
              </Field>
            )}
          </dl>
        </Section>

        <Section title="Finance team">
          {hasFinance ? (
            <dl className="fields">
              {a.financeHeadcount != null && (
                <Field label="Finance headcount" wide>
                  <b>{a.financeHeadcount}</b>
                  {a.headcountBasis && <span className="muted"> — {a.headcountBasis}</span>}
                </Field>
              )}
              {a.financeHeadcount == null && <TextField label="Headcount basis" value={a.headcountBasis} wide />}
              <TextField label="CFO" value={a.cfo} wide />
              <TextField label="Decision maker" value={a.decisionMaker} wide />
              <TextField label="Finance team" value={a.financeTeam} wide pre />
              <TextField label="Founder" value={a.founder} wide />
            </dl>
          ) : (
            <p className="muted">No finance-team data.</p>
          )}
        </Section>
      </div>

      <Section title={`Contacts (${a.contacts.length})`} className="contacts-section">
        {contacts.length ? (
          <div className="sub-table-wrap">
            <table className="sub-table" data-testid="contacts-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Title / role</th>
                  <th scope="col">Email</th>
                  <th scope="col" className="center">LinkedIn</th>
                  <th scope="col">Location</th>
                  <th scope="col">Sources</th>
                  <th scope="col">Outreach</th>
                  <th scope="col">Log now</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <ContactRow key={c.id} contact={c} account={a} highlight={c.id === highlightContactId} colCount={contactCols} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No contacts for this account yet.</p>
        )}
      </Section>

      <Section title={`Timeline (${activity.events.length})`}>
        {activity.events.length ? (
          <ul className="event-list compact" data-testid="account-timeline">
            {activity.events.map((e) => (
              <Fragment key={e.id}>
                <EventLine
                  event={e}
                  index={index}
                  showAccount={false}
                  onDelete={(ev) => {
                    removeManualEvent(ev.id);
                    toast({ message: `Deleted “${kindLabel(ev)}”.` });
                  }}
                />
              </Fragment>
            ))}
          </ul>
        ) : (
          <p className="muted">No outreach logged for this account.</p>
        )}
      </Section>
    </div>
  );
});
