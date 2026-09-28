/**
 * Runs once when the server starts, before any request. A fresh database gets
 * the demo board here rather than inside the first page render.
 */
export async function register() {
  // The import must sit inside this branch so the edge build drops it.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSeeded } = await import('@/lib/db/seed');
    try {
      await ensureSeeded();
    } catch (err) {
      // Don't wedge the server (e.g. `npm run seed` holds the database); the layout retries and shows the error.
      console.error('[vert] first-boot seed failed:', err instanceof Error ? err.message : err);
    }
  }
}
