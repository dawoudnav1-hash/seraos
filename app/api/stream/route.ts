import { listRuns, subscribe } from '@/lib/agents/orchestrator';

export const dynamic = 'force-dynamic';

/** One SSE channel for the whole board: a snapshot, then every run event. */
export async function GET() {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          unsubscribe();
        }
      };
      send('snapshot', { runs: listRuns() });
      unsubscribe = subscribe((runId, event, run) => send('run', { runId, event, run }));
      const beat = setInterval(() => send('ping', { at: Date.now() }), 20_000);
      const stop = unsubscribe;
      unsubscribe = () => {
        clearInterval(beat);
        stop();
      };
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
