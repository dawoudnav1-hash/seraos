'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { ArrowLeft, CloudUpload, MoreHorizontal, Share2 } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import { statusLabel } from '@/lib/domain/reducer';
import type { RunView } from '@/lib/domain/types';
import { cn } from '@/lib/utils';
import { Clarification } from './clarification';
import { PlanDocument } from './plan-document';
import { Completed } from './completed';
import { VertPanel } from './vert-panel';
import { BlockerBanner } from './blocker-banner';

const PILL: Record<string, string> = {
  Clarification: 'bg-accent-soft text-accent',
  'In Progress': 'bg-emerald-50 text-emerald-700',
  Completed: 'bg-accent-soft text-accent',
  'Needs Attention': 'bg-red-50 text-red-700',
  Final: 'bg-emerald-50 text-emerald-700',
  Failed: 'bg-red-50 text-red-700',
};

export function WorkflowView({ initial }: { initial: RunView }) {
  const live = useBoard((s) => s.runs[initial.id]);
  const run = live && live.updatedAt >= initial.updatedAt ? live : initial;
  const { toast, applyServerRun, act } = useBoard();
  const [panelOpen, setPanelOpen] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = ['review_ready', 'viewed', 'approved', 'rejected', 'archived'].includes(run.status);
  const label = statusLabel(run);

  async function upload(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch(`/api/runs/${run.id}/context`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) toast(data.error ?? `Couldn’t upload ${f.name}.`);
      else {
        applyServerRun(data.run);
        toast(`${f.name} added as context.`, 'ok');
      }
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-white/90 px-7 py-4 backdrop-blur">
          <Link href="/command" className="rounded-md p-1 text-muted hover:bg-neutral-100 hover:text-ink" aria-label="Back to workflows">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <nav className="flex min-w-0 items-center gap-2 text-[14.5px]">
            <Link href="/command" className="text-muted hover:text-ink">
              Workflows
            </Link>
            <span className="text-faint">/</span>
            <span className="truncate font-medium text-ink">{run.title}</span>
          </nav>
          <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[12.5px] font-medium', PILL[label] ?? 'bg-neutral-100 text-muted')}>{label}</span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!done && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-line bg-white px-3.5 py-2 text-[13.5px] font-medium text-ink hover:bg-neutral-50"
              >
                <CloudUpload className="h-4 w-4" /> Upload context
              </button>
            )}
            <input ref={fileRef} id="context-upload" type="file" multiple className="hidden" accept=".pdf,.xlsx,.xls,.csv,.docx" onChange={(e) => upload(e.target.files)} />
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
                toast('Link copied — anyone on your team can open this workflow.', 'ok');
              }}
              className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-accent-ink"
            >
              <Share2 className="h-4 w-4" /> Share
            </button>
            <div className="relative">
              <button type="button" onClick={() => setMenu(!menu)} className="rounded-lg border border-line p-2 text-muted hover:bg-neutral-50" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menu && (
                <div className="absolute right-0 top-11 z-30 w-52 rounded-xl border border-line bg-white p-1 shadow-lift">
                  {!panelOpen && (
                    <button type="button" onClick={() => { setPanelOpen(true); setMenu(false); }} className="w-full rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-neutral-50">
                      Show Vert AI panel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      setMenu(false);
                      if (await act(run.id, { action: 'archive' })) toast('Workflow archived.', 'ok');
                    }}
                    className="w-full rounded-lg px-3 py-2 text-left text-[13.5px] text-red-600 hover:bg-red-50"
                  >
                    Archive workflow
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[900px] px-8 py-8">
          {run.blocker && run.status === 'blocked' && <BlockerBanner run={run} />}
          {run.status === 'clarifying' ? (
            <Clarification run={run} />
          ) : done ? (
            <Completed run={run} onPreview={(id) => { setPreview(id); setPanelOpen(true); }} />
          ) : (
            <PlanDocument run={run} />
          )}
        </div>
      </div>

      {panelOpen && <VertPanel run={run} preview={done ? preview ?? run.artifacts[0]?.id ?? null : null} onPreview={setPreview} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
