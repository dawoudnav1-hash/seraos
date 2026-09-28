'use client';

import { AlertTriangle } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';

export function BlockerBanner({ run }: { run: RunView }) {
  const { act, toast } = useBoard();
  const b = run.blocker!;
  async function resolve() {
    if (await act(run.id, { action: 'resolve_blocker' })) toast(`${run.agent} is picking the work back up.`, 'ok', 'Unblocked');
  }
  return (
    <section className="mb-8 flex gap-3 rounded-2xl border border-red-200 bg-red-50/70 p-5">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-medium text-red-800">{b.title}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-red-800/80">{b.detail}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={resolve} className="rounded-lg bg-red-600 px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-red-700">
            {b.resolution.label}
          </button>
          {b.resolution.secondaryLabel && (
            <button type="button" onClick={resolve} className="rounded-lg border border-red-300 bg-white px-3.5 py-2 text-[13.5px] font-medium text-red-700 hover:bg-red-100">
              {b.resolution.secondaryLabel}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
