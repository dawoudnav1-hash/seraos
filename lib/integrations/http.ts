/**
 * A tiny fetch wrapper both provider clients share: 429 backoff honoring
 * Retry-After, and a typed error for non-2xx responses. No retry-on-401
 * here — that needs a token refresh, which is provider-specific and lives
 * next to each client's auth config.
 */

import { sleep, type FetchLike } from './util';

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`Request to ${url} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface BackoffOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  /** How many 429 retries before giving up. */
  maxRetries?: number;
}

/** Parses a Retry-After header: seconds, or an HTTP date. Defaults to 1s. */
export function parseRetryAfterMs(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return 1000;
}

/** fetch() that retries a 429 after sleeping for the server's Retry-After. */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  opts: BackoffOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const maxRetries = opts.maxRetries ?? 4;
  let attempt = 0;
  for (;;) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    await sleepImpl(parseRetryAfterMs(res.headers.get('Retry-After')));
    attempt += 1;
  }
}

/** Throws ProviderHttpError for a non-2xx response; otherwise parses JSON. */
export async function readJsonOrThrow(res: Response, url: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new ProviderHttpError(res.status, text, url);
  if (!text) return {};
  return JSON.parse(text);
}
