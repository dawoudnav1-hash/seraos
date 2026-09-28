'use client';

import { useEffect } from 'react';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';

/** One SSE channel feeds every screen; each payload is a server projection of the event log. */
export function LiveRuns({ initialRuns }: { initialRuns: RunView[] }) {
  const { snapshot, applyServerRun, setConnected } = useBoard();

  useEffect(() => {
    snapshot(initialRuns);
  }, [initialRuns, snapshot]);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('snapshot', (e) => snapshot(JSON.parse((e as MessageEvent).data).runs));
    es.addEventListener('run', (e) => applyServerRun(JSON.parse((e as MessageEvent).data).run));
    es.addEventListener('error', () => setConnected(false));
    return () => es.close();
  }, [snapshot, applyServerRun, setConnected]);

  return null;
}
