'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  ChevronDown,
  CircleDollarSign,
  Database,
  FileText,
  Home,
  LayoutGrid,
  LineChart,
  Plus,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoard } from '@/lib/store/board';

interface NavItem {
  label: string;
  href?: string;
  /** Also active on these path prefixes. */
  match?: string[];
}

const TOP: (NavItem & { icon: typeof Home })[] = [
  { label: 'Command', href: '/command', match: ['/command', '/workflows'], icon: Home },
  { label: 'Spaces', icon: LayoutGrid },
  { label: 'Monitor', icon: LineChart },
];

const GROUPS: { label: string; icon: typeof Home; items: NavItem[] }[] = [
  { label: 'Financials', icon: CircleDollarSign, items: [{ label: 'Cash' }, { label: 'Spend' }, { label: 'Payables' }, { label: 'Receivables' }] },
  {
    label: 'Close',
    icon: Database,
    items: [
      { label: 'Overview' },
      { label: 'Reconcile' },
      { label: 'Flux Analysis' },
      { label: 'Workbooks' },
    ],
  },
];

function isActive(path: string, item: NavItem) {
  const prefixes = item.match ?? (item.href ? [item.href] : []);
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

export function Sidebar() {
  const path = usePathname();
  const { setPalette, toast } = useBoard();
  const [open, setOpen] = useState<Record<string, boolean>>({ Financials: true, Close: true });

  const notBuilt = (label: string) => toast(`${label} isn’t part of this build yet.`, 'info');

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col bg-rail text-white">
      <Link href="/command" className="flex items-center gap-3 px-6 pb-6 pt-6">
        <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_30%_25%,#f4f4f6,#8b8b93_45%,#1d1d21_75%)] ring-1 ring-white/20">
          <span className="h-3.5 w-4 bg-[#0A0A0A] [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
        </span>
        <span className="text-[25px] font-medium tracking-tight">Vert</span>
      </Link>

      <nav className="space-y-1 px-3">
        {TOP.map((item) => {
          const active = isActive(path, item);
          const cls = cn(
            'flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] transition',
            active ? 'bg-railRaised text-white ring-1 ring-white/[0.06]' : 'text-white/60 hover:bg-white/[0.04] hover:text-white',
          );
          const body = (
            <>
              <item.icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
              {item.label}
            </>
          );
          return item.href ? (
            <Link key={item.label} href={item.href} className={cls}>
              {body}
            </Link>
          ) : (
            <button key={item.label} type="button" onClick={() => notBuilt(item.label)} className={cls}>
              {body}
            </button>
          );
        })}
      </nav>

      <div className="mx-5 my-4 border-t border-white/10" />

      <div className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [g.label]: !o[g.label] }))}
              className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] text-white/60 transition hover:text-white"
              aria-expanded={open[g.label]}
            >
              <g.icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
              <span className="flex-1 text-left">{g.label}</span>
              <ChevronDown className={cn('h-4 w-4 transition-transform', !open[g.label] && '-rotate-90')} />
            </button>
            {open[g.label] && (
              <div className="mb-2 ml-[26px] border-l border-white/10 pl-4">
                {g.items.map((item) => {
                  const active = isActive(path, item);
                  const cls = cn(
                    'block w-full rounded-lg px-2.5 py-[7px] text-left text-[14px] transition',
                    active ? 'bg-railRaised text-white' : 'text-white/55 hover:text-white',
                  );
                  return item.href ? (
                    <Link key={item.label} href={item.href} className={cls}>
                      {item.label}
                    </Link>
                  ) : (
                    <button key={item.label} type="button" onClick={() => notBuilt(item.label)} className={cls}>
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => notBuilt('Reporting')}
          className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] text-white/60 transition hover:text-white"
        >
          <FileText className="h-[18px] w-[18px]" strokeWidth={1.7} />
          Reporting
        </button>
      </div>

      <div className="px-4 pb-5">
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-[14.5px] font-medium text-ink shadow-card transition hover:bg-white/90"
        >
          <Plus className="h-4 w-4 text-accent" strokeWidth={2.25} />
          New Chat
        </button>
        <div className="flex items-center gap-3 border-t border-white/10 px-1 pt-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#8a7564] to-[#3a322c] text-[13px] font-semibold ring-2 ring-white/10">
            AM
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium">Alex Morgan</span>
            <span className="block truncate text-[12px] text-white/50">Finance Manager</span>
          </span>
          <Settings className="h-[18px] w-[18px] text-white/50" strokeWidth={1.7} />
        </div>
      </div>
    </aside>
  );
}
