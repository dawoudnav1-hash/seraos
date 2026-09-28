/** Resolves the `[provider]` route segment to a typed Provider, or null for a 404. */

import type { Provider } from './store';

export function resolveProvider(value: string): Provider | null {
  if (value === 'quickbooks' || value === 'xero') return value;
  return null;
}
