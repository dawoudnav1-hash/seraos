import { NextResponse } from 'next/server';
import {
  approveRun,
  archiveRun,
  getRun,
  markViewed,
  rejectRun,
  reopenRun,
  resumeRun,
  sendBack,
} from '@/lib/agents/orchestrator';
import { canTransition, explainRefusal } from '@/lib/domain/state-machine';
import type { RunStatus } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

type Body =
  | { action: 'view' }
  | { action: 'approve' }
  | { action: 'reject'; reason: string }
  | { action: 'send_back'; note: string }
  | { action: 'resolve_blocker'; note?: string }
  | { action: 'archive' }
  | { action: 'move'; to: RunStatus };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 });
  const body = (await req.json()) as Body;

  try {
    switch (body.action) {
      case 'view':
        return NextResponse.json({ run: markViewed(id) });
      case 'approve':
        return NextResponse.json({ run: approveRun(id) });
      case 'reject': {
        const rejected = rejectRun(id, body.reason);
        void reopenRun(id).catch(() => undefined);
        return NextResponse.json({ run: rejected });
      }
      case 'send_back':
        return NextResponse.json({ run: sendBack(id, body.note) });
      case 'resolve_blocker': {
        const resumed = resumeRun(id);
        void resumed.catch(() => undefined);
        return NextResponse.json({ run: getRun(id) });
      }
      case 'archive':
        return NextResponse.json({ run: archiveRun(id) });
      case 'move': {
        if (!canTransition(run.status, body.to, 'human')) {
          return NextResponse.json({ error: explainRefusal(run.status, body.to, 'human') }, { status: 409 });
        }
        if (body.to === 'viewed') return NextResponse.json({ run: markViewed(id) });
        if (body.to === 'approved') return NextResponse.json({ run: approveRun(id) });
        if (body.to === 'archived') return NextResponse.json({ run: archiveRun(id) });
        if (body.to === 'blocked') return NextResponse.json({ run: sendBack(id, 'Sent back from the board.') });
        return NextResponse.json({ error: `Unsupported move to ${body.to}.` }, { status: 400 });
      }
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
