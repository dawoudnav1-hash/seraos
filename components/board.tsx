'use client';

import { useEffect, useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { BOARD_COLUMNS, columnFor } from '@/lib/domain/reducer';
import { canTransition, explainRefusal } from '@/lib/domain/state-machine';
import { useBoard } from '@/lib/store/board';
import type { RunStatus, RunView } from '@/lib/domain/types';
import { RunCard } from './run-card';

const DOT_CLASS = { none: '', red: 'bg-red-500', green: 'bg-emerald-500', gray: '' } as const;

/** The status a human drop implies for each column. */
const DROP_TARGET: Record<string, RunStatus> = {
  in_progress: 'executing',
  needs_attention: 'blocked',
  ready_for_review: 'review_ready',
  viewed: 'viewed',
};

function Column({ id, label, dot, runs, now }: { id: string; label: string; dot: keyof typeof DOT_CLASS; runs: RunView[]; now: number }) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex w-[300px] shrink-0 flex-col rounded-2xl border border-line bg-white/60 transition',
        isOver && 'border-accent-line bg-accent-soft/40',
      )}
    >
      <header className="flex items-center gap-2 px-4 py-3.5">
        {DOT_CLASS[dot] && <span className={cn('h-[7px] w-[7px] rounded-full', DOT_CLASS[dot])} />}
        <h2 className="text-[14px] font-medium text-ink">{label}</h2>
        <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11.5px] font-medium tabular-nums text-muted">{runs.length}</span>
      </header>
      <div className="space-y-2.5 px-2.5 pb-3">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} now={now} />
        ))}
      </div>
    </section>
  );
}

export function Board({ runs }: { runs: RunView[] }) {
  const { toast, move } = useBoard();
  const [dragging, setDragging] = useState<RunView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const byColumn = useMemo(() => {
    const map: Record<string, RunView[]> = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, []]));
    for (const run of runs) {
      const col = columnFor(run.status);
      if (col) map[col].push(run);
    }
    for (const list of Object.values(map)) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [runs]);

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const run = runs.find((r) => r.id === e.active.id);
    const columnId = e.over?.id as string | undefined;
    if (!run || !columnId) return;
    if (columnFor(run.status) === columnId) return;
    const to = DROP_TARGET[columnId];
    if (!canTransition(run.status, to, 'human')) {
      toast(explainRefusal(run.status, to, 'human'));
      return;
    }
    void move(run.id, to);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDragging(runs.find((r) => r.id === e.active.id) ?? null)}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="scroll-thin flex items-start gap-3 overflow-x-auto pb-6">
        {BOARD_COLUMNS.map((c) => (
          <Column key={c.id} id={c.id} label={c.label} dot={c.dot} runs={byColumn[c.id] ?? []} now={now} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="w-[280px] rotate-1">
            <RunCard run={dragging} now={now} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
