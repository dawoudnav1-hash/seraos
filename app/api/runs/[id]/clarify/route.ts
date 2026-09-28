import { NextResponse } from 'next/server';
import { answerClarification, getRun } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

/** Answers one clarifying question; the last answer starts planning in the background. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { questionId, answer } = (await req.json()) as { questionId?: string; answer?: string };
  if (!questionId || typeof answer !== 'string') return NextResponse.json({ error: 'Answer a question.' }, { status: 400 });
  try {
    const pending = answerClarification(id, questionId, answer);
    // Planning can take a while; return once the answer is recorded.
    await Promise.race([pending, new Promise((r) => setTimeout(r, 150))]);
    void pending.catch(() => undefined);
    return NextResponse.json({ run: getRun(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
