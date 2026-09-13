'use client';

import { create } from 'zustand';
import type { RunEvent } from '@/lib/domain/reducer';
import type { RunStatus, RunView } from '@/lib/domain/types';

export interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'ok';
}

interface BoardState {
  runs: Record<string, RunView>;
  connected: boolean;
  openRunId: string | null;
  paletteOpen: boolean;
  toasts: Toast[];
  tab: 'overview' | 'workflows';
  setTab(tab: 'overview' | 'workflows'): void;
  snapshot(runs: RunView[]): void;
  /** Runs arrive already projected from the event log — the client keeps no state of its own. */
  applyServerRun(run: RunView, event?: RunEvent): void;
  openRun(id: string | null): void;
  setPalette(open: boolean): void;
  setConnected(c: boolean): void;
  toast(message: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  act(id: string, body: Record<string, unknown>): Promise<void>;
  move(id: string, to: RunStatus): Promise<void>;
}

let toastSeq = 0;

export const useBoard = create<BoardState>((set, get) => ({
  runs: {},
  connected: false,
  openRunId: null,
  paletteOpen: false,
  toasts: [],
  tab: 'workflows',
  setTab: (tab) => set({ tab }),
  snapshot: (runs) => set({ runs: Object.fromEntries(runs.map((r) => [r.id, r])) }),
  applyServerRun: (run) => set((s) => ({ runs: { ...s.runs, [run.id]: run } })),
  openRun: (id) => set({ openRunId: id }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setConnected: (connected) => set({ connected }),
  toast: (message, tone = 'error') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  act: async (id, body) => {
    const res = await fetch(`/api/runs/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { run?: RunView; error?: string };
    if (!res.ok || data.error) {
      get().toast(data.error ?? 'That action was refused.');
      return;
    }
    if (data.run) get().applyServerRun(data.run);
  },
  move: async (id, to) => {
    await get().act(id, { action: 'move', to });
  },
}));

export function selectRuns(state: BoardState): RunView[] {
  return Object.values(state.runs).sort((a, b) => b.updatedAt - a.updatedAt);
}
