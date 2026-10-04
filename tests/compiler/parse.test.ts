import { describe, expect, test } from 'vitest';
import { parse } from '../../src/compiler';
import type { Attribute, Component, Directive, EachBlock, Element, ExpressionTag, IfBlock, KeyBlock, Slot, Spread, TemplateNode, Text } from '../../src/compiler';

/** The template nodes of a file, without the whitespace between them. */
function nodes(source: string): TemplateNode[] {
  return parse(source).children.filter((node) => node.type !== 'Text' || node.data.trim() !== '');
}

function first<T extends TemplateNode>(source: string): T {
  return nodes(source)[0] as T;
}

describe('file structure', () => {
  test('script, template and styles are separated', () => {
    const source = '---\nconst a = 1;\n---\n\n<p>hi</p>\n\n<style>p { color: red; }</style>\n<style global>body { margin: 0; }</style>\n';
    const root = parse(source);
    expect(root.script?.content.code).toBe('const a = 1;\n');
    expect(source.slice(root.script!.content.start, root.script!.content.end)).toBe('const a = 1;\n');
    expect(nodes(source)).toHaveLength(1);
    expect(root.styles.map((style) => [style.global, style.content.code])).toEqual([
      [false, 'p { color: red; }'],
      [true, 'body { margin: 0; }'],
    ]);
  });

  test('a file needs neither script nor styles', () => {
    const root = parse('<p>hi</p>');
    expect(root.script).toBeNull();
    expect(root.styles).toEqual([]);
    expect(root.screen).toBeNull();
  });

  test('--- further down is not a script', () => {
    const root = parse('<p>a</p>\n---\n<p>b</p>');
    expect(root.script).toBeNull();
  });

  test('the screen declaration is kept apart from the template', () => {
    const root = parse('<screen focus="mouse" keep-input />\n<p>hi</p>');
    expect(root.screen?.attributes.map((attribute) => attribute.name)).toEqual(['focus', 'keep-input']);
    expect(nodes('<screen focus="mouse" />\n<p>hi</p>')).toHaveLength(1);
  });

  test('every node knows where it is in the source', () => {
    const source = '<ul>\n  {#each list as item}<li>{item}</li>{/each}\n</ul>';
    const list = first<Element>(source);
    const each = list.children.find((node) => node.type === 'EachBlock') as EachBlock;
    expect(source.slice(list.start, list.end)).toBe(source);
    expect(source.slice(each.start, each.end)).toBe('{#each list as item}<li>{item}</li>{/each}');
    expect(source.slice(each.expression.start, each.expression.end)).toBe('list');
    expect(source.slice(each.item.start, each.item.end)).toBe('item');
  });
});

describe('elements and text', () => {
  test('void elements need no closing tag or slash', () => {
    const [input, br, image, paragraph] = nodes('<input type="text"><br/><img src="a.png"><p>after</p>') as Element[];
    expect([input!.name, br!.name, image!.name, paragraph!.name]).toEqual(['input', 'br', 'img', 'p']);
    expect(input!.children).toEqual([]);
  });

  test('comments are dropped', () => {
    const paragraph = first<Element>('<p>a<!-- not {shown} <b> -->b</p>');
    expect(paragraph.children.map((node) => (node as Text).data)).toEqual(['a', 'b']);
  });

  test('character references are decoded', () => {
    const paragraph = first<Element>('<p>&lt;a&gt; &amp; &#169; &#x41; &nbsp;</p>');
    expect((paragraph.children[0] as Text).data).toBe('<a> & \u00a9 A \u00a0');
  });

  test('a < that starts no tag is text', () => {
    const paragraph = first<Element>('<p>1 < 2 and 3 <= 4</p>');
    expect((paragraph.children[0] as Text).data).toBe('1 < 2 and 3 <= 4');
  });

  test('components, dotted components and slots are told apart from elements', () => {
    const [component, dotted, slot, named, element] = nodes('<Price value={1} /><ui.Button>go</ui.Button><slot /><slot name="footer">none</slot><price-tag></price-tag>');
    expect(component).toMatchObject({ type: 'Component', name: 'Price' });
    expect(dotted).toMatchObject({ type: 'Component', name: 'ui.Button' });
    expect((dotted as Component).children).toHaveLength(1);
    expect(slot).toMatchObject({ type: 'Slot', name: 'default' });
    expect(named).toMatchObject({ type: 'Slot', name: 'footer' });
    expect((named as Slot).children).toHaveLength(1);
    expect(element).toMatchObject({ type: 'Element', name: 'price-tag' });
  });
});

describe('expressions', () => {
  const expression = (source: string): string => (first<ExpressionTag>(source).expression.code);

  test('a closing brace inside a string, a template literal, a comment or a regular expression does not end it', () => {
    expect(expression(`{ '}' + "}" }`)).toBe(`'}' + "}"`);
    expect(expression('{ `a${ { b: `}` }.b }c}` }')).toBe('`a${ { b: `}` }.b }c}`');
    expect(expression('{ value /* } */ }')).toBe('value /* } */');
    expect(expression('{ text.replace(/[}]+/g, "") }')).toBe('text.replace(/[}]+/g, "")');
    expect(expression('{ a / b / c }')).toBe('a / b / c');
  });

  test('nested braces are matched', () => {
    expect(expression('{ { a: { b: [1, { c: 2 }] } }.a }')).toBe('{ a: { b: [1, { c: 2 }] } }.a');
    expect(expression('{ items.map((item) => { return item.id; }) }')).toBe('items.map((item) => { return item.id; })');
  });

  test('the span of an expression excludes the braces and the padding', () => {
    const source = '<p>{  count + 1  }</p>';
    const tag = first<Element>(source).children[0] as ExpressionTag;
    expect(source.slice(tag.start, tag.end)).toBe('{  count + 1  }');
    expect(source.slice(tag.expression.start, tag.expression.end)).toBe('count + 1');
  });
});

