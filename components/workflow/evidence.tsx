'use client';

import { useState } from 'react';
import { Database } from 'lucide-react';
import type { EvidenceTable, RunView } from '@/lib/domain/types';
import { cn } from '@/lib/utils';

/**
 * An agent-built table. Click a row's figures to see exactly which ledger
 * records, tool and step they came from.
 */
export function Evidence({ table, run, heading = 'h2' }: { table: EvidenceTable; run: RunView; heading?: 'h2' | 'h3' }) {
  const [open, setOpen] = useState<number | null>(null);
  const step = run.steps.find((s) => s.id === table.stepId);
  const H = heading;
  return (
    <section className="mb-10">
      <H className={cn('text-ink', heading === 'h2' ? 'mb-4 text-[20px] font-normal' : 'mb-3 text-[15.5px] font-normal')}>{table.title}</H>
      {table.caption && <p className="-mt-2 mb-3 text-[13px] text-muted">{table.caption}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse border border-line text-[13.5px]">
          <thead>
            <tr className="bg-neutral-50">
              {table.columns.map((c) => (
                <th key={c} className="border border-line px-3.5 py-3 text-left font-normal text-ink/80">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr
                key={i}
                onClick={() => row.source && setOpen(open === i ? null : i)}
                className={cn(row.source && 'cursor-pointer hover:bg-accent-soft/40', open === i && 'bg-accent-soft/60', row.emphasis && 'font-medium')}
              >
                {row.cells.map((cell, j) => (
                  <td key={j} className={cn('border border-line px-3.5 py-3.5 align-top text-ink/85', /[$\d(]/.test(String(cell)) && j > 0 && 'tabular-nums')}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open !== null && table.rows[open]?.source && (
        <div className="mt-2 flex items-start gap-3 rounded-xl border border-accent-line bg-accent-soft/50 px-4 py-3 text-[13px]">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="text-ink/80">
            <span className="font-medium text-ink">Source records:</span> {table.rows[open].source}
            {table.tool && (
              <>
                {' '}
                · pulled with <code className="rounded bg-white px-1 font-mono text-[12px]">{table.tool}</code>
              </>
            )}
            {step && <> in step “{step.title}”</>}
          </p>
        </div>
      )}
    </section>
  );
}

/** Tables in order, with consecutive tables of one section under a shared heading. */
export function EvidenceSections({ run }: { run: RunView }) {
  const out: React.ReactNode[] = [];
  let lastSection: string | undefined;
  run.tables.forEach((t) => {
    if (t.section && t.section !== lastSection) {
      out.push(
        <h2 key={`sec-${t.id}`} className="mb-4 text-[20px] font-normal text-ink">
          {t.section}
        </h2>,
      );
    }
    lastSection = t.section;
    out.push(<Evidence key={t.id} table={t} run={run} heading={t.section ? 'h3' : 'h2'} />);
  });
  return <>{out}</>;
}
