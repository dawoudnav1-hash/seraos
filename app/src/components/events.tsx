import type { OutreachEvent } from '../types';
import { eventTime, isManualEvent, kindLabel } from '../lib/events';
import { formatDateTime, relativeTime } from '../lib/format';
import type { EventIndex } from '../lib/status';
import { accountHref } from '../state/router';
import { useAppData } from '../state/AppData';
import { Icon } from './ui';

function kindIcon(e: OutreachEvent) {
  switch (e.kind) {
    case 'reply':
      return 'reply' as const;
    case 'opened':
    case 'message_seen':
      return 'eye' as const;
    case 'meeting':
      return 'calendar' as const;
    case 'connection_sent':
    case 'connection_accepted':
      return 'user' as const;
    default:
      return e.channel === 'linkedin' ? ('linkedin' as const) : ('send' as const);
  }
}

/** Display name of the person an event is with. */
export function eventPerson(e: OutreachEvent, index: EventIndex): string {
  const cids = index.eventContacts.get(e.id) ?? [];
  const c = cids.length ? index.contactById.get(cids[0]!) : undefined;
  return c?.name ?? e.personName ?? e.counterpartyEmails?.[0] ?? 'Unknown recipient';
}

export function eventAccountId(e: OutreachEvent, index: EventIndex): string | undefined {
  return (index.eventAccounts.get(e.id) ?? [])[0];
}

export function EventLine({
  event,
  index,
  showAccount = true,
  showPerson = true,
  onDelete,
  now,
}: {
  event: OutreachEvent;
  index: EventIndex;
  showAccount?: boolean;
  showPerson?: boolean;
  onDelete?: (e: OutreachEvent) => void;
  now?: number;
}) {
  const t = eventTime(event);
  const aid = eventAccountId(event, index);
  const account = aid ? index.accountById.get(aid) : undefined;
  const manual = isManualEvent(event);
  const text = event.subject ?? event.snippet;
  return (
    <li className={`event kind-${event.kind} ch-${event.channel}`} data-testid="event-line" data-event-id={event.id}>
      <span className={`event-icon ch-${event.channel}`} aria-hidden="true">
        <Icon name={kindIcon(event)} size={12} />
      </span>
      <div className="event-main">
        <div className="event-head">
          <span className="event-kind">{kindLabel(event)}</span>
          {showPerson && <span className="event-person">{eventPerson(event, index)}</span>}
          {showAccount &&
            (account ? (
              <a className="event-account" href={accountHref(account.id)}>
                {account.name}
              </a>
            ) : (
              <span className="event-account muted">No matching account</span>
            ))}
        </div>
        {text && (
          <div className="event-text" title={event.snippet && event.subject ? event.snippet : undefined}>
            {text}
          </div>
        )}
      </div>
      <div className="event-meta">
        <time dateTime={t != null ? new Date(t).toISOString() : undefined} title={formatDateTime(t)}>
          {relativeTime(t, now)}
        </time>
        <span className={'src' + (manual ? ' src-manual' : '')}>{event.source === 'page-send' ? 'sent from page' : manual ? 'manual' : event.source}</span>
        {manual && onDelete && (
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => onDelete(event)}
            aria-label={`Delete manual event: ${kindLabel(event)}`}
            title="Delete this manual event"
            data-testid="delete-event"
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useAppData();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast' + (t.tone === 'error' ? ' toast-error' : '')}>
          <span>{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.onAction?.();
                dismissToast(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