describe('attributes', () => {
  const attributes = (source: string): Element['attributes'] => first<Element>(source).attributes;

  test('every form of attribute', () => {
    const [text, single, bare, dynamic, mixed, shorthand, spread, unquoted] = attributes(
      `<a href="/x" title='its' disabled id={id} class="item {kind} big" {name} {...rest} tabindex=0></a>`,
    );
    expect(text).toMatchObject({ type: 'Attribute', name: 'href', value: [{ type: 'Text', data: '/x' }] });
    expect(single).toMatchObject({ name: 'title', value: [{ data: 'its' }] });
    expect(bare).toMatchObject({ name: 'disabled', value: true });
    expect((dynamic as Attribute).value).toMatchObject([{ type: 'ExpressionTag', expression: { code: 'id' } }]);
    expect(((mixed as Attribute).value as (Text | ExpressionTag)[]).map((part) => part.type)).toEqual(['Text', 'ExpressionTag', 'Text']);
    expect(shorthand).toMatchObject({ name: 'name', value: [{ expression: { code: 'name' } }] });
    expect((spread as Spread).expression.code).toBe('rest');
    expect(unquoted).toMatchObject({ name: 'tabindex', value: [{ data: '0' }] });
  });

  test('directives, their names and their modifiers', () => {
    const source = '<input on:click|prevent|stop={save} bind:value={name} class:active={on} style:--gap="{gap}px" use:tooltip={text} transition:fade class:busy>';
    const directives = attributes(source) as Directive[];
    expect(directives.map((directive) => [directive.kind, directive.name])).toEqual([
      ['on', 'click'],
      ['bind', 'value'],
      ['class', 'active'],
      ['style', '--gap'],
      ['use', 'tooltip'],
      ['transition', 'fade'],
      ['class', 'busy'],
    ]);
    expect(directives[0]!.modifiers.map((modifier) => modifier.name)).toEqual(['prevent', 'stop']);
    expect(directives[0]!.modifiers.map((modifier) => source.slice(modifier.start, modifier.end))).toEqual(['prevent', 'stop']);
    expect(source.slice(directives[3]!.nameSpan.start, directives[3]!.nameSpan.end)).toBe('--gap');
    expect(directives[5]!.value).toBeNull();
    expect(directives[6]!.value).toBeNull();
  });

  test('prefixed svg attributes are ordinary attributes', () => {
    expect(attributes('<use xlink:href="#icon" xml:lang="en"></use>').map((attribute) => attribute.type)).toEqual(['Attribute', 'Attribute']);
  });
});

describe('blocks', () => {
  test('if with else if and else', () => {
    const block = first<IfBlock>('{#if a}A{:else if b}B{:else}C{/if}');
    expect(block.branches.map((branch) => branch.test?.code ?? null)).toEqual(['a', 'b', null]);
    expect(block.branches.map((branch) => (branch.children[0] as Text).data)).toEqual(['A', 'B', 'C']);
  });

  test('each: item, index, key and else', () => {
    const block = first<EachBlock>('{#each rows as row, i (row.id)}<li>{row}</li>{:else}<li>none</li>{/each}');
    expect(block.expression.code).toBe('rows');
    expect(block.item.code).toBe('row');
    expect(block.index?.name).toBe('i');
    expect(block.key?.code).toBe('row.id');
    expect(block.children).toHaveLength(1);
    expect(block.fallback).toHaveLength(1);
  });

  test('each: a destructured item, and a list expression that contains as and parentheses', () => {
    const destructured = first<EachBlock>('{#each rows as { id, tags: [first] } (id)}x{/each}');
    expect(destructured.item.code).toBe('{ id, tags: [first] }');
    expect(destructured.key?.code).toBe('id');

    const cast = first<EachBlock>('{#each (data as Row[]).filter((row) => row.on) as row}x{/each}');
    expect(cast.expression.code).toBe('(data as Row[]).filter((row) => row.on)');
    expect(cast.item.code).toBe('row');
    expect(cast.index).toBeNull();
    expect(cast.key).toBeNull();
    expect(cast.fallback).toBeNull();
  });

  test('key and html', () => {
    expect(first<KeyBlock>('{#key id}<p>x</p>{/key}')).toMatchObject({ type: 'KeyBlock', expression: { code: 'id' } });
    expect(first('{@html content}')).toMatchObject({ type: 'HtmlTag', expression: { code: 'content' } });
  });

  test('blocks nest inside elements and each other', () => {
    const list = first<Element>('<ul>{#each groups as group}{#if group.open}<li>{group.name}</li>{/if}{/each}</ul>');
    const each = list.children[0] as EachBlock;
    const condition = each.children[0] as IfBlock;
    expect(condition.branches[0]!.children[0]).toMatchObject({ type: 'Element', name: 'li' });
  });
});
