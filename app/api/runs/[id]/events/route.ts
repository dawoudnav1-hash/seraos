import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** The raw event log behind a run — the drawer's timeline reads straight from it. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rows = db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, id))
    .orderBy(asc(schema.runEvents.seq))
    .all();
  return NextResponse.json({
    events: rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at, payload: JSON.parse(r.payload) })),
  });
}
