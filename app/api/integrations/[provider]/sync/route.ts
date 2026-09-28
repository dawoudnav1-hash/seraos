import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/integrations/provider';
import { IntegrationConfigError } from '@/lib/integrations/oauth';
import { getConnectionStore } from '@/lib/integrations/store';
import { syncClient } from '@/lib/integrations/sync';

export const dynamic = 'force-dynamic';

/** Full-then-incremental sync into the LedgerSink warehouse; returns row counts per entity. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = resolveProvider(raw);
  if (!provider) return NextResponse.json({ error: `Unknown provider "${raw}".` }, { status: 404 });

  const client = new URL(req.url).searchParams.get('client');
  if (!client) return NextResponse.json({ error: 'Missing ?client=' }, { status: 400 });

  try {
    const counts = await syncClient(provider, client);
    const store = getConnectionStore();
    const conn = await store.get(provider, client);
    if (conn) await store.put({ ...conn, lastSyncAt: new Date().toISOString() });
    return NextResponse.json({ synced: true, counts });
  } catch (err) {
    if (err instanceof IntegrationConfigError) {
      const status = /No connected/.test(err.message) ? 401 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
