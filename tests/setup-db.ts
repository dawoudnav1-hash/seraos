import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each test file gets its own throwaway sqlite file. */
export function useTempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vert-${name}-`));
  process.env.VERT_DB = path.join(dir, 'test.db');
}
