'use client';

import { useMemo } from 'react';
import { useBoard } from '@/lib/store/board';
import { Board } from '@/components/board';

export function WorkflowBoard() {
  const runs = useBoard((s) => s.runs);
  const list = useMemo(() => Object.values(runs).filter((r) => r.status !== 'archived'), [runs]);
  return <Board runs={list} />;
}
