import { useEffect, useState } from 'react';

export type View = 'dashboard' | 'accounts' | 'contacts' | 'outreach' | 'settings';
export const VIEWS: readonly View[] = ['dashboard', 'accounts', 'contacts', 'outreach', 'settings'];

export interface Route {
  view: View;
  /** accounts/<accountId> or outreach/<accountId> */
  accountId?: string;
  /** ?contact=<contactId> highlight inside the account */
  contactId?: string;
  /** #/accounts?city=<city> — show All accounts filtered to that city (UNKNOWN = no city) */
  city?: string;
  /** increments on every hash change so repeated navigation to the same link is handled */
  nonce: number;
}

let nonce = 0;

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [pathPart = '', query = ''] = h.split('?');
  const [first = '', ...rest] = pathPart.split('/');
  const view = (VIEWS as readonly string[]).includes(first) ? (first as View) : 'dashboard';
  const route: Route = { view, nonce: ++nonce };
  if ((view === 'accounts' || view === 'outreach') && rest.length && rest[0]) {
    try {
      route.accountId = decodeURIComponent(rest.join('/'));
    } catch {
      route.accountId = rest.join('/');
    }
  }
  const params = new URLSearchParams(query);
  const c = params.get('contact');
  if (c) route.contactId = c;
  const city = params.get('city');
  if (city && view === 'accounts') route.city = city;
  return route;
}

export function accountHref(accountId: string, contactId?: string): string {
  return `#/accounts/${encodeURIComponent(accountId)}${contactId ? `?contact=${encodeURIComponent(contactId)}` : ''}`;
}

export function outreachHref(accountId?: string): string {
  return accountId ? `#/outreach/${encodeURIComponent(accountId)}` : '#/outreach';
}

export function accountsByCityHref(city: string): string {
  return `#/accounts?city=${encodeURIComponent(city)}`;
}

/** Updates the address bar without triggering navigation (keeps refresh-to-same-view working). */
export function replaceHash(hash: string): void {
  try {
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  } catch {
    /* sandboxed iframe etc. */
  }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
