import type { Attribute, EachBlock, IfBlock, IfBranch, KeyBlock, Root, Span, Style, TemplateNode } from './ast';
import type { Cursor } from './cursor';
import { locate } from './diagnostics';
import { decodeEntities, type UnknownReference } from './entities';
import { parseAttributes } from './parse-attributes';
import { parseEachHeader } from './parse-each';
import { suggest } from './suggest';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const TAG_NAME = /[A-Za-z][A-Za-z0-9._:-]*/y;
const BLOCK_WORD = /[a-z]*/y;

type BlockName = 'if' | 'each' | 'key';

/** What ends the list of nodes being read. */
type Parent =
  | { kind: 'root' }
  | { kind: 'element'; name: string; open: Span }
  | { kind: 'block'; name: BlockName; open: Span };

/** How a list of nodes ended: at its closing tag, or at an `{:else}` clause of its block. */
type Ending = { kind: 'close' } | { kind: 'else'; test: IfBranch['test']; start: number };

interface Context {
  cursor: Cursor;
  root: Root;
  /** False once anything other than whitespace has been read: `<screen>` must come first. */
  pristine: boolean;
}

export function parseTemplate(cursor: Cursor, root: Root): void {
  const context: Context = { cursor, root, pristine: true };
  root.children = parseNodes(context, { kind: 'root' }).children;
}

function describe(parent: Parent): string {
  return parent.kind === 'element' ? `<${parent.name}>` : parent.kind === 'block' ? `{#${parent.name}}` : 'the file';
}

function closerOf(parent: Parent): string {
  return parent.kind === 'element' ? `</${parent.name}>` : parent.kind === 'block' ? `{/${parent.name}}` : '';
}

