/**
 * Small helpers shared by the OAuth, QuickBooks, Xero and posting modules.
 * Kept dependency-free (no fetch, no crypto) so every other file can import
 * from here without pulling in provider-specific code.
 */

import type { Cents } from '@/lib/engine/types';

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Cents -> a decimal dollar number with exactly two digits after the point,
 * built from the integer string representation so the conversion never goes
 * through a lossy float division (e.g. 100033 cents -> 1000.33, not
 * 1000.3300000000001). QBO and Xero both want a plain decimal number here.
 */
export function centsToDollars(cents: Cents): number {
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return sign * Number(`${dollars}.${String(rem).padStart(2, '0')}`);
}

/**
 * Decimal dollars (as returned by a provider API) -> integer cents. Rounds
 * through a fixed-point string first so binary-float artifacts (0.1 + 0.2
 * style) never leak into the cent count.
 */
export function dollarsToCents(amount: number): Cents {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(Number(amount.toFixed(2)) * 100);
}

export function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

/** Real timer by default; tests inject a synchronous stand-in. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchLike = typeof fetch;
