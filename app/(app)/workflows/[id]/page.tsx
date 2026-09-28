import { notFound } from 'next/navigation';
import { getRun } from '@/lib/agents/orchestrator';
import { ensureSeeded } from '@/lib/db/seed';
import { WorkflowView } from '@/components/workflow/workflow-view';

export const dynamic = 'force-dynamic';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Pages render alongside the layout, so wait for first-boot seeding here too.
  await ensureSeeded();
  const run = await getRun(id);
  if (!run) notFound();
  return <WorkflowView initial={run} />;
}
