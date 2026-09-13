import { NextResponse } from 'next/server';
import { routeTask, SPECIALIST_REGISTRY } from '@/lib/agents/specialists';

export const dynamic = 'force-dynamic';

/** Ask Vert's dry run: which specialist, which steps, what it will need from you. */
export async function POST(req: Request) {
  const { task } = (await req.json()) as { task?: string };
  if (!task?.trim()) return NextResponse.json({ error: 'Describe the task first.' }, { status: 400 });
  const specialist = routeTask(task);
  const spec = SPECIALIST_REGISTRY[specialist];
  const steps = spec.plan(task).map((s, i) => ({ ...s, id: `preview_${i + 1}`, status: 'pending' as const }));
  const tools = [...new Set(steps.flatMap((s) => s.tools))];
  const needs: string[] = [];
  if (tools.includes('parseDocument')) needs.push('Source documents, if they are not already in the drive');
  if (tools.includes('postJournalEntry')) needs.push('Your approval before anything posts to the ledger');
  needs.push('A review and sign-off when the draft is ready');
  return NextResponse.json({ specialist, steps, tools, needs, systemPrompt: spec.systemPrompt });
}