function parseNodes(context: Context, parent: Parent): { children: TemplateNode[]; ending: Ending } {
  const { cursor } = context;
  const { source, reporter } = cursor;
  const children: TemplateNode[] = [];

  /** Something closes here that is not what is open. */
  const mismatch = (found: string, start: number, end: number): never => {
    if (parent.kind === 'root') {
      return reporter.error({
        code: 'unexpected-close',
        message: `\`${found}\` closes nothing: there is no matching opening before it.`,
        hint: `Remove \`${found}\`, or add the opening it belongs to.`,
        start,
        end,
      });
    }
    return reporter.error({
      code: parent.kind === 'element' ? 'unclosed-tag' : 'unclosed-block',
      message: `\`${describe(parent)}\` is not closed: \`${found}\` on line ${locate(source, start).line} comes first.`,
      hint: `Add \`${closerOf(parent)}\` before that line. Every tag is closed explicitly, including <li> and <p>.`,
      start: parent.open.start,
      end: parent.open.end,
    });
  };

  for (;;) {
    if (cursor.done) {
      if (parent.kind === 'root') return { children, ending: { kind: 'close' } };
      reporter.error({
        code: parent.kind === 'element' ? 'unclosed-tag' : 'unclosed-block',
        message: `\`${describe(parent)}\` is never closed.`,
        hint: `Add \`${closerOf(parent)}\` where it ends.`,
        start: parent.open.start,
        end: parent.open.end,
      });
    }

    const start = cursor.index;

    if (cursor.eat('<!--')) {
      const close = source.indexOf('-->', cursor.index);
      if (close === -1) {
        reporter.error({
          code: 'unclosed-comment',
          message: 'This comment is never closed.',
          hint: 'Add `-->` where the comment ends.',
          start,
          end: start + 4,
        });
      }
      cursor.index = close + 3;
      continue;
    }

    if (cursor.peek('</')) {
      cursor.index += 2;
      const name = cursor.match(TAG_NAME) ?? '';
      cursor.skipWhitespace();
      if (!cursor.eat('>')) {
        reporter.error({
          code: 'malformed-tag',
          message: 'A closing tag is written `</name>`.',
          start,
          end: cursor.index + 1,
        });
      }
      if (parent.kind === 'element' && parent.name === name) return { children, ending: { kind: 'close' } };
      if (VOID.has(name)) {
        reporter.error({
          code: 'void-element-closed',
          message: `\`<${name}>\` has no content and no closing tag.`,
          hint: `Remove \`</${name}>\`.`,
          start,
          end: cursor.index,
        });
      }
      mismatch(`</${name}>`, start, cursor.index);
    }

    if (cursor.peek('{/')) {
      cursor.index += 2;
      const name = cursor.match(BLOCK_WORD) ?? '';
      cursor.skipWhitespace();
      if (!cursor.eat('}')) {
        reporter.error({ code: 'malformed-block', message: `A block is closed with \`{/${name || 'if'}}\`.`, start, end: cursor.index + 1 });
      }
      if (parent.kind === 'block' && parent.name === name) return { children, ending: { kind: 'close' } };
      mismatch(`{/${name}}`, start, cursor.index);
    }

    if (cursor.peek('{:')) {
      const ending = parseClause(context, parent, start);
      return { children, ending };
    }

    if (cursor.peek('{#')) {
      context.pristine = false;
      children.push(parseBlock(context, start));
      continue;
    }

    if (cursor.peek('{@')) {
      context.pristine = false;
      cursor.index += 2;
      const word = cursor.match(BLOCK_WORD) ?? '';
      if (word !== 'html') {
        reporter.error({
          code: 'unknown-tag',
          message: `\`{@${word}}\` does not exist.`,
          hint: 'The only `{@...}` tag is `{@html expression}`.',
          start,
          end: cursor.index,
        });
      }
      const expression = cursor.expressionUntilBrace(start, cursor.index);
      children.push({ type: 'HtmlTag', start, end: cursor.index, expression });
      continue;
    }

    if (cursor.peek('{')) {
      context.pristine = false;
      const expression = cursor.expressionUntilBrace(start, start + 1);
      children.push({ type: 'ExpressionTag', start, end: cursor.index, expression });
      continue;
    }

    if (cursor.peek('<') && /[A-Za-z]/.test(source[start + 1] ?? '')) {
      const node = parseElement(context, parent, start);
      if (node) children.push(node);
      continue;
    }

    // Text runs to the next tag or brace. A `<` that starts no tag is text, as in HTML.
    let end = start + 1;
    while (end < source.length && source[end] !== '{' && !(source[end] === '<' && /[A-Za-z/!]/.test(source[end + 1] ?? ''))) end++;
    cursor.index = end;
    const raw = source.slice(start, end);
    if (/[^ \t\r\n\f]/.test(raw)) context.pristine = false;
    const unknown: UnknownReference[] = [];
    children.push({ type: 'Text', start, end, data: decodeEntities(raw, unknown) });
    for (const reference of unknown) {
      reporter.warn({
        code: 'unknown-entity',
        message: `\`&${reference.name};\` is not a character reference the compiler knows, so it is shown as written.`,
        hint: 'Type the character itself, or use a numeric reference such as `&#160;`.',
        start: start + reference.offset,
        end: start + reference.offset + reference.name.length + 2,
      });
    }
  }
}

