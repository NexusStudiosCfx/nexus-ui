import { describe, expect, test } from 'vitest';
import { compile, CompileError, type Diagnostic } from '../../src/compiler';

function failure(source: string): Diagnostic {
  try {
    compile(source, { filename: 'web/screens/Shop.nexus' });
  } catch (error) {
    if (error instanceof CompileError) return error.diagnostic;
    throw error;
  }
  throw new Error('Expected the file not to compile.');
}

function warnings(source: string): Diagnostic[] {
  return compile(source, { filename: 'web/screens/Shop.nexus' }).warnings;
}

/** `[what, source, code, line, column, part of the hint]` */
type Case = [string, string, string, number, number, string];

const errors: Case[] = [
  ['an unclosed tag, reported where it was opened', '<section>\n  <div>\n    <p>text</p>\n</section>', 'unclosed-tag', 2, 3, 'Add `</div>`'],
  ['a tag still open at the end of the file', '<section>\n  <p>text</p>\n', 'unclosed-tag', 1, 1, 'Add `</section>`'],
  ['a closing tag without an opening', '<p>a</p>\n</div>', 'unexpected-close', 2, 1, 'Remove `</div>`'],
  ['a tag that never ends', '<p>ok</p>\n<div class="a"', 'unclosed-tag', 2, 1, 'Add `>`'],
  ['a closing tag for a void element', '<p>a<br></br></p>', 'void-element-closed', 1, 9, 'Remove `</br>`'],
  ['an unclosed block', '<ul>\n  {#if open}\n    <li>a</li>\n</ul>', 'unclosed-block', 2, 3, 'Add `{/if}`'],
  ['a block closed by the wrong name', '{#each list as item}\n  {item}\n{/if}', 'unclosed-block', 1, 1, 'Add `{/each}`'],
  ['a block closing inside an open element', '{#if a}\n  <div>\n{/if}', 'unclosed-tag', 2, 3, 'Add `</div>`'],
  ['an unknown block', '{#iff open}x{/iff}', 'unknown-block', 1, 1, 'Did you mean `{#if}`?'],
  ['an unknown tag', '{@const a = 1}', 'unknown-tag', 1, 1, '{@html expression}'],
  ['else outside a block', '<p>{:else}</p>', 'misplaced-else', 1, 4, 'Close `<p>` before'],
  ['else after else', '{#if a}1{:else}2{:else if b}3{/if}', 'else-after-else', 1, 17, '{:else if condition}'],
  ['each without a name for the item', '{#each list}x{/each}', 'malformed-each', 1, 1, '{#each list as item}'],
  ['each with a key that ignores the item', '{#each list as item (other.id)}x{/each}', 'key-without-item', 1, 22, '(item.id)'],
  ['each that binds a name twice', '{#each rows as row, row}x{/each}', 'duplicate-binding', 1, 21, 'different name'],
  ['each that rebinds one name of an outer pattern', '{#each a as { id, cells }}{#each cells as id}x{/each}{/each}', 'duplicate-binding', 1, 43, 'different name'],
  ['each with a key from an outer block only', '{#each a as row, index}{#each row.cells as cell (index)}x{/each}{/each}', 'key-without-item', 1, 50, '(cell.id)'],
  ['an unclosed expression', '<p>{count</p>', 'unclosed-expression', 1, 4, 'Add the closing `}`'],
  ['an empty expression', '<p>{ }</p>', 'empty-expression', 1, 5, '{count}'],
  ['a syntax error in an expression', '<p>\n  {count +}\n</p>', 'expression-syntax', 2, 11, ''],
  ['a statement where an expression is expected', '<p>{let a = 1}</p>', 'expression-syntax', 1, 9, ''],
  ['await in an expression', '<p>{await load()}</p>', 'template-await', 1, 5, 'store the result in a signal'],
  ['an unclosed string in an expression', `<p>{'oops}</p>`, 'unclosed-string', 1, 5, 'quotes'],
  ['an unknown directive', '<button onn:click={save}>x</button>', 'unknown-directive', 1, 9, 'Did you mean `on:click`?'],
  ['an unknown event modifier', '<button on:click|prevnt={save}>x</button>', 'unknown-modifier', 1, 18, 'Did you mean `prevent`?'],
  ['an unknown binding', '<input bind:valeu={name}>', 'unknown-binding', 1, 13, 'Did you mean `bind:value`?'],
  ['bind:value on something that has no value', '<div bind:value={name}></div>', 'invalid-binding', 1, 6, 'value={...}'],
  ['bind:checked on a text input', '<input type="text" bind:checked={on}>', 'invalid-binding', 1, 20, 'type'],
  ['bind:group without a fixed type', '<input bind:group={picked}>', 'invalid-binding', 1, 8, 'type'],
  ['bind to something that cannot be written', '<input bind:value={name + 1}>', 'invalid-binding', 1, 20, 'signal'],
  ['a handler given as text', '<button on:click="save()">x</button>', 'directive-value', 1, 9, 'on:click={...}'],
  ['a handler that is missing', '<button on:click>x</button>', 'directive-missing-value', 1, 9, 'on:click={...}'],
  ['a directive on a component', '<Price on:click={save} />', 'directive-on-component', 1, 8, 'onClick={handler}'],
  ['syntax from another framework: @click', '<button @click="save">x</button>', 'foreign-syntax', 1, 9, 'on:click={handler}'],
  ['syntax from another framework: onClick', '<button onClick={save}>x</button>', 'foreign-syntax', 1, 9, 'on:click={handler}'],
  ['syntax from another framework: className', '<p className="a">x</p>', 'foreign-syntax', 1, 4, '`class`'],
  ['an attribute given twice', '<p class="a" id="x" class="b">x</p>', 'duplicate-attribute', 1, 21, 'class="item {kind}"'],
  ['a shorthand that is not a name', '<p {a.b}>x</p>', 'invalid-shorthand', 1, 4, 'name={a.b}'],
  ['an attribute value that never ends', '<p title="oops>x</p>', 'unclosed-attribute', 1, 10, 'closing "'],
  ['a second screen declaration', '<screen />\n<screen />', 'duplicate-screen', 2, 1, 'line 1'],
  ['a screen declaration after other markup', '<p>x</p>\n<screen />', 'screen-not-first', 2, 1, 'directly below the script'],
  ['a screen attribute that is an expression', '<screen size={size} />', 'screen-dynamic', 1, 9, 'plain values'],
  ['an unknown screen attribute', '<screen focuss="mouse" />', 'screen-attribute', 1, 9, 'Did you mean `focus`?'],
  ['an invalid screen value', '<screen size="big" />', 'screen-value', 1, 9, 'size="1920x1080"'],
  ['a hud screen that asks for focus', '<screen layer="hud" focus="mouse" />', 'hud-focus', 1, 21, 'Remove `focus`'],
  ['a style block inside an element', '<div><style>p {}</style></div>', 'nested-style', 1, 6, 'style:property'],
  ['a script tag', '<script>let a</script>', 'script-tag', 1, 1, '`---`'],
  ['a script that is never closed', '---\nconst a = 1;\n<p>x</p>', 'unclosed-script', 1, 1, 'only `---`'],
  ['a syntax error in the script', '---\nconst a = ;\n---\n<p>x</p>', 'script-syntax', 2, 11, ''],
  ['an export of a value in the script', '---\nexport const a = 1;\n---\n', 'script-export', 2, 1, 'Remove `export`'],
  ['a default export in the script', '---\nexport default 1;\n---\n', 'script-export', 2, 1, 'Remove `export`'],
  ['a surface screen that asks for focus', '<screen surface="phone" focus="mouse keyboard" />', 'surface-attribute', 1, 25, 'Remove `focus`'],
  ['a surface screen with a size', '<screen size="390x844" surface="phone" />', 'surface-attribute', 1, 9, 'Remove `size`'],
  ['a surface screen that closes with Escape', '<screen surface="tablet" close="escape" />', 'surface-attribute', 1, 26, 'Remove `close`'],
  ['a surface screen on a layer', '<screen surface="tablet" layer="hud" />', 'surface-attribute', 1, 26, 'Remove `layer`'],
  ['a surface screen that keeps game input', '<screen surface="phone" keep-input />', 'surface-attribute', 1, 25, 'Remove `keep-input`'],
  ['an unknown surface', '<screen surface="watch" />', 'screen-value', 1, 9, 'surface="phone"'],
  ['a variable called props', '---\nconst props = {};\n---\n', 'props-redeclared', 2, 7, 'props.name'],
  ['a name reserved for the compiler', '---\nconst $total = 1;\n---\n', 'reserved-name', 2, 7, '`total`'],
  ['await at the top of the script', '---\nconst data = await load();\n---\n', 'top-level-await', 2, 14, 'onMount(async'],
  ['an enum', '---\nenum Tab { Home }\n---\n', 'unsupported-typescript', 2, 1, 'as const'],
  ['a table row outside a table body', '<table><tr><td>x</td></tr></table>', 'invalid-nesting', 1, 8, '<tbody>'],
  ['a block element inside a paragraph', '<p><div>x</div></p>', 'invalid-nesting', 1, 4, '<span>'],
  ['a button inside a button', '<button><span><button>x</button></span></button>', 'invalid-nesting', 1, 15, 'Move the inner'],
  ['text directly inside a table row', '<table><tbody><tr>{name}</tr></tbody></table>', 'invalid-nesting', 1, 19, '<td>'],
  ['a slot attribute outside a component', '<div><p slot="footer">x</p></div>', 'invalid-slot', 1, 9, 'directly inside the component'],
  ['broken css', '<p>x</p>\n<style>\n  p { color: red;\n</style>', 'css-syntax', 3, 5, 'braces'],
  ['global without a selector', '<p>x</p>\n<style>\n  :global p { color: red; }\n</style>', 'invalid-global', 3, 3, ':global(.class-from-elsewhere)'],
];

