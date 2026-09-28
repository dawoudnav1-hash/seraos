import type { CheckResult, SourceRef } from '@/lib/engine/types';
import type { Artifact } from '@/lib/domain/types';
import type { Proposal } from './types';

/**
 * Deterministic replay: a node's verified result is stored under a hash of
 * (node id, fingerprint, client, input), so re-running an unchanged node is free.
 */

export interface CachedNode {
  output: unknown;
  checks: CheckResult[];
  proposals: Proposal[];
  sources: SourceRef[];
  artifacts: Artifact[];
  attempts: number;
  storedAt: number;
}

/** Injectable store. Postgres, Redis or memory all fit. */
export interface ReplayCache {
  get(key: string): Promise<CachedNode | undefined> | CachedNode | undefined;
  set(key: string, value: CachedNode): Promise<void> | void;
}

export class MemoryReplayCache implements ReplayCache {
  private readonly store = new Map<string, CachedNode>();
  hits = 0;
  misses = 0;

  get(key: string): CachedNode | undefined {
    const v = this.store.get(key);
    if (v) this.hits++;
    else this.misses++;
    // Clone so a caller mutating a replayed output cannot corrupt the cache.
    return v ? structuredClone(v) : undefined;
  }

  set(key: string, value: CachedNode): void {
    this.store.set(key, structuredClone(value));
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * JSON-like serialization with sorted keys, so logically equal inputs hash the
 * same regardless of key order. Undefined object fields are dropped, as in JSON.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'undefined':
        return 'undefined';
      case 'number':
        return Number.isFinite(v) ? JSON.stringify(v) : `#${String(v)}`;
      case 'bigint':
        return `${v}n`;
      case 'string':
      case 'boolean':
        return JSON.stringify(v);
      case 'function':
      case 'symbol':
        throw new TypeError(`Cannot hash a ${typeof v}; node inputs must be plain data.`);
    }
    const obj = v as object;
    if (obj instanceof Date) return `D${obj.toISOString()}`;
    if (seen.has(obj)) throw new TypeError('Cannot hash a circular structure.');
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map(walk).join(',')}]`;
    } else if (obj instanceof Map) {
      const entries = [...obj.entries()].map(([k, x]) => `${walk(k)}=>${walk(x)}`).sort();
      out = `M{${entries.join(',')}}`;
    } else if (obj instanceof Set) {
      out = `S[${[...obj].map(walk).sort().join(',')}]`;
    } else {
      const rec = obj as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k])}`).join(',')}}`;
    }
    seen.delete(obj);
    return out;
  };
  return walk(value);
}

/** SHA-256 via Web Crypto, so the runtime has no Node-only imports. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ReplayKeyParts {
  nodeId: string;
  /** Runnable fingerprint: its id@version plus the versions of everything it composes. */
  fingerprint: string;
  client: string;
  input: unknown;
}

/** Client is part of the key: two clients with the same input must never share a result. */
export function replayKey(parts: ReplayKeyParts): Promise<string> {
  return sha256Hex(stableStringify(parts));
}