function parseElement(context: Context, parent: Parent, start: number): TemplateNode | null {
  const { cursor, root } = context;
  const { reporter } = cursor;
  cursor.index = start + 1;
  const name = cursor.match(TAG_NAME) as string;
  const open: Span = { start, end: cursor.index };

  if (name === 'style') return parseStyle(context, parent, start);

  if (name === 'script') {
    reporter.error({
      code: 'script-tag',
      message: 'A .nexus file has no `<script>` tag.',
      hint: 'Put the code between two `---` lines at the top of the file.',
      start,
      end: cursor.index,
    });
  }

  const { attributes, selfClosing } = parseAttributes(cursor, name, start);

  if (name === 'screen') {
    if (root.screen) {
      reporter.error({
        code: 'duplicate-screen',
        message: 'A file has one `<screen>` declaration.',
        hint: `Remove this one: the screen is already declared on line ${locate(cursor.source, root.screen.start).line}.`,
        start,
        end: cursor.index,
      });
    }
    if (parent.kind !== 'root' || !context.pristine) {
      reporter.error({
        code: 'screen-not-first',
        message: '`<screen>` must be the first thing in the template.',
        hint: 'Move it directly below the script, before any other markup.',
        start,
        end: cursor.index,
      });
    }
    for (const attribute of attributes) {
      if (attribute.type !== 'Attribute' || (attribute.value !== true && attribute.value.some((part) => part.type !== 'Text'))) {
        reporter.error({
          code: 'screen-dynamic',
          message: 'The attributes of `<screen>` are read when the resource is built, so they cannot be expressions.',
          hint: 'Write plain values, for example `focus="mouse keyboard"`.',
          start: attribute.start,
          end: attribute.end,
        });
      }
    }
    if (!selfClosing) {
      // `<screen ...></screen>` is accepted; anything between the tags is not.
      cursor.skipWhitespace();
      if (!cursor.eat('</screen>')) {
        reporter.error({
          code: 'screen-content',
          message: '`<screen>` is a declaration and has no content.',
          hint: 'Close it with `/>` and put the markup after it.',
          start,
          end: open.end,
        });
      }
    }
    root.screen = { type: 'Screen', start, end: cursor.index, attributes: attributes as Attribute[] };
    return null;
  }

  context.pristine = false;
  const children = selfClosing || VOID.has(name) ? [] : parseNodes(context, { kind: 'element', name, open }).children;
  const end = cursor.index;

  if (name === 'slot') {
    let slotName = 'default';
    for (const attribute of attributes) {
      const value = attribute.type === 'Attribute' && attribute.name === 'name' && attribute.value !== true ? attribute.value : [];
      const text = value[0];
      if (value.length !== 1 || !text || text.type !== 'Text') {
        return reporter.error({
          code: 'invalid-slot',
          message: '`<slot>` takes one optional attribute: a fixed `name`.',
          hint: 'Write `<slot />` or `<slot name="footer" />`.',
          start: attribute.start,
          end: attribute.end,
        });
      }
      slotName = text.data;
    }
    return { type: 'Slot', start, end, name: slotName, attributes, children };
  }

  if (/^[A-Z]/.test(name) || name.includes('.')) return { type: 'Component', start, end, name, attributes, children };
  return { type: 'Element', start, end, name, attributes, children };
}

function parseStyle(context: Context, parent: Parent, start: number): null {
  const { cursor, root } = context;
  const { reporter, source } = cursor;
  if (parent.kind !== 'root') {
    reporter.error({
      code: 'nested-style',
      message: '`<style>` must be at the top level of the file.',
      hint: `Move it out of ${describe(parent)}. For styles computed at runtime, use \`style:property={value}\`.`,
      start,
      end: cursor.index,
    });
  }
  const { attributes, selfClosing } = parseAttributes(cursor, 'style', start);
  let global = false;
  for (const attribute of attributes) {
    if (attribute.type === 'Attribute' && attribute.name === 'global' && attribute.value === true) global = true;
    else {
      reporter.error({
        code: 'invalid-style-attribute',
        message: '`<style>` takes one optional attribute: `global`.',
        hint: 'Write `<style>` for scoped styles or `<style global>` for unscoped ones.',
        start: attribute.start,
        end: attribute.end,
      });
    }
  }
  const contentStart = cursor.index;
  const close = selfClosing ? contentStart : source.indexOf('</style>', contentStart);
  if (close === -1) {
    reporter.error({
      code: 'unclosed-tag',
      message: '`<style>` is never closed.',
      hint: 'Add `</style>` after the last rule.',
      start,
      end: start + 6,
    });
  }
  cursor.index = selfClosing ? contentStart : close + 8;
  const style: Style = {
    type: 'Style',
    start,
    end: cursor.index,
    global,
    content: { start: contentStart, end: close, code: source.slice(contentStart, close) },
  };
  root.styles.push(style);
  return null;
}

