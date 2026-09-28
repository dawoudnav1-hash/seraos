/**
 * OAuth 2.0 authorization-code flow, shared by the QuickBooks and Xero
 * clients: a signed+expiring `state` for the redirect round trip, token
 * encryption at rest, and the generic code<->token HTTP calls (both
 * providers speak plain RFC 6749 form-encoded token requests with HTTP
 * Basic client auth, so one implementation covers both).
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base64url, fromBase64url, type FetchLike } from './util';
import { readJsonOrThrow } from './http';

export type Provider = 'quickbooks' | 'xero';

// ---------------------------------------------------------------------------
// Encryption key handling
// ---------------------------------------------------------------------------

export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

/**
 * VERT_ENCRYPTION_KEY must decode (base64 or hex) to exactly 32 bytes — an
 * AES-256 key. Accepting either encoding is a small convenience; the length
 * check is what actually matters for AES-256-GCM.
 */
export function getEncryptionKey(raw = process.env.VERT_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new IntegrationConfigError(
      'VERT_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it before connecting an integration.',
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new IntegrationConfigError(
      `VERT_ENCRYPTION_KEY must decode to 32 bytes (AES-256); got ${key.length}. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Token encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp the access token expires at. */
  expiresAt: string;
  tokenType?: string;
  scope?: string;
}

const GCM_IV_BYTES = 12;

/** `v1.<iv>.<authTag>.<ciphertext>`, each segment base64url — a single opaque string to store in `tokensEnc`. */
export function encryptTokens(tokens: TokenSet, key: Buffer = getEncryptionKey()): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64url(iv)}.${base64url(tag)}.${base64url(ciphertext)}`;
}

export class TokenDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

export function decryptTokens(blob: string, key: Buffer = getEncryptionKey()): TokenSet {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new TokenDecryptionError('Malformed token blob.');
  }
  const [, ivPart, tagPart, ctPart] = parts;
  try {
    const iv = fromBase64url(ivPart);
    const tag = fromBase64url(tagPart);
    const ciphertext = fromBase64url(ctPart);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (err) {
    // Wrong key, corrupted blob, or a tampered auth tag all land here.
    throw new TokenDecryptionError(
      `Could not decrypt stored tokens: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function isExpired(tokens: TokenSet, skewMs = 60_000): boolean {
  return Date.parse(tokens.expiresAt) - Date.now() <= skewMs;
}

// ---------------------------------------------------------------------------
// Signed `state` for the authorize -> callback round trip
// ---------------------------------------------------------------------------

export interface OAuthStatePayload {
  provider: Provider;
  client: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

/** Signs {provider, client, nonce, exp} with HMAC-SHA256 over the JSON payload. */
export function signState(
  input: { provider: Provider; client: string; ttlSeconds?: number },
  key: Buffer = getEncryptionKey(),
): string {
  const payload: OAuthStatePayload = {
    provider: input.provider,
    client: input.client,
    nonce: randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 600),
  };
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', key).update(json).digest();
  return `${base64url(json)}.${base64url(sig)}`;
}

/** Verifies the signature (constant-time) and the expiry; throws OAuthStateError otherwise. */
export function verifyState(state: string, key: Buffer = getEncryptionKey()): OAuthStatePayload {
  const dot = state.indexOf('.');
  if (dot < 0) throw new OAuthStateError('Malformed state.');
  const payloadPart = state.slice(0, dot);
  const sigPart = state.slice(dot + 1);
  let json: string;
  let payload: OAuthStatePayload;
  try {
    json = fromBase64url(payloadPart).toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw new OAuthStateError('Malformed state.');
  }
  const expectedSig = createHmac('sha256', key).update(json).digest();
  let actualSig: Buffer;
  try {
    actualSig = fromBase64url(sigPart);
  } catch {
    throw new OAuthStateError('Malformed state signature.');
  }
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    throw new OAuthStateError('State signature does not match — the request may have been tampered with.');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new OAuthStateError('State has expired. Start the connection again.');
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Generic authorization-code <-> token HTTP (RFC 6749, form-encoded, Basic auth)
// ---------------------------------------------------------------------------

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

function parseTokenResponse(json: any): TokenSet {
  const expiresInSeconds = Number(json.expires_in ?? 3600);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    tokenType: json.token_type,
    scope: json.scope,
  };
}

export async function exchangeCodeForToken(
  config: OAuthClientConfig,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const res = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = await readJsonOrThrow(res, config.tokenUrl);
  return parseTokenResponse(json);
}

export async function refreshAccessToken(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = await readJsonOrThrow(res, config.tokenUrl);
  return parseTokenResponse(json);
}

export { basicAuthHeader };
