import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, test } from 'vitest';
import { build, minifySync, parseSync } from 'vite';

const runtime = resolve(fileURLToPath(import.meta.url), '../../../src/runtime');
const entry = join(runtime, 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'nexus-ui-size-'));

// The exports that make up the bridge. Everything else is "the runtime without the bridge".
const BRIDGE = new Set(['nui', 'NuiError', 'start']);

// The screen manager is not part of the bridge, but in a build only the bridge reaches it. It is
// named here so that the figure without the bridge still counts it.
const SCREENS = `export { openScreen, closeScreen } from ${JSON.stringify(pathToFileURL(join(runtime, 'screens.ts')).href)};`;

/** The names the runtime exports as values, read from its index. */
function exportedValues(): string[] {
  const { module } = parseSync(entry, readFileSync(entry, 'utf8'), { lang: 'ts' });
  return module.staticExports.flatMap((statement) => statement.entries.filter((item) => !item.isType).map((item) => item.exportName.name as string));
}

/**
 * Bundles a module that uses the given exports for Chromium 103, minifies it the way a project's
 * build does and returns the gzipped size. The minifier runs separately because a library build
 * keeps its whitespace.
 */
async function gzipped(names: string[], file: string, also = ''): Promise<number> {
  const input = join(work, file);
  writeFileSync(input, `export { ${names.join(', ')} } from ${JSON.stringify(pathToFileURL(entry).href)};\n${also}\n`);
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'globalThis.__NEXUS_DEV__': 'false' },
    build: { write: false, minify: false, target: 'chrome103', lib: { entry: input, formats: ['es'] } },
  });
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => ('output' in result ? result.output : []));
  const code = chunks.map((chunk) => ('code' in chunk ? chunk.code : '')).join('');
  return gzipSync(minifySync('runtime.js', code).code).length;
}

describe('runtime size', () => {
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test('stays under 6 KB without the bridge and under 9 KB with it, minified and gzipped', async () => {
    const names = exportedValues();
    expect(names).toContain('$each');
    expect(names).toContain('nui');

    const core = await gzipped(names.filter((name) => !BRIDGE.has(name)), 'core.js', SCREENS);
    const full = await gzipped(names, 'full.js');
    console.info(`runtime: ${core} bytes without the bridge, ${full} bytes with it (minified, gzipped)`);

    expect(core).toBeLessThan(6 * 1024);
    expect(full).toBeLessThan(9 * 1024);
    expect(full).toBeGreaterThan(core);
  }, 60000);
});
