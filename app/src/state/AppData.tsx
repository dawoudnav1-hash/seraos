import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LoadedData } from '../dataSource';
import { mergeEvents, newManualId, sanitizeEvents } from '../lib/events';
import { buildEventIndex, type EventIndex } from '../lib/status';
import { MANUAL_EVENTS_KEY, readJSON, storageAvailable, writeJSON } from '../lib/storage';
import type { OutreachEvent } from '../types';

export interface ToastMsg {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: 'info' | 'error';
}

export type NewManualEvent = Omit<OutreachEvent, 'id' | 'date' | 'source'> & { date?: string };

interface AppDataValue extends LoadedData {
  generatedEvents: OutreachEvent[];
  manualEvents: OutreachEvent[];
  /** generated + manual, de-duplicated by id */
  events: OutreachEvent[];
  /** index over ALL events (no date filter) — used for statuses in tables */
  index: EventIndex;
  storageOk: boolean;
  addManualEvent(e: NewManualEvent): OutreachEvent;
  removeManualEvent(id: string): void;
  importManualEvents(events: OutreachEvent[]): { added: number; skipped: number };
  clearManualEvents(): void;
  toast(t: Omit<ToastMsg, 'id'>): void;
  toasts: ToastMsg[];
  dismissToast(id: number): void;
}

const Ctx = createContext<AppDataValue | null>(null);

function loadManual(): OutreachEvent[] {
  return sanitizeEvents(readJSON<unknown>(MANUAL_EVENTS_KEY, [])).map((e) => ({ ...e, source: 'manual' }));
}

export function AppDataProvider({ data, children }: { data: LoadedData; children: ReactNode }) {
  const [manualEvents, setManualEvents] = useState<OutreachEvent[]>(loadManual);
  const [storageOk] = useState(storageAvailable);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  const skipWrite = useRef(true);

  // Persist on every change (but not the initial load, and not when the change came from another tab).
  useEffect(() => {
    if (skipWrite.current) {
      skipWrite.current = false;
      return;
    }
    writeJSON(MANUAL_EVENTS_KEY, manualEvents);
  }, [manualEvents]);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === MANUAL_EVENTS_KEY || ev.key === null) {
        skipWrite.current = true;
        setManualEvents(loadManual());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<ToastMsg, 'id'>) => {
      const id = ++toastId.current;
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
      window.setTimeout(() => dismissToast(id), 7000);
    },
    [dismissToast],
  );

  const addManualEvent = useCallback((e: NewManualEvent): OutreachEvent => {
    const now = Date.now();
    const full: OutreachEvent = { ...e, id: newManualId(now), date: e.date ?? new Date(now).toISOString(), source: 'manual' };
    setManualEvents((list) => [...list, full]);
    return full;
  }, []);

  const removeManualEvent = useCallback((id: string) => {
    setManualEvents((list) => list.filter((e) => e.id !== id));
  }, []);

  const generatedEvents = data.outreach.events;

  const importManualEvents = useCallback(
    (incoming: OutreachEvent[]) => {
      const existing = new Set([...generatedEvents.map((e) => e.id), ...manualEvents.map((e) => e.id)]);
      const fresh: OutreachEvent[] = [];
      for (const e of incoming) {
        if (existing.has(e.id)) continue;
        existing.add(e.id);
        fresh.push({ ...e, source: 'manual' });
      }
      if (fresh.length) setManualEvents((list) => [...list, ...fresh]);
      return { added: fresh.length, skipped: incoming.length - fresh.length };
    },
    [generatedEvents, manualEvents],
  );

  const clearManualEvents = useCallback(() => setManualEvents([]), []);

  const events = useMemo(() => mergeEvents(generatedEvents, manualEvents), [generatedEvents, manualEvents]);
  const index = useMemo(() => buildEventIndex(data.accounts, events), [data.accounts, events]);

  const value = useMemo<AppDataValue>(
    () => ({
      ...data,
      generatedEvents,
      manualEvents,
      events,
      index,
      storageOk,
      addManualEvent,
      removeManualEvent,
      importManualEvents,
      clearManualEvents,
      toast,
      toasts,
      dismissToast,
    }),
    [data, generatedEvents, manualEvents, events, index, storageOk, addManualEvent, removeManualEvent, importManualEvents, clearManualEvents, toast, toasts, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppDataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData must be used inside AppDataProvider');
  return v;
}
