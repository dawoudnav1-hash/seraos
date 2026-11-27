import { useEffect, useRef, useState } from 'react';
import { readJSON, writeJSON } from '../lib/storage';

/**
 * useState persisted to localStorage (UI preferences only). `validate` turns whatever was stored
 * into a safe value; storage failures silently fall back to in-memory state.
 */
export function usePersistentState<T>(key: string, initial: T, validate: (raw: unknown) => T | undefined) {
  const [value, setValue] = useState<T>(() => {
    const raw = readJSON<unknown>(key, undefined);
    if (raw === undefined) return initial;
    try {
      const v = validate(raw);
      return v === undefined ? initial : v;
    } catch {
      return initial;
    }
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    writeJSON(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}
