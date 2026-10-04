/**
 * The sandbox runs the real compiler with another parser under it (src/engine/parser.ts). These
 * tests compile the same components with the parser the compiler ships with and with the
 * sandbox's, and expect the same module, the same styles and the same diagnostics.
 *
 * They need the dependencies of the repository root installed, for the native parser.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TYPED, BROKEN } from './fixtures';

type Compiler = typeof import('../../../src/compiler/index');

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const playground = fileURLToPath(new URL('..', import.meta.url));

const native: Compiler = await import('../../../src/compiler/index');
vi.resetModules();
vi.doMock('vite', () => import('../src/engine/parser'));
const sandbox: Compiler = await import('../../../src/compiler/index');

function components(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...components(path));
    else if (entry.name.endsWith('.nexus')) found.push(path);
  }
  return found;
}

function outcome(compiler: Compiler, source: string, filename: string, dev: boolean): unknown {
  try {
    const { js, css, warnings, screen } = compiler.compile(source, { filename, dev });
    return { js: js.code, map: js.map.mappings, css: css && css.code, warnings, screen };
  } catch (error) {
    if (!(error instanceof compiler.CompileError)) throw error;
    return { error: error.diagnostic };
  }
}

const files = [join(repository, 'examples'), join(repository, 'tests/fixtures'), join(repository, 'templates'), join(playground, 'src/examples')].flatMap(components);

describe('the sandbox parser against the native one', () => {
  it('has components to compare', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const file of files) {
    const name = relative(repository, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    it(`compiles ${name} to the same module`, () => {
      for (const dev of [true, false]) expect(outcome(sandbox, source, name, dev)).toEqual(outcome(native, source, name, dev));
    });
  }

  for (const [name, source] of Object.entries(TYPED)) {
    it(`erases the types of "${name}" the same way`, () => {
      const expected = outcome(native, source, 'Typed.nexus', true) as { js?: string };
      expect(expected.js).toBeTypeOf('string');
      expect(outcome(sandbox, source, 'Typed.nexus', true)).toEqual(expected);
    });
  }

  for (const [name, source] of Object.entries(BROKEN)) {
    it(`reports "${name}" at the same place`, () => {
      const expected = (outcome(native, source, 'Broken.nexus', true) as { error?: { code: string; line: number } }).error;
      const actual = (outcome(sandbox, source, 'Broken.nexus', true) as { error?: { code: string; line: number; message: string } }).error;
      expect(expected).toBeDefined();
      expect(actual).toBeDefined();
      expect([actual?.code, actual?.line]).toEqual([expected?.code, expected?.line]);
      expect(actual?.message.length).toBeGreaterThan(0);
    });
  }
});
