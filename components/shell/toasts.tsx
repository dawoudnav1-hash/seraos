'use client';

import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import { cn } from '@/lib/utils';

/** Top-right notices, as in the deck's "Task Created" confirmation. */
export function Toasts() {
  const { toasts, dismissToast } = useBoard();
  return (
    <div className="pointer-events-none fixed right-6 top-6 z-[70] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info;
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-xl border bg-white px-4 py-3.5 shadow-lift',
              t.tone === 'ok' ? 'border-t-[3px] border-line border-t-emerald-500' : t.tone === 'error' ? 'border-t-[3px] border-line border-t-red-500' : 'border-line',
            )}
          >
            <Icon
              className={cn('mt-0.5 h-5 w-5 shrink-0', t.tone === 'ok' ? 'text-emerald-500' : t.tone === 'error' ? 'text-red-500' : 'text-accent')}
              fill="currentColor"
              stroke="white"
            />
            <div className="min-w-0 flex-1">
              {t.title && <p className="text-[14px] font-semibold text-ink">{t.title}</p>}
              <p className="text-[13.5px] leading-snug text-muted">{t.message}</p>
            </div>
            <button type="button" onClick={() => dismissToast(t.id)} className="rounded p-0.5 text-faint hover:text-ink" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
