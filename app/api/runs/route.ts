import { NextResponse } from 'next/server';
import { beginRun, getRun, listRuns, newRunId } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ runs: await listRuns() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { title?: string; task?: string; client?: string };
  if (!body.task?.trim()) return NextResponse.json({ error: 'Describe what the workflow should do.' }, { status: 400 });
  const title = body.title?.trim() || toTitle(body.task);
  const id = newRunId();
  // Streams in the background; the client watches /api/stream.
  const { done } = await beginRun({ id, title, task: body.task, client: body.client?.trim() || 'Brevard Logistics' });
  // Give a quick run a moment to show progress rather than answering with an empty card.
  await Promise.race([done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 400))]);
  return NextResponse.json({ id, run: await getRun(id) });
}

function toTitle(task: string): string {
  const t = task.trim().replace(/\s+/g, ' ');
  return t.length > 64 ? `${t.slice(0, 61)}…` : t.charAt(0).toUpperCase() + t.slice(1);
}
