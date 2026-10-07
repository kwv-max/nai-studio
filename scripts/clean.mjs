// Deletes dist/ one entry at a time.
// fs.rmSync (which Vite uses to empty outDir) crashes Node 24 on Windows for this project's
// non-ASCII path (exit code 0xC0000409), so the build cleans with unlink/rmdir instead.
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function remove(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) remove(join(path, name));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) remove(dist);
