'use client';

import { useState } from 'react';
import { Check, ChevronRight, FileText, Loader2, Paperclip } from 'lucide-react';
import type { RunView } from '@/lib/domain/types';
import { cn, formatBytes } from '@/lib/utils';
import { EvidenceSections } from './evidence';
import { FileChip } from '@/components/run-card';
import { clock, useRunEvents } from './use-events';

const TABS = ['Plan', 'Data', 'Outputs'] as const;

export function PlanDocument({ run }: { run: RunView }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Plan');
  const current = run.steps.find((s) => s.status === 'running');

  return (
    <div>
      <nav className="-mt-4 mb-8 flex gap-6 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-1 pb-3 text-[14.5px]', tab === t ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {t}
            {t === 'Outputs' && run.artifacts.length > 0 && <span className="ml-1.5 text-faint">{run.artifacts.length}</span>}
          </button>
        ))}
      </nav>

      {tab === 'Plan' && (
        <article>
          <h1 className="mb-8 text-[34px] font-normal tracking-[-0.02em] text-ink">{run.title}</h1>
          <section className="mb-10">
            <h2 className="mb-3 text-[20px] font-normal text-ink">Scope</h2>
            <p className="max-w-[720px] text-[14.5px] leading-relaxed text-ink/80">{run.scope || run.task}</p>
          </section>

          <EvidenceSections run={run} />

          {run.tables.length === 0 && run.steps.length > 0 && (
            <section className="mb-10">
              <h2 className="mb-4 text-[20px] font-normal text-ink">Steps</h2>
              <ol className="space-y-3">
                {run.steps.map((s, i) => (
                  <li key={s.id} className="flex items-start gap-3 text-[14.5px]">
                    <StepMark status={s.status} n={i + 1} />
                    <span className={s.status === 'completed' ? 'text-ink/80' : 'text-ink'}>{s.title}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {current && (
            <p className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-4 py-3 text-[14px] text-ink/80 shadow-card">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
              <span className="font-medium text-ink">{current.title}</span>
              <span className="truncate text-muted">— {run.description}</span>
            </p>
          )}
        </article>
      )}

      {tab === 'Data' && <DataTab run={run} />}
      {tab === 'Outputs' && <OutputsList run={run} />}
    </div>
  );
}

export function StepMark({ status, n }: { status: string; n: number }) {
  if (status === 'completed') return <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === 'running') return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />;
  return (
    <span
      className={cn(
        'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10.5px] tabular-nums',
        status === 'blocked' ? 'border-red-400 text-red-600' : 'border-accent-line text-accent',
      )}
    >
      {n}
    </span>
  );
}

/** Every figure Vert used, the context it was given, and each raw tool call. */
export function DataTab({ run }: { run: RunView }) {
  const events = useRunEvents(run.id, run.updatedAt);
  const [open, setOpen] = useState<number | null>(null);
  const calls = events.filter((e) => e.type === 'tool_called');
  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-[18px] font-normal text-ink">Context provided</h2>
        {run.contextFiles.length ? (
          <ul className="space-y-2">
            {run.contextFiles.map((f) => (
              <li key={f} className="flex items-center gap-2 text-[14px] text-ink/80">
                <Paperclip className="h-4 w-4 text-faint" /> {f}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-muted">No files attached — Vert worked from the connected ledger.</p>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-[18px] font-normal text-ink">Figures and where they came from</h2>
        {run.provenance.length === 0 ? (
          <p className="text-[14px] text-muted">No figures yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-white">
            {run.provenance.map((p) => (
              <div key={p.id} className="flex items-center gap-4 border-t border-line px-4 py-3 first:border-t-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{p.label}</span>
                  {p.note && <span className="block truncate text-[12.5px] text-muted">{p.note}</span>}
                </span>
                <span className="text-right">
                  <span className="block text-[14px] font-medium tabular-nums text-ink">{p.value}</span>
                  <span className="block font-mono text-[11px] text-faint">
                    {p.tool} · {run.steps.find((s) => s.id === p.stepId)?.title ?? p.stepId}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-[18px] font-normal text-ink">Tool calls</h2>
        <ol className="space-y-1">
          {calls.map((e) => {
            const result = events.find((r) => r.seq > e.seq && r.type === 'tool_result');
            const isOpen = open === e.seq;
            return (
              <li key={e.seq} className="rounded-lg border border-transparent hover:border-line">
                <button type="button" onClick={() => setOpen(isOpen ? null : e.seq)} className="flex w-full items-center gap-3 px-2 py-2 text-left">
                  <ChevronRight className={cn('h-4 w-4 shrink-0 text-faint transition', isOpen && 'rotate-90')} />
                  <code className="font-mono text-[12.5px] text-accent">{String(e.payload.tool)}</code>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{String(result?.payload.summary ?? '')}</span>
                  <span className="text-[12px] text-faint">{clock(e.at)}</span>
                </button>
                {isOpen && (
                  <pre className="mx-2 mb-2 overflow-x-auto rounded-lg bg-neutral-50 p-3 font-mono text-[11.5px] leading-relaxed text-ink/70">
                    {JSON.stringify({ args: e.payload.args, result: result?.payload.summary }, null, 2).slice(0, 4000)}
                  </pre>
                )}
              </li>
            );
          })}
          {calls.length === 0 && <li className="text-[14px] text-muted">No tool calls yet.</li>}
        </ol>
      </section>
    </div>
  );
}

export function OutputsList({ run, onPreview }: { run: RunView; onPreview?: (id: string) => void }) {
  if (run.artifacts.length === 0) {
    return (
      <p className="flex items-center gap-2 text-[14px] text-muted">
        <FileText className="h-4 w-4" /> Outputs appear here as Vert writes them.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {run.artifacts.map((a) => (
        <li key={a.id} className="flex items-center gap-4 rounded-xl border border-line bg-white px-4 py-3.5 shadow-card">
          <FileChip kind={a.kind} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-ink">{a.filename}</span>
            <span className="block text-[12px] text-muted">
              {formatBytes(a.sizeBytes)} · {a.generatedBy}
            </span>
          </span>
          {onPreview && (a.sheets || a.paragraphs) && (
            <button type="button" onClick={() => onPreview(a.id)} className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-neutral-50">
              Preview
            </button>
          )}
          <a href={a.url} download className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-neutral-50">
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}
