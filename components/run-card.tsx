'use client';

import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn, formatBytes, middleTruncate, relativeTime } from '@/lib/utils';
import type { RunView } from '@/lib/domain/types';

const DOT: Record<string, string> = {
  in_progress: 'bg-emerald-500',
  needs_attention: 'bg-red-500',
  ready_for_review: 'bg-emerald-500',
  viewed: 'bg-emerald-500',
};

function FileChip({ kind }: { kind: string }) {
  const green = kind === 'xlsx' || kind === 'csv';
  return (
    <span
      className={cn(
        'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] text-[8px] font-bold uppercase text-white',
        green ? 'bg-emerald-600' : 'bg-red-600',
      )}
    >
      {kind === 'xlsx' ? 'X' : kind === 'pdf' ? 'P' : kind === 'docx' ? 'W' : 'C'}
    </span>
  );
}

export function RunCard({ run, column, now }: { run: RunView; column: string; now: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: run.id });
  const running = run.status === 'executing' || run.status === 'planning' || run.status === 'queued';
  const blocked = run.status === 'blocked' || run.status === 'failed';

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group relative cursor-pointer rounded-xl border border-black/[0.07] bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition',
        'hover:border-black/15 hover:shadow-[0_2px_10px_rgba(0,0,0,0.06)]',
        isDragging && 'z-50 opacity-90 shadow-lg',
      )}
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2">
          {!blocked && <span className={cn('h-[7px] w-[7px] rounded-full', DOT[column] ?? 'bg-neutral-400')} />}
          <span className="text-[12px] text-neutral-500">{relativeTime(run.updatedAt, now)}</span>
        </span>
        <span
          className="flex items-center opacity-0 transition group-hover:opacity-100"
          {...listeners}
          {...attributes}
          aria-label={`Drag ${run.title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5 -mr-2 text-neutral-300" />
          <GripVertical className="h-3.5 w-3.5 text-neutral-300" />
        </span>
      </header>

      <h3 className="mb-1.5 text-[14px] font-semibold leading-snug text-neutral-900">{run.title}</h3>

      {run.description && (
        <p className="line-clamp-4 text-[12.5px] leading-[1.5] text-neutral-500">{run.description}</p>
      )}

      {running && (
        <div className="mt-3 flex items-center gap-2">
          <span className="h-[11px] w-[11px] shrink-0 rounded-full border border-neutral-300" />
          <span className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-neutral-100">
            <span
              className="progress-shimmer absolute inset-y-0 left-0 rounded-full bg-neutral-300 transition-[width] duration-700"
              style={{ width: `${Math.max(4, run.progressPct)}%` }}
            />
          </span>
        </div>
      )}

      {blocked && run.blocker && (
        <button
          type="button"
          className="mt-3 hidden w-full rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] font-medium text-red-700 transition group-hover:block hover:bg-red-100"
        >
          Resolve — {run.blocker.resolution.label}
        </button>
      )}

      {run.artifacts.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {run.artifacts.map((a) => (
            <li key={a.id} className="flex items-center gap-2" title={`${a.filename} · ${formatBytes(a.sizeBytes)}`}>
              <FileChip kind={a.kind} />
              <span className="truncate text-[12px] text-neutral-600">{middleTruncate(a.filename, 40)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
