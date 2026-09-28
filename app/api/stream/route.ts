import { listRuns, subscribe } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

/** One SSE channel for the whole board: a snapshot, then every run event. */
export async function GET() {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          unsubscribe();
        }
      };
      // Listen before reading the snapshot so nothing that lands meanwhile is lost;
      // hold those events until the snapshot has gone out.
      let held: unknown[] | null = [];
      const stop = subscribe((runId, event, run) => {
        const payload = { runId, event, run };
        if (held) held.push(payload);
        else send('run', payload);
      });
      const beat = setInterval(() => send('ping', { at: Date.now() }), 20_000);
      unsubscribe = () => {
        clearInterval(beat);
        stop();
      };
      try {
        send('snapshot', { runs: await listRuns() });
      } catch (err) {
        unsubscribe();
        controller.error(err);
        return;
      }
      for (const payload of held) send('run', payload);
      held = null;
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
