import { NextResponse } from 'next/server';
import { resolveProvider } from '@/lib/integrations/provider';
import { IntegrationConfigError } from '@/lib/integrations/oauth';
import * as quickbooks from '@/lib/integrations/quickbooks';
import * as xero from '@/lib/integrations/xero';

export const dynamic = 'force-dynamic';

/** 302s to the provider's authorize page with a signed, expiring `state`. */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await ctx.params;
  const provider = resolveProvider(raw);
  if (!provider) return NextResponse.json({ error: `Unknown provider "${raw}".` }, { status: 404 });

  const client = new URL(req.url).searchParams.get('client');
  if (!client) return NextResponse.json({ error: 'Missing ?client=' }, { status: 400 });

  try {
    const url = provider === 'quickbooks' ? quickbooks.buildAuthorizeUrl(client) : xero.buildAuthorizeUrl(client);
    return NextResponse.redirect(url, { status: 302 });
  } catch (err) {
    if (err instanceof IntegrationConfigError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
