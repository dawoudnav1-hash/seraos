'use client';

import { create } from 'zustand';
import type { RunStatus, RunView } from '@/lib/domain/types';

export interface Toast {
  id: number;
  title?: string;
  message: string;
  tone: 'error' | 'ok' | 'info';
}

interface BoardState {
  runs: Record<string, RunView>;
  connected: boolean;
  paletteOpen: boolean;
  paletteDraft: string;
  toasts: Toast[];
  snapshot(runs: RunView[]): void;
  /** Runs arrive already projected from the event log — the client keeps no state of its own. */
  applyServerRun(run: RunView): void;
  setPalette(open: boolean, draft?: string): void;
  setConnected(c: boolean): void;
  toast(message: string, tone?: Toast['tone'], title?: string): void;
  dismissToast(id: number): void;
  act(id: string, body: Record<string, unknown>): Promise<RunView | null>;
  move(id: string, to: RunStatus): Promise<void>;
}

let toastSeq = 0;

export const useBoard = create<BoardState>((set, get) => ({
  runs: {},
  connected: false,
  paletteOpen: false,
  paletteDraft: '',
  toasts: [],
  snapshot: (runs) => set({ runs: Object.fromEntries(runs.map((r) => [r.id, r])) }),
  applyServerRun: (run) =>
    set((s) => {
      const prev = s.runs[run.id];
      // SSE and action responses can race; never let an older projection win.
      if (prev && prev.updatedAt > run.updatedAt) return s;
      return { runs: { ...s.runs, [run.id]: run } };
    }),
  setPalette: (paletteOpen, draft = '') => set({ paletteOpen, paletteDraft: draft }),
  setConnected: (connected) => set({ connected }),
  toast: (message, tone = 'error', title) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone, title }] }));
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
      return null;
    }
    if (data.run) get().applyServerRun(data.run);
    return data.run ?? null;
  },
  move: async (id, to) => {
    await get().act(id, { action: 'move', to });
  },
}));
