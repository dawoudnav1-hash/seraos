'use client';

import { CircleDot, Sparkles, User } from 'lucide-react';
import type { RunView } from '@/lib/domain/types';
import { cn } from '@/lib/utils';
import { clock, type LoggedEvent } from './use-events';

interface Line {
  actor: string;
  kind: 'ai' | 'human' | 'system';
  text: string;
}

/** Turns the event log into who-did-what lines; AI and human activity side by side. */
export function describe(e: LoggedEvent, run: RunView): Line | null {
  const p = e.payload as Record<string, unknown>;
  const step = (id: unknown) => run.steps.find((s) => s.id === id)?.title ?? String(id);
  switch (e.type) {
    case 'clarification_requested':
      return { actor: run.agent, kind: 'ai', text: `Asked ${(p.questions as unknown[]).length} clarifying questions` };
    case 'clarification_answered': {
      const q = run.clarifications.find((c) => c.id === p.questionId);
      return { actor: 'Alex Morgan', kind: 'human', text: `Answered “${q?.question ?? p.questionId}” — ${String(p.answer)}` };
    }
    case 'context_uploaded':
      return { actor: 'Alex Morgan', kind: 'human', text: `Uploaded ${String(p.filename)}` };
    case 'plan_created':
      return { actor: run.agent, kind: 'ai', text: `Planned ${(p.steps as unknown[]).length} steps` };
    case 'step_started':
      return { actor: String(p.agent), kind: 'ai', text: `Started “${step(p.stepId)}”` };
    case 'tool_result':
      return { actor: run.agent, kind: 'ai', text: String(p.summary) };
    case 'artifact_created':
      return { actor: run.agent, kind: 'ai', text: `Wrote ${String((p.artifact as { filename: string }).filename)}` };
    case 'blocked':
      return { actor: run.agent, kind: 'ai', text: `Stopped: ${String((p.blocker as { title: string }).title)}` };
    case 'unblocked':
      return { actor: 'Alex Morgan', kind: 'human', text: 'Resolved the blocker' };
    case 'run_completed':
      return { actor: run.agent, kind: 'ai', text: 'Handed in the workpapers for review' };
    case 'run_failed':
      return { actor: 'System', kind: 'system', text: `Run failed: ${String(p.error)}` };
    case 'human_viewed':
      return { actor: 'Alex Morgan', kind: 'human', text: 'Marked for review' };
    case 'human_approved':
      return { actor: String(p.by), kind: 'human', text: `Approved as ${String(p.role)}` };
    case 'human_rejected':
      return { actor: String(p.by ?? 'Alex Morgan'), kind: 'human', text: `Requested changes: ${String(p.reason)}` };
    case 'human_archived':
      return { actor: 'Alex Morgan', kind: 'human', text: 'Archived the workflow' };
    default:
      return null;
  }
}

export function AuditTrail({ events, run, compact = false }: { events: LoggedEvent[]; run: RunView; compact?: boolean }) {
  const lines = events
    .map((e) => ({ e, line: describe(e, run) }))
    .filter((x): x is { e: LoggedEvent; line: Line } => x.line !== null)
    .reverse();
  if (lines.length === 0) return <p className="text-[13px] text-muted">No activity yet.</p>;
  return (
    <ol className={cn('space-y-3', compact && 'max-h-[320px] overflow-y-auto pr-1')}>
      {lines.map(({ e, line }) => (
        <li key={e.seq} className="flex gap-3">
          <span className="mt-0.5 shrink-0">
            {line.kind === 'ai' ? (
              <Sparkles className="h-4 w-4 text-accent" fill="currentColor" />
            ) : line.kind === 'human' ? (
              <User className="h-4 w-4 text-ink/60" />
            ) : (
              <CircleDot className="h-4 w-4 text-faint" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium text-ink">{line.actor}</span>
              <span className={cn('rounded px-1.5 text-[11px]', line.kind === 'ai' ? 'bg-accent-soft text-accent' : line.kind === 'human' ? 'bg-neutral-100 text-muted' : 'bg-neutral-100 text-faint')}>
                {line.kind === 'ai' ? 'AI agent' : line.kind === 'human' ? 'Human' : 'System'}
              </span>
              <span className="ml-auto text-[11.5px] text-faint">{clock(e.at)}</span>
            </span>
            <span className="mt-0.5 block text-[13px] leading-snug text-ink/75">{line.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
