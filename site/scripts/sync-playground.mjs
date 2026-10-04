import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(siteRoot, 'playground/dist');
const stub = join(siteRoot, 'scripts/playground-stub');
const outDir = join(siteRoot, 'public/sandbox');

/**
 * Puts the sandbox where the site serves it from, /sandbox/. The sandbox is built on its own,
 * in playground/. Until that build exists, a stand-in with the same `mount` takes its place,
 * so the pages that embed it still build and say that the sandbox is missing. The page that
 * comes with the build is left out: the site has its own at /playground/.
 */
export function syncPlayground() {
  const source = existsSync(join(built, 'playground.js')) ? built : stub;
  rmSync(outDir, { recursive: true, force: true });
  cpSync(source, outDir, { recursive: true, filter: (path) => path !== join(source, 'index.html') });
  return source === built ? 'playground/dist' : 'the stand-in';
}
