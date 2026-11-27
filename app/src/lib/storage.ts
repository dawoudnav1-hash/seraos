/** localStorage wrappers that never throw (private mode, blocked storage, quota, bad JSON). */

function getStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  const s = getStore();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Returns true on success. */
export function writeJSON(key: string, value: unknown): boolean {
  const s = getStore();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): boolean {
  const s = getStore();
  if (!s) return false;
  try {
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function storageAvailable(): boolean {
  const s = getStore();
  if (!s) return false;
  try {
    const k = '__seraos_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export const MANUAL_EVENTS_KEY = 'seraos.manualEvents.v1';
