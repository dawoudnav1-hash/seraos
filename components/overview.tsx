'use client';

import { relativeTime } from '@/lib/utils';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';

const WEEK = 7 * 24 * 60 * 60 * 1000;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-black/[0.07] bg-white px-4 py-3.5">
      <p className="text-[11.5px] uppercase tracking-wider text-neutral-400">{label}</p>
      <p className="mt-1 text-[24px] font-medium tabular-nums text-neutral-900">{value}</p>
      {note && <p className="text-[12px] text-neutral-400">{note}</p>}
    </div>
  );
}

export function Overview({ runs }: { runs: RunView[] }) {
  const openRun = useBoard((s) => s.openRun);
  const now = Date.now();
  const inFlight = runs.filter((r) => ['queued', 'planning', 'executing'].includes(r.status));
  const blocked = runs.filter((r) => r.status === 'blocked' || r.status === 'failed');
  const review = runs.filter((r) => r.status === 'review_ready' || r.status === 'viewed');
  const approved = runs.filter((r) => r.status === 'approved');
  const completedThisWeek = runs.filter((r) => r.status === 'approved' && now - r.updatedAt < WEEK);
  const waits = review.map((r) => now - r.createdAt);
  const avgToReview = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  const closeSteps = [
    { label: 'Reconcile', done: runs.some((r) => /match|reconcil/i.test(r.title) && r.status === 'approved') },
    { label: 'Journal entries', done: runs.some((r) => /journal/i.test(r.title) && r.status === 'approved') },
    { label: 'Technical memos', done: runs.some((r) => /ASC/i.test(r.title) && ['approved', 'viewed'].includes(r.status)) },
    { label: 'Quality control', done: runs.some((r) => /quality/i.test(r.title) && r.status !== 'executing') },
    { label: 'Board reporting', done: runs.some((r) => /board/i.test(r.title) && ['viewed', 'approved'].includes(r.status)) },
  ];
  const donePct = Math.round((closeSteps.filter((s) => s.done).length / closeSteps.length) * 100);

  return (
    <div className="scroll-thin h-full space-y-5 overflow-y-auto pb-6 pr-1">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="In progress" value={String(inFlight.length)} note="agents working now" />
        <Stat label="Blocked on you" value={String(blocked.length)} note="needs a human" />
        <Stat label="Awaiting review" value={String(review.length)} note="ready to sign off" />
        <Stat label="Approved" value={String(approved.length)} note={`${completedThisWeek.length} this week`} />
        <Stat
          label="Avg time to review"
          value={avgToReview ? `${Math.max(1, Math.round(avgToReview / 60_000))}m` : '—'}
          note="from start to hand-in"
        />
      </div>

      <section className="rounded-2xl border border-black/[0.07] bg-white">
        <header className="flex items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <span className="h-[7px] w-[7px] rounded-full bg-red-500" />
          <h2 className="text-[13.5px] font-medium text-neutral-800">Blocked on a human</h2>
        </header>
        {blocked.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-neutral-400">Nothing is waiting on you.</p>
        ) : (
          <ul className="divide-y divide-black/[0.06]">
            {blocked.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => openRun(r.id)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-neutral-50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-neutral-900">{r.title}</span>
                    <span className="block truncate text-[12.5px] text-neutral-500">{r.blocker?.detail ?? r.description}</span>
                  </span>
                  <span className="shrink-0 rounded-lg border border-black/10 px-2.5 py-1 text-[12px] text-neutral-600">
                    {r.blocker?.resolution.label ?? 'Resolve'}
                  </span>
                  <span className="w-16 shrink-0 text-right text-[12px] text-neutral-400">{relativeTime(r.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-black/[0.07] bg-white px-4 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13.5px] font-medium text-neutral-800">Close progress</h2>
          <span className="text-[12px] text-neutral-400">{donePct}% complete</span>
        </div>
        <div className="mb-3 h-[6px] overflow-hidden rounded-full bg-neutral-100">
          <div className="h-full rounded-full bg-neutral-800 transition-[width]" style={{ width: `${donePct}%` }} />
        </div>
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {closeSteps.map((s) => (
            <li key={s.label} className="flex items-center gap-2 text-[13px] text-neutral-600">
              <span className={s.done ? 'h-[7px] w-[7px] rounded-full bg-emerald-500' : 'h-[7px] w-[7px] rounded-full bg-neutral-200'} />
              {s.label}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-black/[0.07] bg-white">
        <header className="border-b border-black/[0.06] px-4 py-3">
          <h2 className="text-[13.5px] font-medium text-neutral-800">Recent activity</h2>
        </header>
        <ul className="divide-y divide-black/[0.06]">
          {runs.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => openRun(r.id)} className="flex w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-neutral-50">
                <span className="w-[120px] shrink-0 text-[12px] uppercase tracking-wide text-neutral-400">{r.status.replace('_', ' ')}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-neutral-800">{r.title}</span>
                <span className="shrink-0 text-[12px] text-neutral-400">{relativeTime(r.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
