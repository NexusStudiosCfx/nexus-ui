import type { Attribute, Component, EachBlock, ExpressionTag, HtmlTag, IfBlock, KeyBlock, Slot, TemplateNode } from './ast';
import { quote, type Binding, type Context } from './context';
import { renderFunction, type Env, type Fragment, type Ref } from './generate-fragment';
import { indent, js, join, mapped, type Code } from './output';

type Anchored = Component | Slot | IfBlock | EachBlock | KeyBlock | HtmlTag;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Emits the operation of a node that renders at an anchor comment. */
export function emitAnchored(fragment: Fragment, node: Anchored, ref: Ref, env: Env): void {
  const { context } = fragment;
  const anchor = fragment.use(ref);
  // Content rendered at an anchor starts a new fragment, where whitespace is trimmed again.
  const inner: Env = { ...env, preserve: false };

  switch (node.type) {
    case 'Component':
      fragment.operations.push(js`${anchor}.before(${componentCall(context, node, env)});\n`);
      break;

    case 'Slot': {
      const fallback = renderFunction(context, node.children, inner);
      fragment.operations.push(js`${context.helper('$slot')}(${anchor}, props, ${quote(node.name)}${fallback ? js`, ${fallback}` : ''});\n`);
      break;
    }

    case 'HtmlTag':
      fragment.operations.push(js`${context.helper('$html')}(${anchor}, ${context.getter(env.bindings, node.expression)});\n`);
      break;

    case 'KeyBlock': {
      const render = renderFunction(context, node.children, inner);
      if (render) {
        fragment.operations.push(js`${context.helper('$key')}(${anchor}, ${context.getter(env.bindings, node.expression)}, ${render});\n`);
      }
      break;
    }

    case 'IfBlock':
      fragment.operations.push(ifBlock(context, node, anchor, inner));
      break;

    case 'EachBlock':
      fragment.operations.push(eachBlock(context, node, anchor, inner));
      break;
  }
}

function ifBlock(context: Context, node: IfBlock, anchor: string, env: Env): Code {
  const names = new Set<string>();
  const test: Code = [];
  let last = -1;
  node.branches.forEach((branch, index) => {
    if (!branch.test) {
      last = index;
      return;
    }
    for (const name of context.info(branch.test).names) names.add(name);
    test.push(...js`${context.value(branch.test, true)} ? ${index} : `);
  });
  test.push(String(last));

  const branches = node.branches.map((branch) => renderFunction(context, branch.children, env) ?? ['null']);
  return js`${context.helper('$if')}(${anchor}, ${context.arrow(env.bindings, names, test)}, [\n${indent(join(branches, ',\n'))},\n]);\n`;
}

function eachBlock(context: Context, node: EachBlock, anchor: string, env: Env): Code {
  const names = context.analysis.patterns.get(node) as string[];
  const item: Binding = {
    names,
    pattern: node.item,
    signal: context.unique(`$$${IDENTIFIER.test(node.item.code) ? node.item.code : 'item'}`),
  };
  const bindings = [...env.bindings, item];
  const params = [item.signal];
  if (node.index) {
    const index: Binding = { names: [node.index.name], pattern: node.index, signal: context.unique(`$$${node.index.name}`) };
    bindings.push(index);
    params.push(index.signal);
  }

  let key: Code = ['null'];
  if (node.key) {
    // The key is computed from the plain item, before a row exists for it.
    const head = js`(${mapped(node.item)}${node.index ? js`, ${mapped(node.index)}` : ''}) => `;
    const info = context.info(node.key);
    // The item and the index are parameters of the key function, so they hide outer names.
    const own = bindings.slice(env.bindings.length).flatMap((binding) => binding.names);
    const outer = context.prelude(env.bindings, info.names, own);
    const value = info.needsParens ? js`(${context.source(node.key)})` : context.source(node.key);
    key = outer.length ? js`${head}{ ${outer}return ${value}; }` : js`${head}${value}`;
  }

  const row = renderFunction(context, node.children, { ...env, bindings }, params) ?? js`() => document.createDocumentFragment()`;
  const fallback = node.fallback && renderFunction(context, node.fallback, env);
  const where = context.options.dev ? quote(context.where(node)) : null;
  const tail = where ? js`, ${fallback ?? 'null'}, ${where}` : fallback ? js`, ${fallback}` : '';
  return js`${context.helper('$each')}(${anchor}, ${context.getter(env.bindings, node.expression)}, ${key}, ${row}${tail});\n`;
}

function staticText(attribute: Attribute): string | null {
  if (attribute.value === true) return null;
  return attribute.value.every((part) => part.type === 'Text') ? attribute.value.map((part) => (part.type === 'Text' ? part.data : '')).join('') : null;
}

/** `Name(props)`: creates a component, with its dynamic props as getters so they stay reactive. */
export function componentCall(context: Context, node: Component, env: Env): Code {
  const { bindings } = env;
  // Objects in source order; a spread starts a new one, so that later props win over it.
  const sources: Code[] = [];
  let members: Code[] = [];

  const flush = (): void => {
    if (members.length) sources.push(js`{\n${indent(join(members, ',\n'))},\n}`);
    members = [];
  };

  for (const attribute of node.attributes) {
    if (attribute.type === 'Spread') {
      flush();
      sources.push(context.getter(bindings, attribute.expression));
    } else if (attribute.type === 'Attribute' && attribute.name !== 'slot') {
      const name = IDENTIFIER.test(attribute.name) ? attribute.name : quote(attribute.name);
      const text = staticText(attribute);
      if (attribute.value === true) {
        members.push(js`${name}: true`);
      } else if (text !== null) {
        members.push(js`${name}: ${quote(text)}`);
      } else {
        const parts = attribute.value.map((part) => (part.type === 'Text' ? part.data : part)) as (string | ExpressionTag)[];
        const names = context.names(parts);
        members.push(js`get ${name}() { ${context.prelude(bindings, names)}return ${context.text(parts)}; }`);
      }
    }
  }

  // Children go to the default slot, except those that name another one with `slot="..."`.
  const slots = new Map<string, TemplateNode[]>();
  for (const child of node.children) {
    let slot = 'default';
    if (child.type === 'Element' || child.type === 'Component') {
      const named = child.attributes.find((attribute): attribute is Attribute => attribute.type === 'Attribute' && attribute.name === 'slot');
      if (named) {
        slot = staticText(named) as string;
        child.attributes = child.attributes.filter((attribute) => attribute !== named);
      }
    }
    slots.set(slot, [...(slots.get(slot) ?? []), child]);
  }
  const rendered: Code[] = [];
  for (const [slot, children] of slots) {
    const render = renderFunction(context, children, { ...env, svg: false, preserve: false });
    if (render) rendered.push(js`${IDENTIFIER.test(slot) ? slot : quote(slot)}: ${render}`);
  }
  if (rendered.length) members.push(js`$slots: {\n${indent(join(rendered, ',\n'))},\n}`);
  flush();

  const callee = mapped({ start: node.start + 1, end: node.start + 1 + node.name.length });
  if (!sources.length) return js`${callee}({})`;
  if (sources.length === 1 && !node.attributes.some((attribute) => attribute.type === 'Spread')) return js`${callee}(${sources[0] as Code})`;
  return js`${callee}(${context.helper('$props')}(${join(sources, ', ')}))`;
}
