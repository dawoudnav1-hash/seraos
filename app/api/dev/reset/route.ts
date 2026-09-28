import { NextResponse } from 'next/server';
import { resetAndSeed } from '@/lib/db/seed';

export const dynamic = 'force-dynamic';

/**
 * Dev only: reseeds the demo board inside the running server. `npm run seed`
 * cannot open the embedded database while the dev server holds it.
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const { runs } = await resetAndSeed();
  return NextResponse.json({ ok: true, runs: runs.map((r) => ({ id: r.id, status: r.status })) });
}
