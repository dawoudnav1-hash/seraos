'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Mail, Search, Send, Sparkles } from 'lucide-react';
import { useBoard } from '@/lib/store/board';
import { greeting } from '@/lib/utils';

export function CommandHeader() {
  const { setPalette, runs } = useBoard();
  const [q, setQ] = useState('');
  const [hello, setHello] = useState('Good morning');
  // Greeting follows the viewer's clock, so compute it after hydration.
  useEffect(() => setHello(greeting()), []);
  const inbox = Object.values(runs).filter((r) => ['blocked', 'clarifying', 'review_ready'].includes(r.status)).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-6">
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-ink">{hello}, Alex.</h1>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2.5 text-[14px] font-medium text-ink shadow-card transition hover:border-accent-line"
          >
            <Sparkles className="h-4 w-4 text-accent" />
            Ask Vert
          </button>
          <Link
            href="/command?tab=workflows"
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2.5 text-[14px] font-medium text-ink shadow-card transition hover:bg-neutral-50"
          >
            <Mail className="h-4 w-4" strokeWidth={1.8} />
            Inbox ({inbox})
          </Link>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPalette(true, q);
          setQ('');
        }}
        className="flex items-center gap-3 rounded-2xl border border-line bg-white px-5 py-4 shadow-card focus-within:border-accent-line"
      >
        <Search className="h-[18px] w-[18px] text-faint" />
        <input
          id="ask-bar"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything about your financial close..."
          className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
        />
        <button type="submit" aria-label="Ask Vert" className="rounded-lg p-1 text-accent transition hover:bg-accent-soft">
          <Send className="h-5 w-5" strokeWidth={1.7} />
        </button>
      </form>
    </div>
  );
}
