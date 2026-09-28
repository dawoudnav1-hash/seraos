'use client';

import { useState } from 'react';
import { ChevronDown, Maximize2, Mic, Plus, ShieldCheck, X, ArrowUp } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';
import { cn } from '@/lib/utils';
import { AuditTrail } from './audit-trail';
import { StepMark } from './plan-document';
import { SheetPreview } from './sheet-preview';
import { clock, useRunEvents } from './use-events';

const PHASES = ['Understanding', 'Scope', 'Data', 'Outputs', 'Review'] as const;

function Fold({ title, children, open: initial = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="rounded-2xl border border-line bg-white">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-3.5 text-[14px] text-ink" aria-expanded={open}>
        {title}
        <ChevronDown className={cn('h-4 w-4 text-muted transition', open && 'rotate-180')} />
      </button>
      {open && <div className="border-t border-line px-4 py-3.5">{children}</div>}
    </section>
  );
}

/** The right-hand Vert AI panel; its contents follow the workflow’s state. */
export function VertPanel({
  run,
  preview,
  onPreview,
  onClose,
}: {
  run: RunView;
  preview: string | null;
  onPreview: (id: string | null) => void;
  onClose: () => void;
}) {
  const events = useRunEvents(run.id, run.updatedAt);
  const { act, toast, applyServerRun } = useBoard();
  const [followUp, setFollowUp] = useState('');
  const artifact = run.artifacts.find((a) => a.id === preview);
  const done = ['review_ready', 'viewed', 'approved'].includes(run.status);
  const canFollowUp = run.status === 'review_ready' || run.status === 'viewed';

  async function sendFollowUp() {
    if (!followUp.trim()) return;
    const next = await act(run.id, { action: 'reject', reason: followUp });
    if (next) {
      toast('Vert is reworking the task with your instruction.', 'ok');
      setFollowUp('');
    }
  }

  async function upload(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch(`/api/runs/${run.id}/context`, { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) applyServerRun(data.run);
      else toast(data.error ?? `Couldn’t upload ${f.name}.`);
    }
  }

  const currentPhase = run.clarifications.find((q) => q.answer === null)?.phase ?? 'Review';
  const phaseIdx = PHASES.indexOf(currentPhase);

  return (
    <aside className="sticky top-0 flex h-screen w-[420px] shrink-0 flex-col border-l border-line bg-white max-xl:w-[360px]">
      <header className="flex items-center gap-2.5 px-5 py-4">
        <ShieldCheck className="h-5 w-5 text-accent" />
        <h2 className="flex-1 text-[16px] font-medium text-ink">Vert AI</h2>
        {artifact && (
          <button type="button" onClick={() => onPreview(null)} className="rounded-md p-1.5 text-muted hover:bg-neutral-100" aria-label="Back to activity">
            <Maximize2 className="h-4 w-4 rotate-45" />
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-neutral-100" aria-label="Close panel">
          <X className="h-4 w-4" />
        </button>
      </header>

      {done && artifact ? (
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
          <SheetPreview artifact={artifact} onClose={() => onPreview(null)} />
        </div>
      ) : run.status === 'clarifying' ? (
        <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-5">
          <section className="rounded-2xl border border-line p-4">
            <h3 className="mb-4 text-[14px] text-ink">Clarification progress</h3>
            <ol className="relative flex justify-between">
              <span className="absolute left-4 right-4 top-[9px] h-px bg-line" aria-hidden />
              {PHASES.map((p, i) => (
                <li key={p} className="relative z-[1] flex w-14 flex-col items-center gap-2">
                  <span
                    className={cn(
                      'flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 bg-white',
                      i < phaseIdx ? 'border-accent bg-accent' : i === phaseIdx ? 'border-accent' : 'border-neutral-300',
                    )}
                  >
                    {i === phaseIdx && <span className="h-2 w-2 rounded-full bg-accent" />}
                  </span>
                  <span className={cn('text-[11.5px]', i === phaseIdx ? 'font-medium text-ink' : 'text-muted')}>{p}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-2xl border border-line p-4">
            <h3 className="mb-3 text-[14px] text-ink">Context provided</h3>
            <label
              htmlFor="panel-upload"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(e.dataTransfer.files);
              }}
              className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-accent-line bg-accent-soft/40 px-4 py-6 text-center hover:bg-accent-soft"
            >
              <ArrowUp className="h-5 w-5 text-accent" />
              <span className="text-[14px] font-medium text-ink">Upload context or data</span>
              <span className="text-[12px] text-muted">Drag and drop files here, or click to browse</span>
              <span className="text-[12px] text-muted">Supports PDF, Excel, CSV, and more</span>
            </label>
            <input id="panel-upload" type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
            {run.contextFiles.length > 0 && (
              <ul className="mt-3 space-y-1 text-[13px] text-ink/80">
                {run.contextFiles.map((f) => (
                  <li key={f}>· {f}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-line p-4">
            <h3 className="mb-3 text-[14px] text-ink">What I know so far</h3>
            {run.clarifications.some((q) => q.answer !== null) ? (
              <ul className="space-y-2.5">
                {run.clarifications
                  .filter((q) => q.answer !== null)
                  .map((q) => (
                    <li key={q.id} className="flex gap-3 text-[13.5px] text-ink/80">
                      <span className="text-emerald-600">✓</span>
                      {q.known.replace('{answer}', q.answer!.replace(/\.$/, ''))}
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Nothing yet — answer the first question to get started.</p>
            )}
          </section>

          {run.clarificationWhy && (
            <section className="rounded-2xl border border-line p-4">
              <h3 className="mb-2 text-[14px] text-ink">Why this matters</h3>
              <p className="text-[13px] leading-relaxed text-ink/75">{run.clarificationWhy}</p>
            </section>
          )}
          <p className="flex items-center gap-2 px-1 text-[12px] text-faint">🔒 Your data is secure and never used to train models.</p>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 pb-4">
            <div className="flex flex-col items-end gap-1">
              <p className="max-w-[90%] rounded-2xl bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed text-ink">{run.task}</p>
              <span className="text-[11.5px] text-faint">{clock(run.createdAt)}</span>
            </div>

            <section className="rounded-2xl border border-line p-4">
              <p className="mb-2 flex items-center gap-2 text-[14px] text-ink">
                <span className={cn('h-2 w-2 rounded-full', done ? 'bg-emerald-500' : 'animate-pulse bg-emerald-500')} />
                {done ? 'Workflow complete' : run.status === 'blocked' ? 'Waiting on you' : 'Planning workflow…'}
              </p>
              <p className="mb-3 text-[13px] text-muted">I’ll break this down into clear steps and checks.</p>
              <ol className="space-y-2.5">
                {run.steps.map((s, i) => (
                  <li key={s.id} className="flex items-start gap-3 text-[13.5px] text-ink/85">
                    <StepMark status={s.status} n={i + 1} />
                    {s.title}
                  </li>
                ))}
                {run.steps.length === 0 && <li className="text-[13px] text-muted">Building the plan…</li>}
              </ol>
            </section>

            <Fold title="Reasoning">
              {run.reasoning.length ? (
                <ul className="list-disc space-y-2 pl-4 text-[13px] leading-relaxed text-ink/80">
                  {run.reasoning.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No reasoning notes recorded for this run.</p>
              )}
            </Fold>
            <Fold title="Audit Trail">
              <AuditTrail events={events} run={run} compact />
            </Fold>
            <Fold title="Workflow Plan" open>
              <ol className="space-y-2.5">
                {run.steps.map((s, i) => (
                  <li key={s.id} className="flex gap-3 text-[13.5px]">
                    <span className="w-4 shrink-0 tabular-nums text-muted">{i + 1}</span>
                    <span className="text-ink/85">{s.title}</span>
                  </li>
                ))}
              </ol>
            </Fold>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendFollowUp();
            }}
            className="m-5 mt-0 rounded-2xl border border-line p-3 focus-within:border-accent-line"
          >
            <textarea
              id="follow-up"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              disabled={!canFollowUp}
              rows={2}
              placeholder={canFollowUp ? 'Ask a follow-up — Vert reworks the task with it' : 'Follow-ups open once Vert hands the work in'}
              className="w-full resize-none bg-transparent text-[13.5px] outline-none placeholder:text-faint disabled:cursor-not-allowed"
            />
            <div className="flex items-center justify-end gap-2 text-muted">
              <label htmlFor="panel-upload-2" className="cursor-pointer rounded-md p-1 hover:bg-neutral-100" aria-label="Attach">
                <Plus className="h-4 w-4" />
              </label>
              <input id="panel-upload-2" type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
              <Mic className="h-4 w-4 opacity-40" aria-hidden />
              <button
                type="submit"
                disabled={!canFollowUp || !followUp.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white disabled:bg-neutral-200"
                aria-label="Send follow-up"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
