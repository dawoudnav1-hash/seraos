'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronRight, Download, Link2, Loader2, X } from 'lucide-react';
import { cn, formatBytes, middleTruncate, relativeTime } from '@/lib/utils';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';

interface TimelineEntry {
  seq: number;
  type: string;
  at: number;
  payload: Record<string, unknown>;
}

const STEP_STYLE: Record<string, string> = {
  pending: 'border-neutral-200 text-neutral-400',
  running: 'border-emerald-500 text-emerald-600',
  blocked: 'border-red-400 text-red-600',
  completed: 'border-emerald-500 bg-emerald-500 text-white',
  failed: 'border-red-500 bg-red-500 text-white',
};

export function RunDrawer({ run }: { run: RunView }) {
  const { openRun, act } = useBoard();
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/runs/${run.id}/events`)
      .then((r) => r.json())
      .then((d: { events: TimelineEntry[] }) => alive && setTimeline(d.events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [run.id, run.updatedAt]);

  useEffect(() => {
    if (run.status === 'review_ready') void act(run.id, { action: 'view' });
    // Opening a run is itself a decision point: it moves review_ready → viewed.
  }, [run.id, run.status, act]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openRun(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRun]);

  async function run_(body: Record<string, unknown>) {
    setBusy(true);
    await act(run.id, body);
    setBusy(false);
  }

  const decidable = run.status === 'viewed';

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="flex-1 bg-black/20" onClick={() => openRun(null)} />
      <aside className="flex h-full w-[560px] max-w-[92vw] flex-col border-l border-black/10 bg-white shadow-2xl">
        <header className="flex items-start gap-3 border-b border-black/[0.07] px-6 py-5">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[12px] uppercase tracking-wide text-neutral-400">
              {run.agent} · {run.status.replace('_', ' ')} · {relativeTime(run.updatedAt)}
            </p>
            <h2 className="text-[18px] font-semibold leading-snug text-neutral-900">{run.title}</h2>
          </div>
          <button type="button" onClick={() => openRun(null)} className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto px-6 py-5">
          {run.blocker && (
            <section className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
              <h3 className="mb-1 text-[13.5px] font-semibold text-red-800">{run.blocker.title}</h3>
              <p className="mb-3 text-[13px] leading-relaxed text-red-700">{run.blocker.detail}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run_({ action: 'resolve_blocker' })}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {run.blocker.resolution.label}
                </button>
                {run.blocker.resolution.secondaryLabel && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run_({ action: 'resolve_blocker' })}
                    className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    {run.blocker.resolution.secondaryLabel}
                  </button>
                )}
              </div>
            </section>
          )}

          <Section title="Plan">
            <ol className="space-y-2.5">
              {run.steps.map((step, i) => (
                <li key={step.id} className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                      STEP_STYLE[step.status],
                    )}
                  >
                    {step.status === 'completed' ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-neutral-800">{step.title}</span>
                    <span className="block text-[12px] text-neutral-400">
                      {step.agent}
                      {step.tools.length > 0 && ` · ${step.tools.join(', ')}`}
                    </span>
                  </span>
                </li>
              ))}
              {run.steps.length === 0 && <li className="text-[13px] text-neutral-400">Planning…</li>}
            </ol>
          </Section>

          {run.provenance.length > 0 && (
            <Section title="Provenance">
              <ul className="divide-y divide-black/[0.06] rounded-xl border border-black/[0.07]">
                {run.provenance.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-neutral-800">{p.label}</span>
                      {p.note && <span className="block truncate text-[11.5px] text-neutral-400">{p.note}</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[13px] font-medium tabular-nums text-neutral-900">{p.value}</span>
                      <span className="block font-mono text-[10.5px] text-neutral-400">{p.tool}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {run.artifacts.length > 0 && (
            <Section title="Artifacts">
              <ul className="space-y-2">
                {run.artifacts.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 rounded-xl border border-black/[0.07] px-3.5 py-2.5">
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold uppercase text-white',
                        a.kind === 'pdf' ? 'bg-red-600' : 'bg-emerald-600',
                      )}
                    >
                      {a.kind === 'xlsx' ? 'X' : a.kind === 'pdf' ? 'P' : a.kind === 'docx' ? 'W' : 'C'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-neutral-800">{middleTruncate(a.filename, 46)}</span>
                      <span className="block text-[11.5px] text-neutral-400">
                        {formatBytes(a.sizeBytes)} · {a.generatedBy}
                      </span>
                    </span>
                    <a
                      href={a.url}
                      download
                      className="flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                    >
                      <Download className="h-3.5 w-3.5" /> Open
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Timeline">
            <ol className="space-y-1">
              {timeline.map((e) => {
                const isTool = e.type === 'tool_called' || e.type === 'tool_result';
                const open = expanded === e.seq;
                return (
                  <li key={e.seq} className="rounded-lg border border-transparent hover:border-black/[0.07]">
                    <button
                      type="button"
                      disabled={!isTool}
                      onClick={() => setExpanded(open ? null : e.seq)}
                      className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left"
                    >
                      {isTool ? (
                        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-neutral-400 transition', open && 'rotate-90')} />
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300" />
                      )}
                      <span className="font-mono text-[11px] uppercase tracking-wide text-neutral-400">{e.type}</span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-neutral-600">{describe(e)}</span>
                      <span className="shrink-0 text-[11px] text-neutral-300">{relativeTime(e.at)}</span>
                    </button>
                    {open && (
                      <pre className="scroll-thin mx-2 mb-2 overflow-x-auto rounded-lg bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-600">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ol>
          </Section>
        </div>

        <footer className="border-t border-black/[0.07] px-6 py-4">
          {rejecting ? (
            <div className="space-y-2.5">
              <textarea
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What needs to change? This goes back to the agent as its next instruction."
                className="h-20 w-full resize-none rounded-xl border border-black/10 p-3 text-[13px] outline-none focus:border-neutral-400"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setRejecting(false)} className="rounded-lg px-3 py-2 text-[13px] text-neutral-500">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!reason.trim() || busy}
                  onClick={async () => {
                    await run_({ action: 'reject', reason });
                    setRejecting(false);
                    setReason('');
                  }}
                  className="rounded-lg bg-neutral-900 px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  Send back to agent
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!decidable || busy}
                onClick={() => run_({ action: 'approve' })}
                className="flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-[13.5px] font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approve
              </button>
              <button
                type="button"
                disabled={!decidable || busy}
                onClick={() => setRejecting(true)}
                className="rounded-xl border border-black/10 px-4 py-2.5 text-[13.5px] font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-40"
              >
                Request changes
              </button>
              <span className="ml-auto text-[12px] text-neutral-400">
                {run.status === 'approved'
                  ? 'Approved — cleared to post.'
                  : decidable
                    ? 'Nothing posts until you approve.'
                    : 'Available once the agent hands the run in.'}
              </span>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 text-[11.5px] font-semibold uppercase tracking-wider text-neutral-400">{title}</h3>
      {children}
    </section>
  );
}

function describe(e: TimelineEntry): string {
  const p = e.payload as Record<string, string>;
  return (p.note as string) ?? (p.summary as string) ?? (p.tool as string) ?? (p.error as string) ?? (p.stepId as string) ?? '';
}
