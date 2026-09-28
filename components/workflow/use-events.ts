'use client';

import { useEffect, useState } from 'react';

export interface LoggedEvent {
  seq: number;
  type: string;
  at: number;
  payload: Record<string, unknown>;
}

/** The raw event log behind a run, refetched whenever the projection moves. */
export function useRunEvents(runId: string, version: number): LoggedEvent[] {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/runs/${runId}/events`)
      .then((r) => r.json())
      .then((d: { events: LoggedEvent[] }) => alive && setEvents(d.events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [runId, version]);
  return events;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
