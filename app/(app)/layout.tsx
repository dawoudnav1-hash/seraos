import { listRuns } from '@/lib/agents/orchestrator';
import { Sidebar } from '@/components/shell/sidebar';
import { LiveRuns } from '@/components/shell/live-runs';
import { Toasts } from '@/components/shell/toasts';
import { AskVert } from '@/components/ask-vert';

export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <LiveRuns initialRuns={listRuns()} />
      <Sidebar />
      <div className="min-w-0 flex-1">{children}</div>
      <AskVert />
      <Toasts />
    </div>
  );
}
