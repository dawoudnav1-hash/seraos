import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRun, uploadContext } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 20 * 1024 * 1024;

/** Stores a context file next to the run and records it on the event log. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await getRun(id))) return NextResponse.json({ error: 'Unknown workflow.' }, { status: 404 });
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Attach a file.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Files are limited to 20 MB.' }, { status: 413 });
  const safe = path.basename(file.name).replace(/[^\w.\- ]+/g, '_');
  const dir = path.join(process.cwd(), 'uploads', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, safe), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ run: await uploadContext(id, safe) });
}
