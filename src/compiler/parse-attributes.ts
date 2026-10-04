import type { Attribute, AttributeNode, Directive, DirectiveKind, ExpressionTag, Span, Text } from './ast';
import type { Cursor } from './cursor';
import { decodeEntities } from './entities';
import { suggest } from './suggest';

const DIRECTIVES: readonly DirectiveKind[] = ['on', 'bind', 'class', 'style', 'use', 'transition'];

// Prefixes that are part of an ordinary attribute name in SVG and XML.
const XML_PREFIXES = new Set(['xlink', 'xml', 'xmlns']);

const NAME = /[^\s=>"'<{/]+/y;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Part = Text | ExpressionTag;

export interface ParsedTag {
  attributes: AttributeNode[];
  selfClosing: boolean;
}

/** Reads attributes up to and including the `>` or `/>` of a tag that started at `tagStart`. */
export function parseAttributes(cursor: Cursor, tagName: string, tagStart: number): ParsedTag {
  const attributes: AttributeNode[] = [];
  const seen = new Set<string>();

  for (;;) {
    cursor.skipWhitespace();
    if (cursor.done) {
      cursor.reporter.error({
        code: 'unclosed-tag',
        message: `The \`<${tagName}\` tag is never finished.`,
        hint: 'Add `>` after its last attribute.',
        start: tagStart,
        end: tagStart + tagName.length + 1,
      });
    }
    if (cursor.eat('/>')) return { attributes, selfClosing: true };
    if (cursor.eat('>')) return { attributes, selfClosing: false };

    const node = cursor.peek('{') ? parseBraced(cursor) : parseNamed(cursor, tagName);
    const identity = node.type === 'Spread' ? null : node.type === 'Directive' ? `${node.kind}:${node.name}` : node.name;
    if (identity) {
      if (seen.has(identity)) {
        cursor.reporter.error({
          code: 'duplicate-attribute',
          message: `\`${identity}\` is set twice on this \`<${tagName}>\`.`,
          hint: 'Keep one of them. To combine static and dynamic text, write `class="item {kind}"`.',
          start: node.start,
          end: node.end,
        });
      }
      seen.add(identity);
    }
    attributes.push(node);
  }
}

function parseBraced(cursor: Cursor): AttributeNode {
  const start = cursor.index;
  if (cursor.peek('{...')) {
    const expression = cursor.expressionUntilBrace(start, start + 4);
    return { type: 'Spread', start, end: cursor.index, expression };
  }
  const expression = cursor.expressionUntilBrace(start, start + 1);
  if (!IDENTIFIER.test(expression.code)) {
    cursor.reporter.error({
      code: 'invalid-shorthand',
      message: '`{...}` in a tag must be a name, as in `{disabled}`, or a spread, as in `{...rest}`.',
      hint: `Give the attribute a name: \`name={${expression.code}}\`.`,
      start,
      end: cursor.index,
    });
  }
  const tag: ExpressionTag = { type: 'ExpressionTag', start, end: cursor.index, expression };
  return { type: 'Attribute', start, end: cursor.index, name: expression.code, value: [tag] };
}

function parseNamed(cursor: Cursor, tagName: string): Attribute | Directive {
  const start = cursor.index;
  const name = cursor.match(NAME);
  if (!name) {
    return cursor.reporter.error({
      code: 'unexpected-character',
      message: `Unexpected \`${cursor.source[start]}\` in the \`<${tagName}>\` tag.`,
      hint: 'Attributes are written `name="text"`, `name={expression}` or `{name}`.',
      start,
      end: start + 1,
    });
  }
  const nameEnd = cursor.index;

  let value: true | Part[] = true;
  cursor.skipWhitespace();
  if (cursor.eat('=')) {
    cursor.skipWhitespace();
    value = parseValue(cursor, name);
  } else {
    cursor.index = nameEnd;
  }
  const end = cursor.index;

  foreignSyntax(cursor, tagName, name, start, nameEnd, value);

  const colon = name.indexOf(':');
  if (colon === -1 || XML_PREFIXES.has(name.slice(0, colon))) {
    return { type: 'Attribute', start, end, name, value };
  }

  const kind = name.slice(0, colon) as DirectiveKind;
  if (!DIRECTIVES.includes(kind)) {
    const close = suggest(kind, DIRECTIVES);
    cursor.reporter.error({
      code: 'unknown-directive',
      message: `\`${kind}:\` is not a directive.`,
      hint: close
        ? `Did you mean \`${close}:${name.slice(colon + 1)}\`?`
        : 'The directives are `on:`, `bind:`, `class:`, `style:`, `use:` and `transition:`.',
      start,
      end: start + colon + 1,
    });
  }

  const [target = '', ...flags] = name.slice(colon + 1).split('|');
  const nameSpan: Span = { start: start + colon + 1, end: start + colon + 1 + target.length };
  if (!target) {
    cursor.reporter.error({
      code: 'directive-missing-name',
      message: `\`${kind}:\` needs a name after the colon.`,
      hint: EXAMPLES[kind],
      start,
      end: nameEnd,
    });
  }

  let offset = nameSpan.end + 1;
  const modifiers = flags.map((flag) => {
    const modifier = { name: flag, start: offset, end: offset + flag.length };
    offset += flag.length + 1;
    return modifier;
  });

  return { type: 'Directive', start, end, kind, name: target, nameSpan, modifiers, value: value === true ? null : value };
}

const EXAMPLES: Record<DirectiveKind, string> = {
  on: 'For example `on:click={save}`.',
  bind: 'For example `bind:value={name}`.',
  class: 'For example `class:active={isActive}`.',
  style: 'For example `style:width={width}`.',
  use: 'For example `use:tooltip={text}`.',
  transition: 'For example `transition:fade`.',
};

/** Syntax from other frameworks that would otherwise become a meaningless attribute. */
function foreignSyntax(cursor: Cursor, tagName: string, name: string, start: number, nameEnd: number, value: true | Part[]): void {
  const dynamic = value !== true && value.some((part) => part.type === 'ExpressionTag');
  // On a component `onSelect={...}` is an ordinary prop.
  const element = !/^[A-Z]/.test(tagName) && !tagName.includes('.');
  let hint: string | undefined;
  if (name.startsWith('@')) hint = `Write \`on:${name.slice(1)}={handler}\`.`;
  else if (name.startsWith(':')) hint = `Write \`${name.slice(1)}={value}\`.`;
  else if (name.startsWith('v-') || name.startsWith('#')) hint = 'Use `{#if}` and `{#each}` blocks around the element instead.';
  else if (element && /^on[A-Za-z]+$/.test(name) && dynamic) hint = `Write \`on:${name.slice(2).toLowerCase()}={handler}\`.`;
  else if (element && name === 'className') hint = 'Write `class`.';
  if (hint) {
    cursor.reporter.error({
      code: 'foreign-syntax',
      message: `\`${name}\` is not how this is written in a .nexus file.`,
      hint,
      start,
      end: nameEnd,
    });
  }
}

function parseValue(cursor: Cursor, name: string): Part[] {
  const start = cursor.index;
  const quote = cursor.source[start];

  if (quote === '{') {
    const expression = cursor.expressionUntilBrace(start, start + 1);
    return [{ type: 'ExpressionTag', start, end: cursor.index, expression }];
  }

  const quoted = quote === '"' || quote === "'";
  if (quoted) cursor.index++;
  const parts: Part[] = [];
  let textStart = cursor.index;

  const flush = (): void => {
    if (cursor.index > textStart) {
      const raw = cursor.source.slice(textStart, cursor.index);
      parts.push({ type: 'Text', start: textStart, end: cursor.index, data: decodeEntities(raw) });
    }
  };

  for (;;) {
    const char = cursor.source[cursor.index];
    if (char === undefined || (!quoted && /[\s>]/.test(char)) || (!quoted && char === '/' && cursor.peek('/>'))) {
      if (quoted) {
        cursor.reporter.error({
          code: 'unclosed-attribute',
          message: `The value of \`${name}\` is never closed.`,
          hint: `Add the closing ${quote} after the value.`,
          start,
          end: start + 1,
        });
      }
      flush();
      break;
    }
    if (quoted && char === quote) {
      flush();
      cursor.index++;
      break;
    }
    if (char === '{') {
      flush();
      const open = cursor.index;
      const expression = cursor.expressionUntilBrace(open, open + 1);
      parts.push({ type: 'ExpressionTag', start: open, end: cursor.index, expression });
      textStart = cursor.index;
      continue;
    }
    cursor.index++;
  }

  if (!quoted && !parts.length) {
    cursor.reporter.error({
      code: 'missing-attribute-value',
      message: `\`${name}=\` has no value.`,
      hint: `Write \`${name}="text"\` or \`${name}={expression}\`, or remove the \`=\`.`,
      start,
      end: start + 1,
    });
  }
  return parts;
}
