import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/integrations/provider';
import { IntegrationConfigError } from '@/lib/integrations/oauth';
import { getConnectionStore } from '@/lib/integrations/store';
import * as quickbooks from '@/lib/integrations/quickbooks';
import * as xero from '@/lib/integrations/xero';

export const dynamic = 'force-dynamic';

/** Revokes the provider tokens, then deletes the stored connection. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = resolveProvider(raw);
  if (!provider) return NextResponse.json({ error: `Unknown provider "${raw}".` }, { status: 404 });

  const { client } = (await req.json().catch(() => ({}))) as { client?: string };
  if (!client) return NextResponse.json({ error: 'Missing client.' }, { status: 400 });

  const store = getConnectionStore();
  const conn = await store.get(provider, client);
  if (!conn) return NextResponse.json({ error: `No ${provider} connection for client ${client}.` }, { status: 401 });

  try {
    if (provider === 'quickbooks') await quickbooks.revokeConnection(conn);
    else await xero.revokeConnection(conn);
  } catch (err) {
    if (err instanceof IntegrationConfigError) return NextResponse.json({ error: err.message }, { status: 400 });
    // Revocation failing (token already dead, provider outage) should not
    // block the local disconnect — the record is deleted below regardless.
  }
  await store.delete(provider, client);
  return NextResponse.json({ disconnected: true });
}
