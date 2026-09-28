/**
 * Gives the calling test file its own in-memory Postgres (PGlite). Await it at
 * the top of the file, before the first query: creating the database takes a
 * few seconds, which would otherwise count against the first test's timeout.
 *
 * Set VERT_TEST_DATABASE_URL to run the same tests against a real Postgres
 * server instead (files then share that database, so use unique ids).
 */
export async function useTestDb() {
  const url = process.env.VERT_TEST_DATABASE_URL;
  if (url) {
    process.env.DATABASE_URL = url;
  } else {
    delete process.env.DATABASE_URL;
    process.env.VERT_DB = 'memory';
  }
  const { closeDb, getDb } = await import('@/lib/db');
  const { forgetProjections } = await import('@/lib/agents/store');
  // Drop anything a previous file left in this worker.
  await closeDb();
  forgetProjections();
  return getDb();
}

/** The old name, kept so tests written against it still compile. */
export const useTempDb = (_name?: string) => useTestDb();
