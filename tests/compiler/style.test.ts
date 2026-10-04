import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler';
import { checkCss, checkScript } from '../../src/compiler/compat';

const FILE = 'web/components/Card.nexus';

function css(styles: string, tag = '<style>'): string {
  const result = compile(`<p>x</p>\n${tag}\n${styles}\n</style>`, { filename: FILE, css: 'external' });
  const attribute = /data-n-\w+/.exec(result.js.code)?.[0] ?? 'data-n-none';
  return (result.css?.code ?? '').split(attribute).join('data-n-X').split(attribute.slice('data-n-'.length)).join('X');
}

describe('scoped styles', () => {
  const cases: [string, string, string][] = [
    ['a class', '.card { color: red; }', '.card[data-n-X] { color: red; }'],
    ['every compound of a selector', '.card > .title + p ~ span em { }', '.card[data-n-X] > .title[data-n-X] + p[data-n-X] ~ span[data-n-X] em[data-n-X] { }'],
    ['a selector list', 'h1, h2,\nh3 { }', 'h1[data-n-X], h2[data-n-X],\nh3[data-n-X] { }'],
    ['before pseudo-classes and pseudo-elements', 'a:hover, p::before, li:not(.on):first-child, ::selection { }', 'a[data-n-X]:hover, p[data-n-X]::before, li[data-n-X]:not(.on):first-child, [data-n-X]::selection { }'],
    ['attribute selectors and escapes', 'input[type="a b"], .md\\:flex, #id { }', 'input[type="a b"][data-n-X], .md\\:flex[data-n-X], #id[data-n-X] { }'],
    ['the universal selector', '* { } .a * { }', '*[data-n-X] { } .a[data-n-X] *[data-n-X] { }'],
    [':global on its own', ':global(body) { } :global(.theme-dark .panel) { }', 'body { } .theme-dark .panel { }'],
    [':global next to scoped parts', ':global(.dark) .card { } .card :global(.icon) { } .card:global(.open) { }', '.dark .card[data-n-X] { } .card[data-n-X] .icon { } .card[data-n-X].open { }'],
    [':root is left alone', ':root { --gap: 4px; }', ':root { --gap: 4px; }'],
    ['inside @media and @supports', '@media (max-width: 600px) { .card { } }\n@supports (display: grid) { .card { } }', '@media (max-width: 600px) { .card[data-n-X] { } }\n@supports (display: grid) { .card[data-n-X] { } }'],
    ['@font-face is not a selector', '@font-face { font-family: "A"; src: url(a.woff2); }', '@font-face { font-family: "A"; src: url(a.woff2); }'],
    ['comments and strings are not selectors', '/* .a { } */ .b::after { content: "} .c {"; }', '/* .a { } */ .b[data-n-X]::after { content: "} .c {"; }'],
  ];

  test.each(cases)('%s', (_, input, output) => {
    expect(css(input)).toBe(output);
  });

  test('keyframes are renamed, and so are the animations that use them', () => {
    const output = css(
      '@keyframes fade { from { opacity: 0; } 50% { opacity: 0.5; } to { opacity: 1; } }\n' +
        '.a { animation: fade 0.2s ease-in, other 1s; }\n' +
        '.b { animation-name: fade; animation-duration: 1s; }\n' +
        '.c { animation: 1s fade-out; }',
    );
    expect(output).toBe(
      '@keyframes fade-X { from { opacity: 0; } 50% { opacity: 0.5; } to { opacity: 1; } }\n' +
        '.a[data-n-X] { animation: fade-X 0.2s ease-in, other 1s; }\n' +
        '.b[data-n-X] { animation-name: fade-X; animation-duration: 1s; }\n' +
        '.c[data-n-X] { animation: 1s fade-out; }',
    );
  });

  test('a global block is left exactly as written', () => {
    expect(css('.card > p:hover { }\n@keyframes fade { to { opacity: 0; } }\n.a { animation: fade 1s; }', '<style global>')).toBe(
      '.card > p:hover { }\n@keyframes fade { to { opacity: 0; } }\n.a { animation: fade 1s; }',
    );
  });

  test('the elements of the component carry the attribute, and only when there are scoped styles', () => {
    const scoped = compile('<div><p>x</p><Child /></div>\n<style>p { }</style>', { filename: FILE }).js.code;
    const attribute = /data-n-\w+/.exec(scoped)![0];
    expect(scoped).toContain(`$template('<div ${attribute}><p ${attribute}>x</p><!></div>')`);
    expect(compile('<div><p>x</p></div>', { filename: FILE }).js.code).toContain(`$template('<div><p>x</p></div>')`);
    expect(compile('<div><p>x</p></div>\n<style global>p { }</style>', { filename: FILE }).js.code).toContain(`$template('<div><p>x</p></div>')`);
  });

  test('the attribute depends on the path of the file, and only on that', () => {
    const attribute = (filename: string, source = '<p>x</p><style>p { }</style>'): string => /data-n-\w+/.exec(compile(source, { filename }).js.code)![0];
    expect(attribute('web/a/Card.nexus')).toBe(attribute('web\\a\\Card.nexus'));
    expect(attribute('web/a/Card.nexus')).toBe(attribute('web/a/Card.nexus', '<b>other</b><style>b { color: red; }</style>'));
    expect(attribute('web/a/Card.nexus')).not.toBe(attribute('web/b/Card.nexus'));
  });

  test('several style blocks are joined, and the indentation of the block is removed', () => {
    const result = compile('<p>x</p>\n<style>\n  p {\n    color: red;\n  }\n</style>\n<style global>\n  body { margin: 0; }\n</style>', { filename: FILE });
    const attribute = /data-n-\w+/.exec(result.js.code)![0];
    expect(result.css!.code).toBe(`p[${attribute}] {\n  color: red;\n}\nbody { margin: 0; }`);
  });
});

