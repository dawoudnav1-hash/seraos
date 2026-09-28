import { closeDb, dbLocation } from '../lib/db';
import { resetAndSeed } from '../lib/db/seed';

/** Resets run data and seeds the demo board directly in the database. */
async function main() {
  console.log(`Seeding ${await dbLocation()}`);
  await resetAndSeed((line) => console.log(line));
  // Close cleanly so PGlite checkpoints and releases its directory.
  await closeDb();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    if ((err as { code?: string }).code === 'DB_LOCKED') {
      const { dir, pid } = err as { dir: string; pid: number };
      console.error(
        [
          '',
          `Cannot seed: the embedded database at ${dir} is open in another process (pid ${pid}), most likely the dev server.`,
          'PGlite is single-process, so the two cannot share it. Either:',
          '  • stop the dev server (Ctrl+C in its terminal) and run `npm run seed` again, or',
          '  • leave it running and reseed in place: curl -X POST http://localhost:3000/api/dev/reset',
          `If pid ${pid} is not a Vert process, the lock is stale: delete ${dir}/vert.lock.`,
          '',
        ].join('\n'),
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
