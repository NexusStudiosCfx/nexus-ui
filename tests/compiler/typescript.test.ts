import { describe, expect, test } from 'vitest';
import { parseSync } from 'vite';
import { compile, CompileError } from '../../src/compiler';

/** The compiled script of a component: what is left of it inside the component function. */
function script(code: string): string {
  const output = compile(`---\n${code}\n---\n`, { filename: 'A.nexus' }).js.code;
  expect(parseSync('out.js', output).errors).toEqual([]);
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.startsWith('export default function'));
  const end = lines.findIndex((line, index) => index > start && line === '');
  return lines.slice(start + 1, end).map((line) => line.replace(/^ {2}/, '')).join('\n');
}

function imports(code: string, template = ''): string[] {
  const output = compile(`---\n${code}\n---\n${template}`, { filename: 'A.nexus' }).js.code;
  return output.split('\n').filter((line) => line.startsWith('import') && !line.includes('$template'));
}

describe('types are removed and nothing else changes', () => {
  const cases: [string, string, string][] = [
    ['annotations', 'let a: number = 1, b: string[];', 'let a = 1, b;'],
    ['generics on calls and functions', 'const s = signal<number>(1); function f<T, U extends T>(a: T): U { return a; }', 'const s = signal(1); function f(a) { return a; }'],
    ['as, satisfies and non-null', 'const a = (b as unknown as Foo)!.c satisfies Bar;', 'const a = (b).c;'],
    ['angle-bracket assertions', 'const a = <Foo>b;', 'const a = b;'],
    ['optional and this parameters', 'function f(this: Window, a?: number, { b }?: Options, ...rest: number[]) {}', 'function f(a, { b }, ...rest) {}'],
    ['arrow functions', 'const f = async <T,>(a: T, b = 1 as number): Promise<T> => a;', 'const f = async (a, b = 1) => a;'],
    ['a return type that spans lines', 'const f = (a: number): {\n  x: number;\n} => ({ x: a });', 'const f = (a) => ({ x: a });'],
    ['definite assignment', 'let a!: string;', 'let a;'],
    ['catch clause', 'try {} catch (e: unknown) {}', 'try {} catch (e) {}'],
    ['overloads', 'function f(a: string): void;\nfunction f(a: any) {}', 'function f(a) {}'],
    ['interfaces and type aliases', 'interface A { b: number }\ntype C = A | null;\nconst d = 1;', 'const d = 1;'],
    ['declare', 'declare const VERSION: string;\ndeclare function g(): void;\nconst d = 1;', 'const d = 1;'],
    [
      'exported types',
      "export type Row = { id: number };\nexport interface Props { rows: Row[] }\nexport type { Item } from './types';\nexport type * from './more';\nexport { type Row as Line, type Props as Given };\nconst d = 1;",
      'const d = 1;',
    ],
    [
      'class members',
      'class A<T> extends B<T> implements C, D {\n  private readonly a: T[] = [];\n  declare b: boolean;\n  protected static override c?: number;\n  d!: string;\n  e?(x: T): void;\n  public f(): void {}\n  [key: string]: unknown;\n}',
      'class A extends B {\n  a = [];\n  static c;\n  d;\n  f() {}\n}',
    ],
    ['abstract classes', 'abstract class A {\n  abstract b(): void;\n  protected abstract c: number;\n  d = 1;\n}', 'class A {\n  d = 1;\n}'],
    ['a removed statement does not join its neighbours', 'const a = b\ntype T = number\n;[1].forEach(f)', 'const a = b\n;[1].forEach(f)'],
    ['a removed statement before a line that starts with a bracket', 'const a = b\ninterface T {}\n(c)', 'const a = b\n;\n(c)'],
    ['comments stay', '// why\nconst a: number = 1; /* inline */', '// why\nconst a = 1; /* inline */'],
  ];

  test.each(cases)('%s', (_, input, output) => {
    expect(script(input)).toBe(output);
  });

  test('the lines of a template literal are not indented with the rest of the script', () => {
    const output = compile('---\nconst text = `a\n  b: ${c as string}\nd`;\n---\n', { filename: 'A.nexus' }).js.code;
    expect(output).toContain('  const text = `a\n  b: ${c}\nd`;\n');
  });

  test('in template expressions too', () => {
    const output = compile('<p title={(item as Item).name!}>{count satisfies number}</p>\n{#each (rows as Row[]) as row (row.id as number)}<b>{row!.label}</b>{/each}', { filename: 'A.nexus' }).js.code;
    expect(parseSync('out.js', output).errors).toEqual([]);
    expect(output).toContain("$attr(p, 'title', () => $get((item).name));");
    expect(output).toContain('$text(text, () => $get(count));');
    expect(output).toContain('$each(anchor, () => $get((rows)), (row) => row.id, ($$row) => {');
  });
});

describe('imports', () => {
  test('are hoisted out of the component function, in order', () => {
    expect(imports("import { a } from 'a';\nconst x = a;\nimport b from 'b';\nimport * as c from 'c';\nimport 'd';\nb(c);")).toEqual([
      "import { a } from 'a';",
      "import b from 'b';",
      "import * as c from 'c';",
      "import 'd';",
    ]);
  });

  test('type imports are removed', () => {
    expect(imports("import type { A } from 'a';\nimport { type B, c } from 'b';\nimport D, { type E } from 'd';\nc(D);")).toEqual(["import { c } from 'b';", "import D from 'd';"]);
  });

  test('an import that is only used as a type is removed, as TypeScript does', () => {
    expect(imports("import { Signal, signal } from 'nexus';\nimport { Item } from './types';\nconst a: Signal<Item> = signal(null);")).toEqual(["import { signal } from 'nexus';"]);
  });

  test('an import used only by the template is kept', () => {
    const template = '<Price value={format(1)} />\n<p use:tooltip>x</p>\n<ui.Badge />';
    expect(imports("import Price from './Price.nexus';\nimport { format, unused } from './format';\nimport { tooltip } from './actions';\nimport * as ui from './ui';", template)).toEqual([
      "import Price from './Price.nexus';",
      "import { format } from './format';",
      "import { tooltip } from './actions';",
      "import * as ui from './ui';",
    ]);
  });
});

describe('typescript that is not only types', () => {
  const cases: [string, string, string][] = [
    ['enum', "enum Tab { Home = 'home' }", 'as const'],
    ['namespace', 'namespace A { export const b = 1; }', 'plain object'],
    ['parameter properties', 'class A { constructor(private b: number) {} }', 'Declare the field'],
    ['import equals', "import a = require('a');", "import x from 'module'"],
  ];

  test.each(cases)('%s is rejected with what to write instead', (_, input, hint) => {
    let error: unknown;
    try {
      compile(`---\n${input}\n---\n`, { filename: 'A.nexus' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).diagnostic).toMatchObject({ code: 'unsupported-typescript', line: 2 });
    expect((error as CompileError).diagnostic.hint).toContain(hint);
  });

  test('their declare forms are only types and are removed', () => {
    expect(script("declare enum Tab { Home }\ndeclare namespace A { const b: number; }\nconst c = 1;")).toBe('const c = 1;');
  });
});