describe('what Chromium 103 cannot run', () => {
  const unsupported: [string, string][] = [
    ['.a:has(.b) { }', ':has()'],
    ['.a { .b { color: red; } }', 'CSS nesting'],
    ['.a { &:hover { color: red; } }', 'CSS nesting'],
    ['@container (min-width: 1px) { .a { } }', '@container'],
    ['.a { container-type: inline-size; }', 'container-type'],
    ['.a { color: color-mix(in srgb, red 50%, blue); }', 'color-mix()'],
    ['.a { color: oklch(70% 0.1 200); }', 'colour function'],
    ['.a { color: rgb(from red r g b / 50%); }', 'Relative colour'],
    ['.a { height: 100dvh; }', 'dvh'],
    ['.a { width: 50cqw; }', 'Container query units'],
    ['.a { translate: 10px 0; }', 'translate'],
    ['.a { rotate: 45deg; }', 'rotate'],
    ['.a { scale: 1.2; }', 'scale'],
    ['@keyframes pop { to { scale: 2; } }', 'scale'],
    ['@media (width >= 600px) { .a { } }', 'Range syntax'],
    ['@scope (.a) { .b { } }', '@scope'],
    ['.a { text-wrap: balance; }', 'text-wrap'],
    ['.a { grid-template-columns: subgrid; }', 'subgrid'],
    ['.a { transition-timing-function: linear(0, 0.5, 1); }', 'linear()'],
    ['.a { width: calc(100px * sin(45deg)); }', 'math function'],
    ['.a { scrollbar-width: thin; }', 'scrollbar-width'],
    ['.a { mask-image: url(a.svg); }', '-webkit-mask-image'],
    ['.a { background-clip: text; }', '-webkit-background-clip'],
  ];

  test.each(unsupported)('%s', (source, mention) => {
    const issues = checkCss(source);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain(mention);
    expect(issues[0]!.hint.length).toBeGreaterThan(10);
    expect(source.slice(issues[0]!.start, issues[0]!.end).length).toBeGreaterThan(0);
  });

  const supported = [
    '.a { transform: translate(10px) rotate(5deg) scale(1.1); inset: 0; gap: 4px; aspect-ratio: 16 / 9; }',
    '.a { -webkit-mask-image: url(a.svg); mask-image: url(a.svg); }',
    '.a { -webkit-background-clip: text; background-clip: text; }',
    '.a { background-clip: padding-box; color: rgb(0 0 0 / 50%); width: clamp(1px, 2vw, 3px); }',
    '.a:is(.b, .c):where(.d):not(.e):focus-visible { }',
    '@media (min-width: 600px) and (max-width: 900px) { .a { } }',
    '@layer base { .a { } } @property --x { syntax: "<length>"; inherits: false; initial-value: 0px; }',
    '.a::after { content: ":has( color-mix( 100dvh"; } /* translate: 1px; :has(x) */',
    '.a { transition: transform 1s linear; animation: spin 1s linear infinite; transform: scale(2); }',
    '@supports selector(:has(a)) { .a:has(b) { color: red; } }',
    '.a { backdrop-filter: blur(4px); mask-type: alpha; overflow: clip; accent-color: red; }',
  ];

  test.each(supported)('accepts %s', (source) => {
    expect(checkCss(source)).toEqual([]);
  });

  test('javascript: missing functions are found, code in strings and comments is not', () => {
    const source = [
      'const sorted = list.toSorted();',
      'const text = "list.toSorted()"; // list.toReversed()',
      'const groups = Object.groupBy(list, (item) => item.kind);',
      'const { promise } = Promise.withResolvers();',
      'const copy = structuredClone(list).at(-1) ?? list.findLast(Boolean);',
    ].join('\n');
    const issues = checkScript(source);
    expect(issues.map((issue) => source.slice(issue.start, issue.end))).toEqual(['.toSorted(', 'Object.groupBy(', 'Promise.withResolvers(']);
    expect(issues[0]!.message).toBe('This array method needs Chromium 110. FiveM runs Chromium 103.');
    expect(issues[0]!.hint).toContain('[...list].sort()');
  });

  test('javascript in a component is checked where it is written', () => {
    const { warnings } = compile('---\nconst last = props.items.toReversed()[0];\n---\n<p>{props.items.toSorted().length}</p>', { filename: FILE });
    expect(warnings.map((warning) => [warning.code, warning.severity, warning.line, warning.column])).toEqual([
      ['unsupported-api', 'error', 2, 25],
      ['unsupported-api', 'error', 4, 16],
    ]);
  });
});
