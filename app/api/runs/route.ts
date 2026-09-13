import { NextResponse } from 'next/server';
import { listRuns, startRun } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { title?: string; task?: string };
  if (!body.task?.trim()) return NextResponse.json({ error: 'A task is required.' }, { status: 400 });
  const title = body.title?.trim() || toTitle(body.task);
  // Streams in the background; the client watches /api/stream.
  const started = startRun({ title, task: body.task });
  const run = await Promise.race([started, waitForCreation(started)]);
  return NextResponse.json({ run });
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
