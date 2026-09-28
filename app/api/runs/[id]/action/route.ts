import { NextResponse } from 'next/server';
import {
  approveRun,
  archiveRun,
  beginResume,
  getRun,
  markViewed,
  rejectRun,
  reopenRun,
  sendBack,
} from '@/lib/agents/orchestrator';
import { canTransition, explainRefusal } from '@/lib/domain/state-machine';
import type { RunStatus } from '@/lib/domain/types';
import { CURRENT_USER, person } from '@/lib/domain/people';

export const dynamic = 'force-dynamic';

type Body =
  | { action: 'view' }
  | { action: 'approve'; approver?: string }
  | { action: 'reject'; reason: string }
  | { action: 'send_back'; note: string }
  | { action: 'resolve_blocker'; note?: string }
  | { action: 'archive' }
  | { action: 'move'; to: RunStatus };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 });
  const body = (await req.json()) as Body;

  try {
    switch (body.action) {
      case 'view':
        return NextResponse.json({ run: await markViewed(id) });
      case 'approve': {
        const who = person(body.approver ?? CURRENT_USER.id) ?? CURRENT_USER;
        return NextResponse.json({ run: await approveRun(id, { name: who.name, role: who.role }) });
      }
      case 'reject': {
        const rejected = await rejectRun(id, body.reason);
        void reopenRun(id).catch(() => undefined);
        return NextResponse.json({ run: rejected });
      }
      case 'send_back':
        return NextResponse.json({ run: await sendBack(id, body.note) });
      case 'resolve_blocker': {
        // Answer once the unblock is recorded; the agent carries on in the background.
        const { run: resumed } = await beginResume(id);
        return NextResponse.json({ run: resumed });
      }
      case 'archive':
        return NextResponse.json({ run: await archiveRun(id) });
      case 'move': {
        if (!canTransition(run.status, body.to, 'human')) {
          return NextResponse.json({ error: explainRefusal(run.status, body.to, 'human') }, { status: 409 });
        }
        if (body.to === 'viewed') return NextResponse.json({ run: await markViewed(id) });
        if (body.to === 'approved') return NextResponse.json({ run: await approveRun(id) });
        if (body.to === 'archived') return NextResponse.json({ run: await archiveRun(id) });
        if (body.to === 'blocked') return NextResponse.json({ run: await sendBack(id, 'Sent back from the board.') });
        return NextResponse.json({ error: `Unsupported move to ${body.to}.` }, { status: 400 });
      }
      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
