'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2, Paperclip, Sparkles, X } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import type { Step } from '@/lib/domain/types';

interface Proposal {
  specialist: string;
  steps: Step[];
  tools: string[];
  needs: string[];
}

const CLIENTS = ['Brevard Logistics', 'Caraway Health Group', 'Alder River Growth Partners', 'Sable Creek Properties LLC', 'Pinelith Construction Co.'];

const EXAMPLES = [
  'Accrue April professional fees from the open PO list',
  'Reconcile the operating bank account for April',
  'Draft an ASC 450 memo for the pending vendor dispute',
];

/**
 * Add a workflow to the run: name it, state the purpose, drop in context.
 * Vert proposes who will do it and how; the workflow then opens on its
 * clarifying questions.
 */
export function AskVert() {
  const router = useRouter();
  const { paletteOpen, paletteDraft, setPalette, toast } = useBoard();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [client, setClient] = useState(CLIENTS[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
      if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  useEffect(() => {
    if (paletteOpen) {
      setPurpose(paletteDraft);
    } else {
      setName('');
      setPurpose('');
      setFiles([]);
      setProposal(null);
    }
  }, [paletteOpen, paletteDraft]);

  if (!paletteOpen) return null;

  async function propose() {
    if (!purpose.trim()) return toast('Describe what the workflow should do.', 'info');
    setBusy(true);
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: `${name} ${purpose}` }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return toast(data.error ?? 'Vert couldn’t plan that. Add a sentence on the outcome you want.');
    setProposal(data as Proposal);
  }

  async function create() {
    setBusy(true);
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name, task: purpose, client }),
    });
    const data = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !data.id) {
      setBusy(false);
      return toast(data.error ?? 'Vert couldn’t create that workflow.');
    }
    for (const f of files) {
      const form = new FormData();
      form.append('file', f);
      await fetch(`/api/runs/${data.id}/context`, { method: 'POST', body: form });
    }
    setBusy(false);
    setPalette(false);
    toast('Vert will ask a few questions before it plans.', 'ok', 'Workflow created');
    router.push(`/workflows/${data.id}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 px-4 pt-[9vh]" onClick={() => setPalette(false)}>
      <div
        role="dialog"
        aria-label="New workflow"
        className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-line bg-white shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-line px-6 py-4">
          <Sparkles className="h-5 w-5 text-accent" />
          <h2 className="flex-1 text-[16px] font-medium text-ink">New workflow</h2>
          <button type="button" onClick={() => setPalette(false)} className="rounded-lg p-1 text-faint hover:bg-neutral-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[64vh] space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-[1fr_220px] gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Name</span>
              <input
                id="wf-name"
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setProposal(null);
                }}
                placeholder="Fixed Assets – May 2026 Close"
                className="w-full rounded-xl border border-line px-3.5 py-2.5 text-[14px] outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Client</span>
              <select
                id="wf-client"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] outline-none focus:border-accent"
              >
                {CLIENTS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Purpose and instructions</span>
            <textarea
              id="wf-purpose"
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                setProposal(null);
              }}
              rows={4}
              placeholder="What should Vert produce, and anything it should know?"
              className="w-full resize-none rounded-xl border border-line px-3.5 py-2.5 text-[14px] leading-relaxed outline-none focus:border-accent"
            />
          </label>
          {!purpose && (
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPurpose(ex)}
                  className="rounded-full border border-line px-3 py-1 text-[12.5px] text-muted hover:border-accent-line hover:text-accent"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-muted">Context files</span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-accent-line bg-accent-soft/50 px-4 py-4 text-[13.5px] text-accent hover:bg-accent-soft"
            >
              <FileUp className="h-4 w-4" /> Add PDFs, Excel or CSV
            </button>
            <input
              ref={fileRef}
              id="wf-files"
              type="file"
              multiple
              accept=".pdf,.xlsx,.xls,.csv,.docx"
              className="hidden"
              onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
            />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center gap-2 text-[13px] text-ink/80">
                    <Paperclip className="h-3.5 w-3.5 text-faint" /> {f.name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {proposal && (
            <div className="rounded-xl border border-line bg-neutral-50/60 p-4">
              <p className="mb-3 text-[13px] text-muted">
                <span className="font-medium text-ink">{proposal.specialist}</span> will own this. It will ask a few questions, then:
              </p>
              <ol className="space-y-2">
                {proposal.steps.map((s, i) => (
                  <li key={s.id} className="flex gap-3">
                    <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-line text-[10px] text-muted">{i + 1}</span>
                    <span>
                      <span className="block text-[13.5px] text-ink">{s.title}</span>
                      <span className="block font-mono text-[11px] text-faint">{s.tools.join(', ') || 'no tools'}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mb-1 mt-3 text-[11.5px] font-medium uppercase tracking-wider text-faint">What Vert needs from you</p>
              <ul className="space-y-0.5 text-[13px] text-muted">
                {proposal.needs.map((n) => (
                  <li key={n}>· {n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-line bg-neutral-50/60 px-6 py-3.5">
          <span className="text-[12px] text-faint">⌘K opens this anywhere · Esc closes</span>
          <button
            type="button"
            disabled={!purpose.trim() || busy}
            onClick={() => (proposal ? create() : propose())}
            className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-medium text-white transition hover:bg-accent-ink disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {proposal ? 'Create workflow' : 'Propose a plan'}
          </button>
        </footer>
      </div>
    </div>
  );
}
