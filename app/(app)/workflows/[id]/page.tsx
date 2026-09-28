import { notFound } from 'next/navigation';
import { getRun } from '@/lib/agents/orchestrator';
import { WorkflowView } from '@/components/workflow/workflow-view';

export const dynamic = 'force-dynamic';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) notFound();
  return <WorkflowView initial={run} />;
}
