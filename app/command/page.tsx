import { listRuns } from '@/lib/agents/orchestrator';
import { CommandScreen } from '@/components/command-screen';

export const dynamic = 'force-dynamic';

export default function CommandPage() {
  return <CommandScreen initialRuns={listRuns()} />;
}
