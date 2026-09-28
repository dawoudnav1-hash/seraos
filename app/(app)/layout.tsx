import { listRuns } from '@/lib/agents/orchestrator';
import { ensureSeeded } from '@/lib/db/seed';
import { Sidebar } from '@/components/shell/sidebar';
import { LiveRuns } from '@/components/shell/live-runs';
import { Toasts } from '@/components/shell/toasts';
import { AskVert } from '@/components/ask-vert';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // A fresh database gets the demo board on first boot (normally already done by
  // instrumentation.ts at server start); `npm run seed` cannot run beside the server.
  await ensureSeeded();
  const runs = await listRuns();
  return (
    <div className="flex min-h-screen bg-canvas">
      <LiveRuns initialRuns={runs} />
      <Sidebar />
      <div className="min-w-0 flex-1">{children}</div>
      <AskVert />
      <Toasts />
    </div>
  );
}
