import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/integrations/provider';
import { IntegrationConfigError, OAuthStateError } from '@/lib/integrations/oauth';
import { getConnectionStore } from '@/lib/integrations/store';
import * as quickbooks from '@/lib/integrations/quickbooks';
import * as xero from '@/lib/integrations/xero';

export const dynamic = 'force-dynamic';

/** Verifies `state`, exchanges the code, stores the connection, then redirects into the app. */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = resolveProvider(raw);
  if (!provider) return NextResponse.json({ error: `Unknown provider "${raw}".` }, { status: 404 });

  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return NextResponse.json({ error: 'Missing code or state.' }, { status: 400 });

  try {
    const connection =
      provider === 'quickbooks'
        ? await quickbooks.handleCallback({ code, state, realmId: params.get('realmId') ?? '' })
        : await xero.handleCallback({ code, state });
    await getConnectionStore().put(connection);
    return NextResponse.redirect(new URL(`/command?connected=${provider}`, req.url), { status: 302 });
  } catch (err) {
    if (err instanceof OAuthStateError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof IntegrationConfigError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
