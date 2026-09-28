import { NextResponse } from 'next/server';
import { getRun, listRuns, newRunId, startRun } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { title?: string; task?: string; client?: string };
  if (!body.task?.trim()) return NextResponse.json({ error: 'Describe what the workflow should do.' }, { status: 400 });
  const title = body.title?.trim() || toTitle(body.task);
  const id = newRunId();
  // Streams in the background; the client watches /api/stream.
  const started = startRun({ id, title, task: body.task, client: body.client?.trim() || 'Brevard Logistics' });
  await Promise.race([started, waitForCreation(started)]);
  return NextResponse.json({ id, run: getRun(id) });
}

function toTitle(task: string): string {
  const t = task.trim().replace(/\s+/g, ' ');
  return t.length > 64 ? `${t.slice(0, 61)}…` : t.charAt(0).toUpperCase() + t.slice(1);
}

/** Return as soon as the run exists rather than waiting for it to finish. */
function waitForCreation<T>(p: Promise<T>): Promise<null> {
  void p.catch(() => undefined);
  return new Promise((resolve) => setTimeout(() => resolve(null), 400));
}
