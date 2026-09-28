import { CommandHeader } from '@/components/command/header';
import { WorkflowBoard } from '@/components/command/workflow-board';

export const dynamic = 'force-dynamic';

export default function CommandPage() {
  return (
    <main className="mx-auto max-w-[1440px] space-y-6 px-8 pt-7">
      <CommandHeader />
      <WorkflowBoard />
    </main>
  );
}
