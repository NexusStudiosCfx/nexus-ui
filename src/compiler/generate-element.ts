import type { Attribute, Directive, Element, ExpressionTag, Text } from './ast';
import { quote } from './context';
import { escapeHtml } from './entities';
import type { Env, Fragment, Ref } from './generate-fragment';
import { js, mapped, type Code } from './output';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const EVENT_FLAGS: Record<string, number> = { prevent: 1, stop: 2, self: 4, once: 8, capture: 16 };
const BIND_KINDS: Record<string, number> = { value: 0, checked: 1, group: 2 };

type Part = Text | ExpressionTag;

function parts(value: Part[]): (string | ExpressionTag)[] {
  return value.map((part) => (part.type === 'Text' ? part.data : part));
}

/** Emits the operations of an element and returns its markup. */
export function emitElement(fragment: Fragment, element: Element, ref: Ref, env: Env): string {
  const { context } = fragment;
  const { bindings } = env;
  let html = `<${element.name}`;
  // Bindings run after the children exist: a <select> can only take a value its options offer.
  const late: Code[] = [];

  const attribute = (node: Attribute): void => {
    const { name, value } = node;
    if (value === true) {
      html += ` ${name}`;
      return;
    }
    const pieces = parts(value);
    const only = pieces[0];
    const literal = pieces.length === 1 && typeof only === 'object' ? context.info(only.expression) : null;

    if (pieces.every((piece) => typeof piece === 'string')) {
      html += ` ${name}="${escapeHtml(pieces.join(''), true)}"`;
    } else if (literal && literal.kind === 'literal') {
      // `disabled={true}`, `tabindex={0}`: nothing to watch, so it goes into the markup.
      if (literal.literal === true) html += ` ${name}`;
      else if (literal.literal !== false && literal.literal !== null) html += ` ${name}="${escapeHtml(String(literal.literal), true)}"`;
    } else if (name === 'class') {
      fragment.operations.push(js`${context.helper('$class')}(${fragment.use(ref)}, ${context.textGetter(bindings, pieces)});\n`);
    } else {
      fragment.operations.push(js`${context.helper('$attr')}(${fragment.use(ref)}, ${quote(name)}, ${context.textGetter(bindings, pieces)});\n`);
    }
  };

  const directive = (node: Directive): void => {
    const target = fragment.use(ref);
    const only = node.value && node.value[0];
    const expression = only && only.type === 'ExpressionTag' ? only.expression : null;
    // `class:active` is short for `class:active={active}`: the name doubles as the expression.
    const shorthand = { type: 'Expression' as const, ...node.nameSpan, code: node.name };

    switch (node.kind) {
      case 'on': {
        const handler = expression as NonNullable<typeof expression>;
        const info = context.info(handler);
        const flags = node.modifiers.reduce((bits, modifier) => bits | (EVENT_FLAGS[modifier.name] as number), 0);
        const inScope = bindings.some((binding) => binding.names.some((name) => info.names.has(name)));
        // A function that is known now is passed as it is. Anything else is looked up when the
        // event fires, so a handler from props or from an `{#each}` item is always the current one.
        const direct = !inScope && (info.kind === 'identifier' || info.kind === 'function');
        const callback = direct
          ? context.source(handler)
          : context.arrow(bindings, info.names, js`(${context.source(handler)})${info.kind === 'function' ? '' : '?.'}($event)`, ['$event']);
        fragment.operations.push(js`${context.helper('$on')}(${target}, ${quote(node.name)}, ${callback}${flags ? `, ${flags}` : ''});\n`);
        break;
      }

      case 'bind': {
        const bound = expression ?? shorthand;
        if (node.name === 'this') {
          late.push(js`${context.helper('$ref')}(${target}, ${context.once(bindings, context.info(bound).names, context.source(bound))});\n`);
          break;
        }
        const info = context.info(bound);
        const get = context.arrow(bindings, info.names, context.source(bound));
        // A property can also be assigned, which is how a store is written to.
        const set = info.kind === 'member' ? context.arrow(bindings, info.names, js`(${context.source(bound)} = $value)`, ['$value']) : null;
        const where = context.options.dev ? `, ${set ? '' : 'undefined, '}${quote(context.where(node))}` : '';
        late.push(js`${context.helper('$bind')}(${target}, ${BIND_KINDS[node.name]}, ${get}${set ? js`, ${set}` : ''}${where});\n`);
        break;
      }

      case 'class':
        fragment.operations.push(js`${context.helper('$toggle')}(${target}, ${quote(node.name)}, ${context.getter(bindings, expression ?? shorthand)});\n`);
        break;

      case 'style': {
        const getter = node.value ? context.textGetter(bindings, parts(node.value)) : context.getter(bindings, shorthand);
        fragment.operations.push(js`${context.helper('$style')}(${target}, ${quote(node.name)}, ${getter});\n`);
        break;
      }

      case 'use': {
        const argument = expression ? js`, ${context.getter(bindings, expression)}` : '';
        fragment.operations.push(js`${context.helper('$use')}(${target}, ${mapped(node.nameSpan)}${argument});\n`);
        break;
      }

      case 'transition':
        fragment.operations.push(js`${context.helper('$transition')}(${target}, ${quote(node.name)});\n`);
        break;
    }
  };

  for (const node of element.attributes) {
    if (node.type === 'Attribute') attribute(node);
    else if (node.type === 'Directive') directive(node);
    else fragment.operations.push(js`${context.helper('$spread')}(${fragment.use(ref)}, ${context.getter(bindings, node.expression)});\n`);
  }

  if (context.options.scope) html += ` ${context.options.scope}`;
  html += '>';
  if (VOID.has(element.name)) {
    fragment.operations.push(...late);
    return html;
  }

  const preserve = env.preserve || element.name === 'pre' || element.name === 'textarea';
  const svg = element.name === 'svg' || (env.svg && element.name !== 'foreignObject');
  let content = fragment.children(element.children, ref, { ...env, preserve, svg });
  // The HTML parser drops a line break directly after these opening tags.
  if (preserve && content.startsWith('\n')) content = `\n${content}`;

  fragment.operations.push(...late);
  return `${html}${content}</${element.name}>`;
}