describe('errors', () => {
  test.each(errors)('%s', (_, source, code, line, column, hint) => {
    const diagnostic = failure(source);
    expect({ code: diagnostic.code, line: diagnostic.line, column: diagnostic.column }).toEqual({ code, line, column });
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.filename).toBe('web/screens/Shop.nexus');
    expect(diagnostic.hint ?? '').toContain(hint);
    expect(source.slice(diagnostic.start, diagnostic.end).length).toBeGreaterThan(0);
  });

  test('the message of the error is ready to print: position, frame and what to write instead', () => {
    let message = '';
    try {
      compile('<section>\n  <div class="card">\n    <p>text</p>\n</section>\n', { filename: 'web/screens/Shop.nexus' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      [
        'web/screens/Shop.nexus:2:3: `<div>` is not closed: `</section>` on line 4 comes first. (unclosed-tag)',
        '',
        '  1 | <section>',
        '> 2 |   <div class="card">',
        '    |   ^^^^',
        '  3 |     <p>text</p>',
        '  4 | </section>',
        '',
        'Add `</div>` before that line. Every tag is closed explicitly, including <li> and <p>.',
        '',
      ].join('\n'),
    );
  });

  test('a frame marks the whole range on its line and keeps tabs aligned', () => {
    const diagnostic = failure('<div>\n\t<input bind:valeu={name}>\n</div>');
    expect(diagnostic.frame.split('\n').slice(1, 3)).toEqual(['> 2 |   <input bind:valeu={name}>', '    |               ^^^^^']);
  });
});

describe('warnings', () => {
  test('destructuring props', () => {
    const [warning] = warnings('---\nconst { item, price } = props;\n---\n<p>{item}</p>');
    expect(warning).toMatchObject({ code: 'props-destructured', severity: 'warning', line: 2, column: 7 });
    expect(warning!.hint).toContain('computed(() => props.name)');
  });

  test('an entity the compiler does not know', () => {
    const [warning] = warnings('<p>a &thetasym; b</p>');
    expect(warning).toMatchObject({ code: 'unknown-entity', line: 1, column: 6 });
  });

  test('a dynamic style attribute next to style directives', () => {
    const [warning] = warnings('<p style={css} style:color={colour}>x</p>');
    expect(warning).toMatchObject({ code: 'style-conflict', line: 1, column: 4 });
  });

  test('css that Chromium 103 cannot run is a warning marked as an error', () => {
    const found = warnings('<p>x</p>\n<style>\n  p:has(b) { translate: 10px; color: color-mix(in srgb, red, blue); }\n  @container (width > 10px) { p { color: red; } }\n</style>');
    expect(found.map((warning) => [warning.code, warning.severity, warning.line, warning.column])).toEqual([
      ['unsupported-css', 'error', 3, 4],
      ['unsupported-css', 'error', 3, 14],
      ['unsupported-css', 'error', 3, 38],
      ['unsupported-css', 'error', 4, 3],
    ]);
    expect(found[0]!.message).toBe('`:has()` needs Chromium 105. FiveM runs Chromium 103.');
    expect(found[1]!.hint).toContain('transform: translate');
  });

  test('a clean file has none', () => {
    expect(warnings('---\nconst a = 1;\n---\n<p class="a">{a}</p>\n<style>.a { color: red; }</style>')).toEqual([]);
  });
});
