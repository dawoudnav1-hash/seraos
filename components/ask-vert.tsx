'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import type { Step } from '@/lib/domain/types';

interface Proposal {
  specialist: string;
  steps: Step[];
  tools: string[];
  needs: string[];
  systemPrompt: string;
}

const EXAMPLES = [
  'Accrue December professional fees from the open PO list',
  'Reconcile the operating bank account for November',
  'Draft an ASC 450 memo for the pending vendor dispute',
];

export function AskVert() {
  const { paletteOpen, setPalette, toast, applyServerRun } = useBoard();
  const [task, setTask] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
      if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  useEffect(() => {
    if (!paletteOpen) {
      setTask('');
      setProposal(null);
    }
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  async function propose(text: string) {
    if (!text.trim()) return;
    setBusy(true);
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: text }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return toast(data.error ?? 'Vert could not plan that.');
    setProposal(data as Proposal);
  }

  async function confirm() {
    setBusy(true);
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return toast(data.error ?? 'Vert could not start that run.');
    if (data.run) applyServerRun(data.run);
    toast('Run started — watch it in In Progress.', 'ok');
    setPalette(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[12vh]" onClick={() => setPalette(false)}>
      <div
        className="w-full max-w-[620px] overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-black/[0.07] px-5 py-4">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <input
            autoFocus
            value={task}
            onChange={(e) => {
              setTask(e.target.value);
              setProposal(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (proposal ? confirm() : propose(task))}
            placeholder="Describe the work — “book the November payroll entry”"
            className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-neutral-400"
          />
          <button type="button" onClick={() => setPalette(false)} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!proposal && (
          <div className="px-3 py-3">
            <p className="px-2 pb-2 text-[11.5px] uppercase tracking-wider text-neutral-400">Try</p>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setTask(ex);
                  void propose(ex);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-neutral-600 hover:bg-neutral-50"
              >
                <ArrowRight className="h-3.5 w-3.5 text-neutral-300" />
                {ex}
              </button>
            ))}
          </div>
        )}

        {proposal && (
          <div className="max-h-[46vh] overflow-y-auto px-5 py-4">
            <p className="mb-3 text-[13px] text-neutral-500">
              <span className="font-medium text-neutral-800">{proposal.specialist}</span> will own this.
            </p>
            <ol className="mb-4 space-y-2">
              {proposal.steps.map((s, i) => (
                <li key={s.id} className="flex gap-3">
                  <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-neutral-200 text-[10px] text-neutral-400">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-[13.5px] text-neutral-800">{s.title}</span>
                    <span className="block font-mono text-[11px] text-neutral-400">{s.tools.join(', ') || 'no tools'}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mb-1.5 text-[11.5px] uppercase tracking-wider text-neutral-400">What Vert needs from you</p>
            <ul className="space-y-1">
              {proposal.needs.map((n) => (
                <li key={n} className="text-[13px] text-neutral-600">
                  · {n}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-black/[0.07] bg-neutral-50 px-5 py-3">
          <span className="text-[12px] text-neutral-400">⌘K to open · Esc to close</span>
          <button
            type="button"
            disabled={!task.trim() || busy}
            onClick={() => (proposal ? confirm() : propose(task))}
            className="flex items-center gap-2 rounded-lg bg-neutral-900 px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {proposal ? 'Start run' : 'Propose a plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
