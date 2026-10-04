import { describe, expect, it, vi } from 'vitest';

// As in the browser: the compiler gets the sandbox's parser instead of Vite's.
vi.mock('vite', () => import('../src/engine/parser'));

const { build } = await import('../src/engine/build');
const { CHANNEL, MODULE_LINE_OFFSET, MODULE_URL, fromFrame } = await import('../src/engine/protocol');
const { decodeProject, encodeProject } = await import('../src/engine/share');
const { locateError } = await import('../src/engine/session');
const { sanitise } = await import('../src/engine/project');
const { EXAMPLES } = await import('../src/examples');

function built(files: Record<string, string>) {
  const result = build(files);
  if (!result.ok) throw new Error(result.problems.map((problem) => `${problem.file}:${problem.line}: ${problem.message}`).join('\n'));
  return result.build;
}

/** Where `text` is in the code the frame runs, as a stack trace would name it. */
function stackAt(code: string, file: string, text: string): string {
  const lines = code.split('\n');
  const line = lines.findIndex((entry) => entry.includes(text));
  expect(line).toBeGreaterThan(-1);
  return `Error: boom\n    at run (${MODULE_URL}${file}:${line + 1 + MODULE_LINE_OFFSET}:${(lines[line] as string).indexOf(text) + 1})`;
}

describe('the examples', () => {
  it('are the eight of the menu', () => {
    expect(EXAMPLES.map((example) => example.name)).toEqual(['counter', 'list', 'form', 'call', 'hud', 'transition', 'keys', 'component']);
  });

  for (const example of EXAMPLES) {
    it(`${example.name} builds without a warning`, () => {
      const result = built(example.files);
      expect(result.warnings).toEqual([]);
      expect(Object.keys(result.modules).sort()).toEqual(Object.keys(example.files).sort());
      for (const module of Object.values(result.modules)) expect(module.code).not.toMatch(/^\s*(import|export)\s/m);
    });
  }
});

describe('build', () => {
  const main = '---\nimport { signal } from "nexus";\nconst count = signal(0);\n---\n<p>{count}</p>\n';

  it('reports a compile error with its file, line and frame', () => {
    const result = build({ 'Main.nexus': '<p>{count +}</p>\n' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatchObject({ severity: 'error', file: 'Main.nexus', line: 1, code: 'expression-syntax' });
    expect(result.problems[0]?.frame).toContain('> 1 | <p>{count +}</p>');
  });

  it('reports an error in the contract next to one in the screen', () => {
    const result = build({ 'Main.nexus': '<p>', 'contract.ts': 'export default contract({' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((problem) => problem.file)).toEqual(['Main.nexus', 'contract.ts']);
  });

  it('names an import it cannot satisfy where it was written', () => {
    const result = build({ 'Main.nexus': '---\nimport { signal } from "nexus";\nimport Card from "./Card.nexus";\n---\n<Card />\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatchObject({ code: 'unknown-import', file: 'Main.nexus', line: 3 });
  });

  it('removes the types of a TypeScript file and keeps its exports', () => {
    const { modules } = built({
      'Main.nexus': main,
      'format.ts': 'import type { A } from "./types";\nexport interface B { a: A }\nexport const money = (value: number): string => `$${value}`;\nexport default function label(text: string) { return text as string; }\n',
    });
    expect(modules['format.ts']?.code).toContain('$export({ money: () => money, default: () => label });');
    expect(modules['format.ts']?.code).toContain('const money = (value) => `$${value}`;');
    expect(modules['format.ts']?.code).not.toContain('interface');
  });

  it('refuses TypeScript that generates code, as the compiler does', () => {
    const result = build({ 'Main.nexus': main, 'mock.ts': 'enum Tab { Home }\nexport default Tab;\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatchObject({ file: 'mock.ts', line: 1, code: 'unsupported-typescript' });
  });

  it('traces an error of the running code back to the line the visitor wrote', () => {
    const counter = EXAMPLES.find((example) => example.name === 'counter')?.files ?? {};
    const result = built(counter);
    const stack = stackAt(result.modules['Main.nexus']?.code ?? '', 'Main.nexus', 'count.value * 2');
    const written = (counter['Main.nexus'] ?? '').split('\n').findIndex((line) => line.includes('count.value * 2')) + 1;
    expect(locateError(result, { name: 'TypeError', message: 'boom', stack })).toMatchObject({ file: 'Main.nexus', line: written, message: 'TypeError: boom' });
  });

  it('traces an error in a TypeScript file past the types that were removed', () => {
    const files = { 'Main.nexus': main, 'mock.ts': 'interface Wallet {\n  cash: number;\n}\n\nconst wallet: Wallet = { cash: 1 };\nexport default wallet.missing.cash;\n' };
    const result = built(files);
    const stack = stackAt(result.modules['mock.ts']?.code ?? '', 'mock.ts', 'wallet.missing');
    expect(locateError(result, { name: 'TypeError', message: 'boom', stack })).toMatchObject({ file: 'mock.ts', line: 6 });
  });
});

describe('a message of the frame', () => {
  const wrap = (message: unknown): unknown => ({ channel: CHANNEL, message });

  it('is read field by field, whatever the frame posted', () => {
    expect(fromFrame(wrap({ type: 'opened', names: 'main' }))).toEqual({ type: 'opened', names: [] });
    expect(fromFrame(wrap({ type: 'error', message: { toString: 1 } }))).toEqual({ type: 'error', name: '', message: '', stack: '' });
    expect(fromFrame(wrap({ type: 'console', level: 'table', text: 7 }))).toEqual({ type: 'console', level: 'log', text: '' });
    expect(fromFrame(wrap({ type: 'crossed', kind: 'call', name: 'a', data: '{}', answer: { ok: 'yes', data: [] }, ms: '3' }))).toEqual({
      type: 'crossed',
      kind: 'call',
      name: 'a',
      data: '{}',
      answer: { ok: false, code: '', message: '', data: '' },
    });
  });

  it('is dropped when it is of no known kind', () => {
    expect(fromFrame(wrap({ type: 'navigate', to: '/' }))).toBeNull();
    expect(fromFrame(wrap({ type: 'crossed', kind: 'eval' }))).toBeNull();
    expect(fromFrame(wrap({ type: 'action-added', id: '1', label: 'x' }))).toBeNull();
    expect(fromFrame({ type: 'mounted' })).toBeNull();
    expect(fromFrame(null)).toBeNull();
  });
});

describe('a shared link', () => {
  it('restores the files it was made from', async () => {
    for (const example of EXAMPLES) expect(await decodeProject(await encodeProject(example.files))).toEqual(example.files);
  });

  it('is nothing when it is not a project', async () => {
    expect(await decodeProject('z1.not-deflate')).toBeNull();
    expect(await decodeProject('hello')).toBeNull();
    expect(await decodeProject(await encodeProject({ 'Other.nexus': '<p></p>' }))).toBeNull();
  });

  it('keeps only files a project can hold', () => {
    expect(sanitise({ 'Main.nexus': '<p></p>', '../escape.ts': 'x', 'index.html': 'x', 'mock.ts': 1, 'data.json': '{}' })).toEqual({ 'Main.nexus': '<p></p>', 'data.json': '{}' });
    expect(sanitise({ 'Main.nexus': 'x'.repeat(70000) })).toBeNull();
  });
});
