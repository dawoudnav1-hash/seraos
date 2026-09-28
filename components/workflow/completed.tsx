'use client';

import { useState } from 'react';
import { CheckCircle2, Download, Eye, Loader2, ShieldCheck } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import { APPROVERS } from '@/lib/domain/people';
import { APPROVALS_REQUIRED, type RunView } from '@/lib/domain/types';
import { cn } from '@/lib/utils';
import { FileChip } from '@/components/run-card';
import { EvidenceSections } from './evidence';
import { AuditTrail } from './audit-trail';
import { OutputsList } from './plan-document';
import { useRunEvents } from './use-events';

const TABS = ['Summary', 'Plan & Audit Trail', 'All Outputs'] as const;

function stamp(at: number | null) {
  if (!at) return '';
  const d = new Date(at);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function Completed({ run, onPreview }: { run: RunView; onPreview: (artifactId: string) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Summary');
  const events = useRunEvents(run.id, run.updatedAt);
  const reworking = run.status === 'rejected';

  return (
    <div>
      <section className="mb-8 flex items-start gap-4 rounded-2xl border border-line bg-white px-6 py-5 shadow-card">
        {reworking ? (
          <Loader2 className="mt-0.5 h-8 w-8 shrink-0 animate-spin text-accent" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-8 w-8 shrink-0 text-emerald-600" fill="#10b981" stroke="white" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] font-normal text-ink">
            {reworking ? 'Changes requested — Vert is reworking this' : run.status === 'approved' ? 'Final — approved twice' : 'Task completed successfully'}
          </h1>
          <p className="mt-1 text-[14px] leading-relaxed text-muted">{reworking ? run.rejectionReason : run.description}</p>
        </div>
        {run.completedAt && !reworking && (
          <div className="shrink-0 rounded-lg bg-emerald-50 px-3.5 py-2 text-[12.5px]">
            <p className="text-emerald-700">Completed</p>
            <p className="text-ink/70">{stamp(run.completedAt)}</p>
          </div>
        )}
      </section>

      <nav className="mb-7 flex gap-6 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-1 pb-3 text-[14.5px]', tab === t ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-ink')}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Summary' && (
        <div className="divide-y divide-line">
          <section className="pb-7">
            <h2 className="mb-3 text-[17px] font-medium text-ink">Summary of work</h2>
            <ul className="list-disc space-y-2 pl-5 text-[14.5px] leading-relaxed text-ink/85 marker:text-ink/40">
              {(run.findings.length ? run.findings : [run.description]).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>
          <section className="py-7">
            <h2 className="mb-3 text-[17px] font-medium text-ink">Assumptions Made (most important)</h2>
            {run.assumptions.length ? (
              <ul className="list-disc space-y-2 pl-5 text-[14.5px] leading-relaxed text-ink/85 marker:text-ink/40">
                {run.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-muted">Vert recorded no assumptions for this run.</p>
            )}
          </section>
          <section className="py-7">
            <h2 className="mb-4 text-[17px] font-medium text-ink">Outputs generated</h2>
            <ul className="space-y-3">
              {run.artifacts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3.5 shadow-card">
                  <FileChip kind={a.kind} size="md" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{a.filename}</span>
                  {(a.sheets || a.paragraphs) && (
                    <button type="button" onClick={() => onPreview(a.id)} className="rounded-md p-1.5 text-muted hover:bg-neutral-100 hover:text-ink" aria-label={`Preview ${a.filename}`}>
                      <Eye className="h-4 w-4" />
                    </button>
                  )}
                  <a href={a.url} download className="rounded-md p-1.5 text-muted hover:bg-neutral-100 hover:text-ink" aria-label={`Download ${a.filename}`}>
                    <Download className="h-4 w-4" />
                  </a>
                </li>
              ))}
              {run.artifacts.length === 0 && <li className="text-[14px] text-muted">No files were produced.</li>}
            </ul>
          </section>
          <section className="pt-7">
            <NextSteps run={run} />
          </section>
        </div>
      )}

      {tab === 'Plan & Audit Trail' && (
        <div>
          <EvidenceSections run={run} />
          <h2 className="mb-4 text-[20px] font-normal text-ink">Audit trail</h2>
          <AuditTrail events={events} run={run} />
        </div>
      )}

      {tab === 'All Outputs' && <OutputsList run={run} onPreview={onPreview} />}
    </div>
  );
}

/** Mark for review, then two different approvers finalize it. */
function NextSteps({ run }: { run: RunView }) {
  const { act, toast } = useBoard();
  const remaining = APPROVERS.filter((p) => !run.approvals.some((a) => a.by === p.name));
  const [approver, setApprover] = useState(remaining[0]?.id ?? '');
  const [changes, setChanges] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function go(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    const next = await act(run.id, body);
    setBusy(false);
    if (next) toast(ok, 'ok');
    return next;
  }

  if (run.status === 'rejected') return null;

  if (run.status === 'approved') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
        <div className="text-[14px] text-ink/80">
          <p className="font-medium text-ink">Final. Cleared to post.</p>
          <p className="mt-0.5">
            Approved by {run.approvals.map((a) => `${a.by} (${a.role})`).join(' and ')}.
          </p>
        </div>
      </div>
    );
  }

  const reviewing = run.status === 'viewed';
  const current = remaining.find((p) => p.id === approver) ?? remaining[0];

  return (
    <div className="space-y-4">
      <h2 className="text-[17px] font-medium text-ink">{reviewing ? 'Approvals' : 'Next steps'}</h2>
      <p className="text-[14px] text-muted">
        {reviewing
          ? `Nothing finalizes until two different reviewers approve. ${run.approvals.length} of ${APPROVALS_REQUIRED} so far.`
          : 'Review outputs and complete any remaining items before moving to review.'}
      </p>

      {reviewing && (
        <ol className="space-y-2">
          {Array.from({ length: APPROVALS_REQUIRED }, (_, i) => {
            const a = run.approvals[i];
            return (
              <li key={i} className="flex items-center gap-3 text-[14px]">
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border text-[11px]', a ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-line text-faint')}>
                  {a ? '✓' : i + 1}
                </span>
                {a ? (
                  <span className="text-ink/85">
                    {a.by} <span className="text-muted">· {a.role}</span>
                  </span>
                ) : (
                  <span className="text-muted">Waiting for {i === 0 ? 'first' : 'second'} approval</span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {changes ? (
        <div className="space-y-2">
          <textarea
            id="request-changes"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What should Vert change? This becomes its next instruction."
            className="w-full resize-none rounded-xl border border-line px-3.5 py-3 text-[14px] outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!reason.trim() || busy}
              onClick={async () => {
                if (await go({ action: 'reject', reason }, 'Sent back to Vert with your note.')) {
                  setChanges(false);
                  setReason('');
                }
              }}
              className="rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent-ink disabled:opacity-40"
            >
              Send to Vert
            </button>
            <button type="button" onClick={() => setChanges(false)} className="rounded-xl border border-line px-5 py-2.5 text-[14px] text-ink hover:bg-neutral-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {reviewing ? (
            <>
              <label className="flex items-center gap-2 text-[13.5px] text-muted">
                Approve as
                <select
                  id="approver"
                  value={current?.id}
                  onChange={(e) => setApprover(e.target.value)}
                  className="rounded-lg border border-line bg-white px-2.5 py-2 text-[13.5px] text-ink"
                >
                  {remaining.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.role}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !current}
                onClick={() => go({ action: 'approve', approver: current?.id }, `Approved by ${current?.name}.`)}
                className="rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent-ink disabled:opacity-40"
              >
                Approve
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => go({ action: 'view' }, 'Marked for review. Two approvals will finalize it.')}
              className="rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent-ink disabled:opacity-40"
            >
              Mark for Review
            </button>
          )}
          <button type="button" onClick={() => setChanges(true)} className="rounded-xl border border-line px-5 py-2.5 text-[14px] text-ink hover:bg-neutral-50">
            {reviewing ? 'Request changes' : 'Re-run Task'}
          </button>
        </div>
      )}
    </div>
  );
}
