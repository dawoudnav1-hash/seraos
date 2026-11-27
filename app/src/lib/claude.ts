/**
 * The page's runtime capabilities on claude.ai (`sample` = ask Claude, `mcp` = the viewer's connectors).
 * Both resolve null when the page runs anywhere else (local dev, opened from disk) — design for absence.
 * Types are the subset of artifact-capabilities' sample.d.ts / mcp.d.ts this app uses.
 */

export interface SampleOptions {
  signal?: AbortSignal;
  modelTier?: 'default' | 'complex' | 'quick';
  cache?: boolean;
}
export interface SampleApi {
  json<T = unknown>(input: string, options?: SampleOptions): Promise<T>;
}
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  payload?: unknown;
}
export interface McpApi {
  callTool(server: string, tool: string, input?: unknown, options?: { cache?: false; signal?: AbortSignal }): Promise<McpCallResult>;
}

type HostedClaude = { use?: (name: string) => Promise<unknown> };

async function useCapability(name: string): Promise<unknown> {
  try {
    const c = (window as unknown as { claude?: HostedClaude }).claude;
    if (!c || typeof c.use !== 'function') return null;
    return (await c.use(name)) ?? null;
  } catch {
    return null;
  }
}

export async function getSample(): Promise<SampleApi | null> {
  const s = (await useCapability('sample')) as SampleApi | null;
  return s && typeof s.json === 'function' ? s : null;
}

export async function getMcp(): Promise<McpApi | null> {
  const m = (await useCapability('mcp')) as McpApi | null;
  return m && typeof m.callTool === 'function' ? m : null;
}

export const MAIL_SERVER = 'Hostinger Mail';

export function errorCode(e: unknown): string {
  return e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'upstream_error';
}
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return e instanceof Error ? e.message : String(e ?? '');
}

/* ---------------- sample errors (sample.d.ts SampleErrorCode) ---------------- */

export interface SampleErrorInfo {
  /** hide drafting for the rest of this view */
  hide: boolean;
  /** what to tell the owner ('' = nothing, e.g. cancelled) */
  message: string;
  /** offer "Try again" */
  retry: boolean;
}

export function sampleErrorInfo(e: unknown): SampleErrorInfo {
  const code = errorCode(e);
  switch (code) {
    case 'cancelled':
      return { hide: false, message: '', retry: true };
    case 'not_granted':
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
    case 'images_unavailable':
    case 'tools_unavailable':
      return { hide: true, message: 'Drafting with Claude is not available on this page.', retry: false };
    case 'rate_limited':
      return {
        hide: false,
        message: (e as { reason?: string }).reason === 'usage_limit' ? 'You have reached your Claude usage limit — try again later.' : 'Claude is busy for this page right now — wait a minute, then try again.',
        retry: true,
      };
    case 'session_expired':
      return { hide: false, message: 'Your claude.ai session expired — sign in again, then retry.', retry: true };
    case 'invalid_json':
      return { hide: false, message: 'Claude’s reply was not a usable draft. Try again.', retry: true };
    case 'refused':
      return { hide: false, message: 'Claude declined to write this draft. Edit the facts or write it by hand.', retry: false };
    case 'empty_completion':
      return { hide: false, message: 'Claude returned nothing. Try again later or write it by hand.', retry: true };
    case 'prompt_too_large':
      return { hide: false, message: 'The prompt is too large for Claude (too many facts).', retry: false };
    case 'queue_overflow':
    case 'invalid_request':
    case 'transform_error':
      return { hide: false, message: 'The draft request was rejected by the page runtime.', retry: false };
    default:
      return { hide: false, message: 'Claude could not draft this right now. Try again.', retry: true };
  }
}

/* ---------------- mcp errors (mcp.d.ts McpErrorCode) ---------------- */

export interface McpErrorInfo {
  message: string;
  /** the email may have been sent: check the Sent folder before retrying */
  ambiguous: boolean;
  /** the mail connector cannot work in this view */
  unavailable: boolean;
}

export function mcpErrorInfo(e: unknown, write: boolean): McpErrorInfo {
  const code = errorCode(e);
  const msg = errorMessage(e);
  switch (code) {
    case 'needs_reauth':
      return { message: `Reconnect ${MAIL_SERVER} in claude.ai Settings → Connectors, then try again.`, ambiguous: false, unavailable: false };
    case 'server_not_connected':
    case 'server_not_found':
    case 'selection_required':
      return { message: `Add ${MAIL_SERVER} in claude.ai Settings → Connectors, then try again.`, ambiguous: false, unavailable: false };
    case 'not_in_manifest':
    case 'approval_required':
    case 'consent_required':
      return { message: `Allow ${MAIL_SERVER} for this page, then try again.`, ambiguous: false, unavailable: false };
    case 'blocked_by_policy':
      return { message: `Your organization blocks ${MAIL_SERVER} for this page.`, ambiguous: false, unavailable: true };
    case 'tool_error':
      return { message: `${MAIL_SERVER} reported an error: ${msg || 'unknown error'}`, ambiguous: false, unavailable: false };
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return { message: `${MAIL_SERVER} is not available on this page.`, ambiguous: false, unavailable: true };
    case 'bad_request':
    case 'transform_error':
      return { message: `The request to ${MAIL_SERVER} was rejected: ${msg}`, ambiguous: false, unavailable: false };
    case 'user_changed':
      return { message: 'The signed-in account changed — reload the page.', ambiguous: false, unavailable: true };
    case 'rate_limited':
      return { message: 'Too many mail requests — wait a few seconds, then try again.', ambiguous: false, unavailable: false };
    case 'cancelled':
    case 'server_unavailable':
    case 'upstream_error':
    default:
      return write
        ? { message: 'Not sure if it sent — check your Sent folder before retrying.', ambiguous: true, unavailable: false }
        : { message: `${MAIL_SERVER} did not answer. Try again in a moment.`, ambiguous: false, unavailable: false };
  }
}
