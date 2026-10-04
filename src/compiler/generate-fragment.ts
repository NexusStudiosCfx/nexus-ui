import type { TemplateNode } from './ast';
import type { Binding, Context } from './context';
import { escapeHtml } from './entities';
import { componentCall, emitAnchored } from './generate-blocks';
import { emitElement } from './generate-element';
import { normalize, type Item } from './normalize';
import { indent, js, type Code } from './output';

/** Where a fragment is generated: what is in scope and how its markup has to be parsed. */
export interface Env {
  bindings: Binding[];
  /** The markup is inside an `<svg>`. */
  svg: boolean;
  /** Inside `<pre>` or `<textarea>`: whitespace is kept as written. */
  preserve: boolean;
}

/** A node of the cloned template that the generated code may need a variable for. */
export interface Ref {
  parent: Ref | null;
  /** Position among the child nodes of `parent`. */
  index: number;
  hint: string;
  name?: string;
}

// Elements that only exist in SVG. A fragment made of these is parsed as SVG even when the
// `<svg>` itself is in another component.
const SVG_ONLY = new Set([
  'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'tspan', 'defs', 'use', 'linearGradient',
  'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'filter', 'foreignObject',
]);

/** Builds the markup and the code of one fragment. */
export class Fragment {
  /** Operations on the nodes, in document order. */
  readonly operations: Code[] = [];
  private readonly declared: Ref[] = [];

  constructor(
    readonly context: Context,
    readonly env: Env,
  ) {}

  /** The variable that holds a node, declaring it (and what leads to it) on first use. */
  use(ref: Ref): string {
    if (!ref.name) {
      if (ref.parent) this.use(ref.parent);
      ref.name = this.context.unique(ref.hint);
      this.declared.push(ref);
    }
    return ref.name;
  }

  /** The markup of a list of sibling nodes. `parent` is their parent node, `offset` the index of the first. */
  children(nodes: TemplateNode[], parent: Ref, env: Env, offset = 0): string {
    return normalize(nodes, env.preserve)
      .map((item, index) => this.item(item, { parent, index: index + offset, hint: hintOf(item) }, env))
      .join('');
  }

  item(item: Item, ref: Ref, env: Env): string {
    if (item.type === 'Element') return emitElement(this, item, ref, env);
    if (item.type !== 'Run') {
      emitAnchored(this, item, ref, env);
      return '<!>';
    }
    if (item.parts.every((part) => typeof part === 'string')) return escapeHtml(item.parts.join(''));
    const { context } = this;
    this.operations.push(js`${context.helper('$text')}(${this.use(ref)}, ${context.textGetter(env.bindings, item.parts)});\n`);
    // A single space keeps a text node at this position in the parsed template.
    return ' ';
  }

  /** `const` declarations for every node in use, each reached from its parent or a sibling. */
  declarations(create: string): Code {
    const ordered = [...this.declared].sort((a, b) => compare(path(a), path(b)));
    const lastChild = new Map<Ref, Ref>();
    return ordered.flatMap((ref) => {
      const { parent } = ref;
      if (!parent) return js`const ${ref.name} = ${create}();\n`;
      const previous = lastChild.get(parent);
      lastChild.set(parent, ref);
      const from = previous ? previous.name : `${parent.name}.firstChild`;
      const steps = previous ? ref.index - previous.index : ref.index;
      return js`const ${ref.name} = ${from}${'.nextSibling'.repeat(steps)};\n`;
    });
  }
}

function path(ref: Ref): number[] {
  return ref.parent ? [...path(ref.parent), ref.index] : [];
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < a.length && index < b.length; index++) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  }
  return a.length - b.length;
}

function hintOf(item: Item): string {
  if (item.type === 'Run') return 'text';
  if (item.type !== 'Element') return 'anchor';
  return item.name.replace(/[^A-Za-z0-9_$]/g, '_');
}

/**
 * The statements of a function that creates the nodes of `nodes` and returns them: one node, or a
 * fragment. Returns null when there is nothing to render.
 */
export function generateFragment(context: Context, nodes: TemplateNode[], env: Env): Code | null {
  const items = normalize(nodes, env.preserve);
  const only = items[0];
  if (!only) return null;
  // A component is the whole content: its nodes are the result, no wrapper needed.
  if (items.length === 1 && only.type === 'Component') return js`return ${componentCall(context, only, env)};\n`;

  const elements = items.filter((item) => item.type === 'Element');
  const svg = env.svg || (elements.length > 0 && elements.every((item) => item.type === 'Element' && SVG_ONLY.has(item.name)));
  const inner: Env = { ...env, svg };

  // Blocks insert their content before their anchor. A fragment that starts with one gets a
  // marker in front, so that its first node stays its first node.
  const marker = only.type !== 'Element' && only.type !== 'Run';
  const single = items.length === 1 && !marker;

  const fragment = new Fragment(context, inner);
  const root: Ref = { parent: null, index: 0, hint: single ? hintOf(only) : 'fragment' };
  const html = single
    ? fragment.item(only, root, inner)
    : (marker ? '<!>' : '') + items.map((item, index) => fragment.item(item, { parent: root, index: index + (marker ? 1 : 0), hint: hintOf(item) }, inner)).join('');

  const name = fragment.use(root);
  const template = context.template(html, (single ? 0 : 1) | (svg ? 2 : 0));
  return [...fragment.declarations(template), ...fragment.operations.flat(), ...js`return ${name};\n`];
}

/** `(params) => { ... }` around a fragment, or null when the fragment is empty. */
export function renderFunction(context: Context, nodes: TemplateNode[], env: Env, params: string[] = []): Code | null {
  const body = generateFragment(context, nodes, env);
  return body && js`(${params.join(', ')}) => {\n${indent(body)}}`;
}