/** `{:else}` or `{:else if test}`: ends the current list and tells the block what follows. */
function parseClause(context: Context, parent: Parent, start: number): Ending {
  const { cursor } = context;
  const { reporter } = cursor;
  cursor.index += 2;
  const word = cursor.match(BLOCK_WORD) ?? '';
  if (word !== 'else') {
    reporter.error({
      code: 'unknown-clause',
      message: `\`{:${word}}\` does not exist.`,
      hint: 'A block continues with `{:else}` or, inside `{#if}`, `{:else if condition}`.',
      start,
      end: cursor.index,
    });
  }
  if (parent.kind !== 'block' || parent.name === 'key') {
    return reporter.error({
      code: 'misplaced-else',
      message:
        parent.kind === 'element'
          ? `\`{:else}\` is inside \`<${parent.name}>\`, which is still open.`
          : '`{:else}` belongs directly inside `{#if}` or `{#each}`.',
      hint:
        parent.kind === 'element'
          ? `Close \`<${parent.name}>\` before \`{:else}\`, or move the whole element into one branch.`
          : 'Wrap the alternatives in `{#if condition} ... {:else} ... {/if}`.',
      start,
      end: cursor.index,
    });
  }
  cursor.skipWhitespace();
  if (cursor.eat('}')) return { kind: 'else', test: null, start };

  const wordStart = cursor.index;
  if (cursor.match(BLOCK_WORD) !== 'if' || parent.name !== 'if') {
    reporter.error({
      code: 'malformed-else',
      message: parent.name === 'if' ? 'After `{:else` comes `}` or `if condition}`.' : '`{#each}` has a plain `{:else}`, shown while the list is empty.',
      hint: parent.name === 'if' ? 'Write `{:else}` or `{:else if condition}`.' : 'Write `{:else}`.',
      start,
      end: Math.max(cursor.index, wordStart + 1),
    });
  }
  return { kind: 'else', test: cursor.expressionUntilBrace(start, cursor.index), start };
}

function parseBlock(context: Context, start: number): IfBlock | EachBlock | KeyBlock {
  const { cursor } = context;
  const { reporter } = cursor;
  cursor.index += 2;
  const word = cursor.match(BLOCK_WORD) ?? '';
  const open: Span = { start, end: cursor.index };

  if (word !== 'if' && word !== 'each' && word !== 'key') {
    const close = suggest(word, ['if', 'each', 'key']);
    reporter.error({
      code: 'unknown-block',
      message: `\`{#${word}}\` does not exist.`,
      hint: close ? `Did you mean \`{#${close}}\`?` : 'The blocks are `{#if}`, `{#each}` and `{#key}`.',
      start,
      end: cursor.index,
    });
  }

  if (word === 'key') {
    const expression = cursor.expressionUntilBrace(start, cursor.index);
    const { children } = parseNodes(context, { kind: 'block', name: 'key', open });
    return { type: 'KeyBlock', start, end: cursor.index, expression, children };
  }

  if (word === 'each') {
    const close = cursor.closing(start);
    const header = parseEachHeader(cursor, open.end, close);
    cursor.index = close + 1;
    const body = parseNodes(context, { kind: 'block', name: 'each', open });
    let fallback: TemplateNode[] | null = null;
    if (body.ending.kind === 'else') {
      const rest = parseNodes(context, { kind: 'block', name: 'each', open });
      if (rest.ending.kind === 'else') {
        reporter.error({
          code: 'duplicate-else',
          message: '`{#each}` can have one `{:else}`.',
          hint: 'Remove this one.',
          start: rest.ending.start,
          end: rest.ending.start + 7,
        });
      }
      fallback = rest.children;
    }
    return { type: 'EachBlock', start, end: cursor.index, ...header, children: body.children, fallback };
  }

  const branches: IfBranch[] = [];
  let test: IfBranch['test'] = cursor.expressionUntilBrace(start, cursor.index);
  let branchStart = start;
  for (;;) {
    const { children, ending } = parseNodes(context, { kind: 'block', name: 'if', open });
    branches.push({ start: branchStart, end: ending.kind === 'else' ? ending.start : cursor.index, test, children });
    if (ending.kind === 'close') break;
    if (test === null) {
      reporter.error({
        code: 'else-after-else',
        message: '`{:else}` is the last branch of `{#if}`.',
        hint: 'Move this branch above `{:else}`, as `{:else if condition}`.',
        start: ending.start,
        end: ending.start + 7,
      });
    }
    test = ending.test;
    branchStart = ending.start;
  }
  return { type: 'IfBlock', start, end: cursor.index, branches };
}
