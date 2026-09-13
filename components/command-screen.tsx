'use client';

import { useEffect, useMemo } from 'react';
import { LayoutGrid, Mail, Sparkles, Workflow } from 'lucide-react';
import { cn, greeting } from '@/lib/utils';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';
import { Sidebar } from './sidebar';
import { Board } from './board';
import { Overview } from './overview';
import { RunDrawer } from './run-drawer';
import { AskVert } from './ask-vert';

export function CommandScreen({ initialRuns }: { initialRuns: RunView[] }) {
  const { runs, snapshot, applyServerRun, setConnected, tab, setTab, openRunId, setPalette, toasts, dismissToast } = useBoard();

  useEffect(() => {
    snapshot(initialRuns);
  }, [initialRuns, snapshot]);

  // One SSE channel feeds the whole board; every payload is a server projection.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('snapshot', (e) => snapshot(JSON.parse((e as MessageEvent).data).runs));
    es.addEventListener('run', (e) => applyServerRun(JSON.parse((e as MessageEvent).data).run));
    es.addEventListener('error', () => setConnected(false));
    return () => es.close();
  }, [snapshot, applyServerRun, setConnected]);

  const list = useMemo(() => Object.values(runs).sort((a, b) => b.updatedAt - a.updatedAt), [runs]);
  const openRun = openRunId ? runs[openRunId] : null;
  const inboxCount = list.filter((r) => r.status === 'blocked' || r.status === 'review_ready').length;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar onNewChat={() => setPalette(true)} />

      <main className="flex min-w-0 flex-1 flex-col px-8 pt-7">
        <header className="mb-6 flex items-start justify-between gap-6">
          <h1 className="text-[30px] font-medium tracking-tight text-neutral-900">{greeting()}, Alex.</h1>
          <div className="flex shrink-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-4 py-2.5 text-[13.5px] font-medium text-neutral-800 shadow-sm transition hover:border-violet-300 hover:text-violet-700"
            >
              <Sparkles className="h-4 w-4 text-violet-500" />
              Ask Vert
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-4 py-2.5 text-[13.5px] font-medium text-neutral-800 shadow-sm transition hover:bg-neutral-50"
            >
              <Mail className="h-4 w-4 text-neutral-500" />
              Inbox ({inboxCount})
            </button>
          </div>
        </header>

        <div className="mb-5 border-b border-black/[0.07] pb-4">
          <div className="inline-flex items-center gap-1 rounded-xl bg-neutral-100/80 p-1">
            {([
              ['overview', 'Overview', LayoutGrid],
              ['workflows', 'Workflows', Workflow],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-4 py-2 text-[13.5px] transition',
                  tab === id ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800',
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 pb-6">{tab === 'workflows' ? <Board runs={list} /> : <Overview runs={list} />}</div>
      </main>

      {openRun && <RunDrawer run={openRun} />}
      <AskVert />

      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismissToast(t.id)}
            className={cn(
              'pointer-events-auto max-w-[520px] rounded-xl px-4 py-2.5 text-[13px] text-white shadow-lg',
              t.tone === 'error' ? 'bg-neutral-900' : 'bg-emerald-700',
            )}
          >
            {t.message}
          </button>
        ))}
      </div>
    </div>
  );
}
