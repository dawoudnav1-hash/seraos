'use client';

import { useState } from 'react';
import {
  ChevronDown,
  CircleDollarSign,
  Database,
  FileText,
  Home,
  LayoutGrid,
  MonitorDot,
  Plus,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { label: 'Command', icon: Home, active: true },
  { label: 'Spaces', icon: LayoutGrid, active: false },
  { label: 'Monitor', icon: MonitorDot, active: false },
];

const GROUPS = [
  { label: 'Financials', icon: CircleDollarSign, items: ['Cash', 'Spend', 'Payables', 'Receivables'] },
  { label: 'Close', icon: Database, items: ['Overview', 'Reconcile', 'Flux Analysis', 'Workbooks'] },
];

export function Sidebar({ onNewChat }: { onNewChat: () => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ Financials: true, Close: true });

  return (
    <aside className="flex h-screen w-[255px] shrink-0 flex-col bg-[#0A0A0A] text-white">
      <div className="flex items-center gap-3 px-6 pb-6 pt-7">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
          <span className="h-3.5 w-3.5 rotate-180 [clip-path:polygon(50%_0,100%_100%,0_100%)] bg-white" />
        </span>
        <span className="text-[22px] font-semibold tracking-tight">Vert</span>
      </div>

      <nav className="space-y-1 px-3">
        {NAV.map(({ label, icon: Icon, active }) => (
          <button
            key={label}
            type="button"
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition',
              active ? 'bg-[#1F1F1F] font-medium text-white shadow-sm' : 'text-white/55 hover:bg-white/5 hover:text-white',
            )}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </nav>

      <div className="mx-6 my-4 border-t border-white/10" />

      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
        {GROUPS.map(({ label, icon: Icon, items }) => (
          <div key={label} className="mb-2">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [label]: !o[label] }))}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] text-white/55 transition hover:text-white"
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              <span className="flex-1 text-left">{label}</span>
              <ChevronDown className={cn('h-4 w-4 transition-transform', !open[label] && '-rotate-90')} />
            </button>
            {open[label] && (
              <div className="ml-[27px] space-y-0.5 border-l border-white/10 pl-4">
                {items.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="block w-full rounded-md px-2 py-[7px] text-left text-[13.5px] text-white/50 transition hover:text-white"
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] text-white/55 transition hover:bg-white/5 hover:text-white"
        >
          <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} />
          Reporting
        </button>
      </div>

      <div className="px-4 pb-5">
        <button
          type="button"
          onClick={onNewChat}
          className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-[14px] font-medium text-[#0A0A0A] transition hover:bg-white/90"
        >
          <Plus className="h-4 w-4" strokeWidth={2.25} />
          New Chat
        </button>
        <div className="flex items-center gap-3 px-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#6b5a4a] to-[#2f2a26] text-[13px] font-semibold">
            AM
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium">Alex Morgan</span>
            <span className="block truncate text-[12px] text-white/45">Finance Manager</span>
          </span>
          <Settings className="h-[18px] w-[18px] text-white/45 transition hover:text-white" strokeWidth={1.75} />
        </div>
      </div>
    </aside>
  );
}
