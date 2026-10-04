import { SourceMap } from 'node:module';
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler';

const source = [
  '---',
  "import { signal } from 'nexus';",
  '',
  'interface Props { title: string }',
  '',
  'const count = signal<number>(0);',
  'function increment(): void {',
  '  count.value++;',
  '}',
  '---',
  '',
  '<main>',
  '  <h1 title={props.title}>{count}</h1>',
  '  {#each [1, 2] as n}',
  '    <button on:click={increment}>{n * count.value}</button>',
  '  {/each}',
  '</main>',
  '',
  '<style>',
  '  h1 { color: red; }',
  '  button:hover { color: blue; }',
  '</style>',
  '',
].join('\n');

interface Position {
  line: number;
  column: number;
}

/** The 1-based position of `text` in `code`: its first occurrence, or the one after `after`. */
function find(code: string, text: string, after = ''): Position {
  const index = code.indexOf(text, after ? code.indexOf(after) : 0);
  if (index === -1) throw new Error(`"${text}" is not in the code`);
  const before = code.slice(0, index).split('\n');
  return { line: before.length, column: (before[before.length - 1] as string).length + 1 };
}

function original(map: SourceMap, position: Position): Position & { file: string } {
  const entry = map.findEntry(position.line - 1, position.column - 1) as { originalSource: string; originalLine: number; originalColumn: number };
  return { file: entry.originalSource, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
}

describe('source maps', () => {
  const result = compile(source, { filename: 'web/screens/Shop.nexus', css: 'external' });
  const js = new SourceMap(JSON.parse(result.js.map.toString()));
  const css = new SourceMap(JSON.parse(result.css!.map.toString()));

  test('the map names the file and carries its content', () => {
    expect(result.js.map.sources).toEqual(['web/screens/Shop.nexus']);
    expect(result.js.map.sourcesContent).toEqual([source]);
    expect(result.css!.map.sources).toEqual(['web/screens/Shop.nexus']);
  });

  const scriptTokens = ['signal }', 'const count', 'function increment', 'count.value++'];
  test.each(scriptTokens)('script: "%s" maps to where it was written', (token) => {
    expect(original(js, find(result.js.code, token))).toEqual({ file: 'web/screens/Shop.nexus', ...find(source, token) });
  });

  test('script: code after a removed type still maps to its own column', () => {
    expect(result.js.code).toContain('const count = signal(0);');
    expect(original(js, find(result.js.code, '(0);'))).toMatchObject(find(source, '(0);'));
    expect(original(js, find(result.js.code, '{', 'function increment'))).toMatchObject(find(source, '{', 'function increment'));
  });

  const templateTokens: [string, string][] = [
    ['props.title', ''],
    ['count', '$text('],
    ['[1, 2]', ''],
    ['increment', '$on('],
    ['n * count.value', ''],
  ];
  test.each(templateTokens)('template: "%s" maps to its expression', (token, after) => {
    const inTemplate = source.indexOf('<main>');
    const expected = find(source.slice(inTemplate), token);
    expect(original(js, find(result.js.code, token, after))).toMatchObject({ line: expected.line + source.slice(0, inTemplate).split('\n').length - 1, column: expected.column });
  });

  test('styles map to their rules', () => {
    expect(original(css, find(result.css!.code, 'color: red'))).toMatchObject(find(source, 'color: red'));
    expect(original(css, find(result.css!.code, 'button'))).toMatchObject(find(source, 'button:hover'));
    expect(original(css, find(result.css!.code, 'color: blue'))).toMatchObject(find(source, 'color: blue'));
  });
});
