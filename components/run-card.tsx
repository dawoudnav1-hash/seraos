'use client';

import Link from 'next/link';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn, formatBytes, middleTruncate, relativeTime } from '@/lib/utils';
import type { RunView } from '@/lib/domain/types';

export function FileChip({ kind, size = 'sm' }: { kind: string; size?: 'sm' | 'md' }) {
  const tone = kind === 'pdf' ? 'bg-red-600' : kind === 'docx' ? 'bg-blue-600' : 'bg-emerald-600';
  const letter = kind === 'xlsx' ? 'X' : kind === 'pdf' ? 'P' : kind === 'docx' ? 'W' : 'C';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[3px] font-bold text-white',
        tone,
        size === 'sm' ? 'h-[15px] w-[13px] text-[8px]' : 'h-7 w-6 rounded-md text-[11px]',
      )}
    >
      {letter}
    </span>
  );
}

/** A small progress ring — fills as the agent reports progress. */
function Ring({ pct }: { pct: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="mt-[1px] h-4 w-4 shrink-0 -rotate-90" aria-label={`${pct}% complete`}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="#D4D4DC" strokeWidth="1.5" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="#5B2EE8"
        strokeWidth="1.5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-700"
      />
    </svg>
  );
}

function Grip() {
  return (
    <svg viewBox="0 0 10 14" className="h-3.5 w-2.5 fill-neutral-400" aria-hidden>
      {[2, 7, 12].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.2" />
          <circle cx="7.5" cy={y} r="1.2" />
        </g>
      ))}
    </svg>
  );
}

export function RunCard({ run, now }: { run: RunView; now: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: run.id });
  const running = ['queued', 'planning', 'executing', 'rejected'].includes(run.status);
  const stopped = run.status === 'blocked' || run.status === 'failed' || run.status === 'clarifying';
  const fresh = now - run.updatedAt < 60 * 60 * 1000;

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group relative rounded-xl border border-line bg-white shadow-card transition hover:border-neutral-300 hover:shadow-lift',
        isDragging && 'z-50 opacity-90 shadow-lift',
      )}
    >
      <Link href={`/workflows/${run.id}`} className="block p-3.5" draggable={false}>
        <header className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[12px] text-muted">
            {!stopped && (running || fresh) && <span className="h-[7px] w-[7px] rounded-full bg-emerald-500" />}
            {relativeTime(run.updatedAt, now)}
          </span>
        </header>
        <h3 className="text-[14px] font-medium leading-snug text-ink">{run.title}</h3>
        {run.client && <p className="mt-1 text-[12.5px] text-muted">{run.client}</p>}

        {run.status === 'clarifying' && (
          <span className="mt-2 inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent">
            Clarification · {run.clarifications.filter((q) => q.answer !== null).length} of {run.clarifications.length} answered
          </span>
        )}

        {running ? (
          <div className="mt-2.5 flex items-start gap-2">
            <Ring pct={Math.max(3, run.progressPct)} />
            {run.description ? (
              <p className="line-clamp-3 text-[12px] leading-[1.5] text-ink/70">{run.description}</p>
            ) : (
              <span className="mt-[7px] h-1 flex-1 rounded-full bg-neutral-100" />
            )}
          </div>
        ) : (
          run.description && <p className="mt-2 line-clamp-4 text-[12px] leading-[1.55] text-ink/70">{run.description}</p>
        )}

        {run.artifacts.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {run.artifacts.map((a) => (
              <li key={a.id} className="flex items-center gap-2" title={`${a.filename} · ${formatBytes(a.sizeBytes)}`}>
                <FileChip kind={a.kind} />
                <span className="truncate text-[12px] text-ink/70">{middleTruncate(a.filename, 40)}</span>
              </li>
            ))}
          </ul>
        )}
      </Link>
      <button
        type="button"
        className="absolute right-2.5 top-3 flex cursor-grab gap-1.5 rounded p-0.5 opacity-60 transition group-hover:opacity-100"
        aria-label={`Drag ${run.title}`}
        {...listeners}
        {...attributes}
      >
        <Grip />
        <Grip />
      </button>
    </article>
  );
}
