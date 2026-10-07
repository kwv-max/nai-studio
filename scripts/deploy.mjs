// Publishes dist/ to the gh-pages branch, which GitHub Pages serves. Run via `npm run deploy`.
// The branch holds only the built site and is replaced on every deploy.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const out = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const remote = out(['remote', 'get-url', 'origin']);
const rev = out(['rev-parse', '--short', 'HEAD']);
const name = out(['config', 'user.name']);
const email = out(['config', 'user.email']);

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// Plain unlink/rmdir: fs.rmSync crashes Node 24 on Windows for non-ASCII paths (see clean.mjs).
function remove(path) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) remove(join(path, entry));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'nai-studio-pages-'));
const git = (...args) => execFileSync('git', args, { cwd: tmp, stdio: 'inherit' });
try {
  copyDir(dist, tmp);
  writeFileSync(join(tmp, '.nojekyll'), '');
  git('init', '-q', '-b', 'gh-pages');
  git('add', '-A');
  git('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `Deploy ${rev}`);
  git('push', '-q', '--force', remote, 'gh-pages');
  console.log(`Deployed ${rev} to gh-pages.`);
} finally {
  remove(tmp);
}
