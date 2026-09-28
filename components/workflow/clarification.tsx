'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Loader2, Paperclip, Sparkles } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import type { RunView } from '@/lib/domain/types';
import { clock } from './use-events';

/**
 * Vert asks one question at a time, the way a preparer would. The last answer
 * starts planning; the page then switches to the plan as events stream in.
 */
export function Clarification({ run }: { run: RunView }) {
  const { applyServerRun, toast } = useBoard();
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const firstOpen = run.clarifications.findIndex((q) => q.answer === null);
  const shown = firstOpen === -1 ? run.clarifications : run.clarifications.slice(0, firstOpen + 1);
  const current = firstOpen === -1 ? null : run.clarifications[firstOpen];

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [shown.length]);

  async function send() {
    if (!current || !answer.trim()) return;
    setSending(true);
    const res = await fetch(`/api/runs/${run.id}/clarify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: current.id, answer }),
    });
    const data = await res.json();
    setSending(false);
    if (!res.ok) return toast(data.error ?? 'Vert didn’t get that answer. Try again.');
    applyServerRun(data.run);
    setAnswer('');
  }

  async function attach(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch(`/api/runs/${run.id}/context`, { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) applyServerRun(data.run);
      else toast(data.error ?? `Couldn’t attach ${f.name}.`);
    }
  }

  return (
    <div>
      <h1 className="flex items-center gap-3 text-[20px] font-medium text-ink">
        <Sparkles className="h-5 w-5 text-accent" fill="currentColor" /> Clarifying your requirements
      </h1>
      <p className="mt-3 max-w-[720px] text-[14.5px] leading-relaxed text-ink/75">{run.clarificationIntro}</p>

      <ol className="mt-6 space-y-4">
        {shown.map((q, i) => (
          <li key={q.id} className="space-y-3">
            <div className="max-w-[680px] rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
              <p className="flex items-start gap-3 text-[14.5px] text-ink">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" fill="currentColor" />
                <span className="w-4 shrink-0 tabular-nums">{i + 1}</span>
                <span className="font-medium">{q.question}</span>
              </p>
              <p className="ml-14 mt-1.5 text-[13.5px] text-muted">{q.help}</p>
              <p className="ml-14 mt-1 text-[12px] text-faint">{clock(q.askedAt)}</p>
            </div>
            {q.answer !== null && (
              <div className="flex justify-end">
                <p className="flex items-center gap-4 rounded-xl bg-accent-soft px-4 py-3 text-[14px] text-ink">
                  {q.answer}
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    {q.answeredAt ? clock(q.answeredAt) : ''} <Check className="h-3.5 w-3.5" />
                  </span>
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {firstOpen === -1 && (
        <p className="mt-6 flex items-center gap-2 text-[14px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin text-accent" /> Got everything I need — building the plan.
        </p>
      )}
      <div ref={endRef} />

      <div className="sticky bottom-0 z-10 -mx-2 mt-8 bg-gradient-to-t from-canvas via-canvas to-transparent px-2 pb-6 pt-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-center rounded-2xl border border-line bg-white shadow-card focus-within:border-accent-line"
        >
          <input
            id="clarify-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={!current || sending}
            placeholder={current ? 'Type your answer...' : 'All questions answered'}
            className="flex-1 rounded-l-2xl bg-transparent px-5 py-4 text-[14.5px] outline-none placeholder:text-faint disabled:cursor-not-allowed"
          />
          <span className="flex items-center gap-2 border-l border-line px-3">
            <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg p-2 text-muted hover:bg-neutral-100" aria-label="Attach context">
              <Paperclip className="h-4 w-4" />
            </button>
            <input ref={fileRef} id="clarify-attach" type="file" multiple className="hidden" onChange={(e) => attach(e.target.files)} />
            <button
              type="submit"
              disabled={!current || !answer.trim() || sending}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-ink disabled:bg-neutral-300"
              aria-label="Send answer"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </span>
        </form>
      </div>
    </div>
  );
}
