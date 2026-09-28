import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/integrations/provider';
import { getConnectionStore } from '@/lib/integrations/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = resolveProvider(raw);
  if (!provider) return NextResponse.json({ error: `Unknown provider "${raw}".` }, { status: 404 });

  const client = new URL(req.url).searchParams.get('client');
  if (!client) return NextResponse.json({ error: 'Missing ?client=' }, { status: 400 });

  const conn = await getConnectionStore().get(provider, client);
  if (!conn) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: conn.status === 'connected',
    status: conn.status,
    externalId: conn.externalId,
    scopes: conn.scopes,
    connectedAt: conn.connectedAt,
    updatedAt: conn.updatedAt,
    lastSyncAt: conn.lastSyncAt,
  });
}
