import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler';

function js(source: string, options: { dev?: boolean; css?: 'inject' | 'external'; filename?: string } = {}): string {
  return compile(source, { filename: 'web/components/Counter.nexus', ...options }).js.code;
}

/** The lines of the component function that come from the template. */
function body(source: string): string[] {
  const lines = js(source).split('\n');
  const start = lines.findIndex((line) => line.startsWith('export default function'));
  return lines.slice(start + 1, lines.lastIndexOf('}')).map((line) => line.trim()).filter(Boolean);
}

describe('output', () => {
  test('a small component compiles to code a person can read', () => {
    const source = [
      '---',
      "import { signal } from 'nexus';",
      '',
      'const count = signal(0);',
      '---',
      '',
      '<button class="counter" on:click={() => count.value++}>',
      '  Clicked {count} times',
      '</button>',
      '',
    ].join('\n');

    expect(js(source)).toBe(
      [
        "import { $get, $on, $template, $text } from 'nexus';",
        "import { signal } from 'nexus';",
        '',
        `const $t1 = $template('<button class="counter"> </button>');`,
        '',
        'export default function Counter(props) {',
        '  const count = signal(0);',
        '',
        '  const button = $t1();',
        '  const text = button.firstChild;',
        "  $on(button, 'click', () => count.value++);",
        "  $text(text, () => `Clicked ${$get(count) ?? ''} times`);",
        '  return button;',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('static markup is one cloned template, however large', () => {
    const code = js('<section class="a"><h1>Title</h1><p>One <b>two</b> three</p><img src="x.png" alt=""></section>');
    expect(code).toContain(`$template('<section class="a"><h1>Title</h1><p>One <b>two</b> three</p><img src="x.png" alt=""></section>')`);
    expect(body('<section class="a"><h1>Title</h1><p>One <b>two</b> three</p></section>')).toEqual(['const section = $t1();', 'return section;']);
  });

  test('every dynamic part gets its own binding on exactly its node', () => {
    expect(body('<div title={a}><p>{b}</p><p class:on={c}>static</p><span>{d} and {e}</span></div>')).toEqual([
      'const div = $t1();',
      'const p = div.firstChild;',
      'const text = p.firstChild;',
      'const p_2 = p.nextSibling;',
      'const span = p_2.nextSibling;',
      'const text_2 = span.firstChild;',
      "$attr(div, 'title', () => $get(a));",
      '$text(text, () => $get(b));',
      "$toggle(p_2, 'on', () => $get(c));",
      "$text(text_2, () => `${$get(d) ?? ''} and ${$get(e) ?? ''}`);",
      'return div;',
    ]);
  });

  test('a value that cannot be a signal is read without unwrapping', () => {
    const lines = body('<p title={`${a}`} data-n={count.value + 1}>{name.value}</p>');
    expect(lines).toContain("$attr(p, 'title', () => `${a}`);");
    expect(lines).toContain("$attr(p, 'data-n', () => count.value + 1);");
    expect(lines).toContain('$text(text, () => name.value);');
  });

  test('literal expressions go into the markup instead of becoming bindings', () => {
    const code = js('<input disabled={true} hidden={false} tabindex={0} placeholder={"Name"}>');
    expect(code).toContain(`$template('<input disabled tabindex="0" placeholder="Name">')`);
    expect(code).not.toContain('$attr');
  });

  test('handlers: a known function is passed as it is, anything else is looked up when the event fires', () => {
    const lines = body('<button on:click={save} on:focus={props.onFocus} on:blur|once|capture={() => leave()}>x</button>');
    expect(lines).toContain("$on(button, 'click', save);");
    expect(lines).toContain("$on(button, 'focus', ($event) => (props.onFocus)?.($event));");
    expect(lines).toContain("$on(button, 'blur', () => leave(), 24);");
  });

  test('inside each, bindings read the current item', () => {
    const lines = body('<ul>{#each rows as row, i (row.id)}<li on:click={() => pick(row)}>{i}: {row.name}</li>{/each}</ul>');
    expect(lines).toContain('$each(anchor, () => $get(rows), (row, i) => row.id, ($$row, $$i) => {');
    expect(lines).toContain("$on(li, 'click', ($event, row = $$row.value) => (() => pick(row))($event));");
    expect(lines).toContain("$text(text, (row = $$row.value, i = $$i.value) => `${$get(i) ?? ''}: ${$get(row.name) ?? ''}`);");
  });

  test('each can be keyed by its index', () => {
    const lines = body('<ul>{#each rows as row, index (index)}<li>{row}</li>{/each}</ul>');
    expect(lines).toContain('$each(anchor, () => $get(rows), (row, index) => index, ($$row, $$index) => {');
  });

  test('an inner each can reuse a name of an outer one, which it then hides', () => {
    const lines = body(
      '<ul>{#each groups as group, index (index)}{#each group.rows as row, index (index)}<li on:click={() => pick(row, index)}>{index}: {row} of {group.name}</li>{/each}<b>{index}</b>{/each}</ul>',
    );
    expect(lines).toContain('$each(anchor_2, (group = $$group.value) => $get(group.rows), (row, index) => index, ($$row, $$index_2) => {');
    expect(lines).toContain("$on(li, 'click', ($event, row = $$row.value, index = $$index_2.value) => (() => pick(row, index))($event));");
    expect(lines).toContain("$text(text, (group = $$group.value, row = $$row.value, index = $$index_2.value) => `${$get(index) ?? ''}: ${$get(row) ?? ''} of ${$get(group.name) ?? ''}`);");
    // Outside the inner block the name is the outer index again.
    expect(lines).toContain('$text(text_2, (index = $$index.value) => $get(index));');
  });

  test('a key that reads an outer item gets it from the outer block', () => {
    const lines = body('{#each groups as group}{#each group.rows as row (group.id + row.id)}<i>{row.id}</i>{/each}{/each}');
    expect(lines.join('\n')).toContain('(row) => { const group = $$group.value; return group.id + row.id; }');
  });

  test('if compiles to one test that picks a branch', () => {
    const lines = body('{#if a}<p>A</p>{:else if b > 1}<p>B</p>{:else}<p>C</p>{/if}');
    expect(lines).toContain('$if(anchor, () => $get(a) ? 0 : (b > 1) ? 1 : 2, [');
  });

  test('component props are getters, so the child reads them when it needs them', () => {
    const lines = body('<Price value={total} currency="USD" bold {label} />');
    expect(lines).toEqual(['return Price({', 'get value() { return $get(total); },', "currency: 'USD',", 'bold: true,', 'get label() { return $get(label); },', '});']);
  });

  test('a spread on a component keeps the order of what overrides what', () => {
    expect(body('<Price a="1" {...rest} b={two} />').join(' ')).toBe("return Price($props({ a: '1', }, () => $get(rest), { get b() { return $get(two); }, }));");
  });

  test('slot content is passed as functions', () => {
    const lines = body('<Card><b>body</b><i slot="footer">foot</i></Card>');
    expect(lines).toContain('$slots: {');
    expect(lines).toContain('default: () => {');
    expect(lines).toContain('footer: () => {');
    expect(js('<Card><b>body</b><i slot="footer">foot</i></Card>')).toContain(`$template('<i>foot</i>')`);
  });

  test('a fragment that starts with a block gets a marker in front of it', () => {
    expect(js('{#if a}<p>x</p>{/if}<p>after</p>')).toContain(`$template('<!><!><p>after</p>', 1)`);
    expect(js('<p>before</p>{#if a}<p>x</p>{/if}')).toContain(`$template('<p>before</p><!>', 1)`);
  });

  test('whitespace: collapsed, trimmed at the edges, dropped between tags on separate lines', () => {
    const code = js('<div>\n  <b>one</b>\n  <i>two</i> <u>three</u>\n  text   with\n  breaks\n</div>');
    expect(code).toContain(`$template('<div><b>one</b><i>two</i> <u>three</u> text with breaks</div>')`);
    expect(js('<pre>\n  kept\n    as is\n</pre>')).toContain(String.raw`$template('<pre>\n\n  kept\n    as is\n</pre>')`);
  });

  test('text is escaped in markup and in template literals', () => {
    expect(js('<p title="a &quot;b&quot;">1 &lt; 2 &amp; 3</p>')).toContain(`$template('<p title="a &quot;b&quot;">1 &lt; 2 &amp; 3</p>')`);
    expect(js('<p>`$&#123;x&#125;` costs \\ {price}</p>')).toContain('$text(text, () => `\\`\\${x}\\` costs \\\\ ${$get(price) ?? \'\'}`);');
  });

  test('an expression that ends in a line comment does not swallow the code after it', () => {
    expect(body('<p>{count // the total\n}</p>')).toEqual(['const p = $t1();', 'const text = p.firstChild;', '$text(text, () => $get(count // the total', '));', 'return p;']);
  });

  test('an empty file is a component that renders nothing', () => {
    expect(js('')).toContain("const $t1 = $template('', 1);");
    expect(body('')).toEqual(['return $t1();']);
  });

  test('generated names never collide with names the author uses', () => {
    const code = js('---\nconst div = 1, text = 2, Counter = 3;\n---\n<div>{text}{div}{Counter}</div>');
    expect(code).toContain('const div_2 = $t1();');
    expect(code).toContain('const text_2 = div_2.firstChild;');
    expect(code).toContain('export default function Counter_2(props)');
  });

  test('the component is named after its file', () => {
    expect(js('<p>x</p>', { filename: 'C:\\project\\web\\screens\\vehicle-shop.nexus' })).toContain('export default function VehicleShop(props)');
    expect(js('<p>x</p>', { filename: 'web/screens/2fa.nexus' })).toContain('export default function Component(props)');
  });
});

describe('markup the browser would rearrange', () => {
  // Elements in one piece of markup are parsed together, so their nesting has to be what the
  // browser accepts. A block, a component and a slot start a new piece that is parsed on its own
  // and then inserted, which no parser gets to rearrange.
  const accepted = [
    '<p><Price value={1} /></p>',
    '<p>Total: <Price value={1} /> each</p>',
    '<p><Tooltip><div>block content</div></Tooltip></p>',
    '<p>{#if open}<div>x</div>{/if}</p>',
    '<p>{#each rows as row}<div>{row}</div>{/each}</p>',
    '<p>{#key id}<section>x</section>{/key}</p>',
    '<p><slot><div>fallback</div></slot></p>',
    '<table>{#each rows as row}<tr><td>{row}</td></tr>{/each}</table>',
    '<tbody><Row /></tbody>',
    '<button>{#if nested}<button>x</button>{/if}</button>',
  ];

  test.each(accepted)('accepts %s', (source) => {
    expect(() => compile(source, { filename: 'A.nexus' })).not.toThrow();
  });

  test('a component in a paragraph is inserted where its anchor is', () => {
    expect(js('<p>Total: <Price value={1} /> each</p>')).toContain(`$template('<p>Total: <!> each</p>')`);
  });
});

describe('what leaves a build', () => {
  const source = [
    '---',
    "import { dev, signal } from 'nexus';",
    "import { fill } from './fixtures';",
    '',
    'const count = signal(0);',
    "dev.action('Fill the form', () => fill(count));",
    "if (count.value) dev.action('Nested', () => {});",
    '---',
    '',
    '<p>{count}</p>',
  ].join('\n');

  test('calls to dev are removed with their arguments, and so are the imports only they used', () => {
    const code = js(source);
    expect(code).not.toContain('dev');
    expect(code).not.toContain('Fill the form');
    expect(code).not.toContain('fixtures');
    expect(code).toContain("import { signal } from 'nexus';");
    expect(code).toContain('  const count = signal(0);\n  if (count.value) undefined;\n\n  const p = $t1();');
  });

  test('they stay while developing', () => {
    const code = js(source, { dev: true });
    expect(code).toContain("import { dev, signal } from 'nexus';");
    expect(code).toContain("  dev.action('Fill the form', () => fill(count));");
  });

  test('under another name and through a namespace import', () => {
    expect(js("---\nimport { dev as tools } from 'nexus';\ntools.action('A', () => {});\n---\n<p>x</p>")).not.toContain('tools');
    const code = js("---\nimport * as nexus from 'nexus';\nnexus.dev.action('A', () => {});\nconst n = nexus.signal(1);\n---\n<p>{n}</p>");
    expect(code).not.toContain('action');
    expect(code).toContain('const n = nexus.signal(1);');
  });

  test('something else called dev is left alone', () => {
    expect(js("---\nimport { dev } from './tools';\ndev.action('A');\n---\n<p>x</p>")).toContain("dev.action('A');");
  });
});

describe('options and result', () => {
  test('screen: the declaration is returned and exported for the runtime', () => {
    const result = compile('<screen focus="mouse" keep-input size="1920x1080" cursor="none" />\n<p>x</p>', { filename: 'Shop.nexus' });
    const declaration = { focus: { mouse: true, keyboard: false }, keepInput: true, close: 'none', size: { width: 1920, height: 1080 }, layer: 'screen', cursor: 'none', surface: null };
    expect(result.screen).toEqual(declaration);
    expect(result.js.code).toContain(`const $screen = ${JSON.stringify(declaration)};\nexport { $screen as screen };`);
  });

  test('screen: defaults', () => {
    expect(compile('<screen />', { filename: 'Shop.nexus' }).screen).toEqual({
      focus: { mouse: true, keyboard: true },
      keepInput: false,
      close: 'escape',
      size: null,
      layer: 'screen',
      cursor: null,
      surface: null,
    });
    expect(compile('<screen layer="hud" />', { filename: 'Hud.nexus' }).screen).toMatchObject({ focus: { mouse: false, keyboard: false }, close: 'none', layer: 'hud' });
    expect(compile('<screen focus="none" />', { filename: 'Shop.nexus' }).screen).toMatchObject({ focus: { mouse: false, keyboard: false }, close: 'none' });
    expect(compile('<p>x</p>', { filename: 'Shop.nexus' }).screen).toBeNull();
  });

  test('screen: a surface makes it an app, whose frame decides everything else', () => {
    const result = compile('<screen surface="phone" cursor="default" />\n<p>x</p>', { filename: 'GarageApp.nexus' });
    const declaration = { focus: { mouse: false, keyboard: false }, keepInput: false, close: 'none', size: null, layer: 'screen', cursor: 'default', surface: 'phone' };
    expect(result.screen).toEqual(declaration);
    expect(result.js.code).toContain(`const $screen = ${JSON.stringify(declaration)};`);
    expect(compile('<screen surface="tablet" />', { filename: 'A.nexus' }).screen).toMatchObject({ surface: 'tablet', close: 'none' });
  });

  test('screen: a world screen is drawn by a browser of its size, and takes no focus', () => {
    const result = compile('<screen surface="world" size="1280x720" />\n<p>x</p>', { filename: 'Clock.nexus' });
    const declaration = { focus: { mouse: false, keyboard: false }, keepInput: false, close: 'none', size: { width: 1280, height: 720 }, layer: 'screen', cursor: null, surface: 'world' };
    expect(result.screen).toEqual(declaration);
    expect(result.js.code).toContain(`const $screen = ${JSON.stringify(declaration)};`);
  });

  test('css: inject puts the styles in the module, external only returns them', () => {
    const source = '<p>x</p>\n<style>p { color: red; }</style>';
    const injected = compile(source, { filename: 'A.nexus' });
    const external = compile(source, { filename: 'A.nexus', css: 'external' });
    expect(injected.css?.code).toBe(external.css?.code);
    expect(injected.js.code).toMatch(/\$css\('data-n-\w+', 'p\[data-n-\w+\] \{ color: red; \}'\);/);
    expect(external.js.code).not.toContain('$css');
    expect(compile('<p>x</p>', { filename: 'A.nexus' }).css).toBeNull();
  });

  test('dev: runtime errors can name the place in the file', () => {
    const source = '<ul>\n  {#each rows as row (row.id)}<li>{row}</li>{/each}\n</ul>\n<input bind:value={name}>';
    expect(js(source, { dev: true })).toContain("}, null, 'web/components/Counter.nexus:2:3');");
    expect(js(source, { dev: true })).toContain("$bind(input, 0, () => name, undefined, 'web/components/Counter.nexus:4:8');");
    expect(js(source)).not.toContain('Counter.nexus');
  });

  test('the output parses as JavaScript', async () => {
    const { parseSync } = await import('vite');
    const source = '---\nconst a: number = 1;\n---\n<p class:on={a > 0}>{a as number}</p>\n{#each [1, 2] as n}<b>{n}</b>{/each}';
    expect(parseSync('out.js', js(source)).errors).toEqual([]);
  });
});
