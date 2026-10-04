import type { Attribute, AttributeNode, Component, ExpressionTag, Root, Span, TemplateNode, Text } from '../../compiler/ast';

/** A run of generated code that stands for a place in the `.nexus` file. */
export interface Mapping {
  generated: number;
  source: number;
  length: number;
}

export interface VirtualFile {
  /** TypeScript that stands for the component. It is only ever type-checked, never run. */
  code: string;
  /** Sorted by `generated`. */
  mappings: Mapping[];
}

/**
 * Declarations every stand-in relies on. They are global on purpose: a stand-in must not gain
 * an import the component did not write.
 *
 * A signal handed to the template is read for its value, in a block as well as in a prop, so
 * both the list of an `{#each}` and the value of a prop accept a signal of the expected type.
 */
export const HELPERS = `type __NexusValue<T> = T extends { readonly value: infer V; peek(): unknown } ? V : T;
type __NexusItem<T> = __NexusValue<T> extends Iterable<infer I> ? I : never;
type NexusProps<P> = { [K in keyof P]: P[K] | { readonly value: P[K]; peek(): unknown } };
type __NexusElement<T extends string> = T extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[T]
  : T extends keyof SVGElementTagNameMap
    ? SVGElementTagNameMap[T]
    : HTMLElement;
type __NexusEvent<E extends string> = E extends keyof HTMLElementEventMap ? HTMLElementEventMap[E] : Event;
declare function __nexusEach<T>(list: T): Iterable<__NexusItem<T>>;
declare function __nexusOn<T extends string, E extends string>(
  tag: T,
  event: E,
  handler: ((event: __NexusEvent<E> & { readonly currentTarget: __NexusElement<T> }) => unknown) | null | undefined,
): void;
declare function __nexusUse<P>(component: (props: P) => unknown): (props: NexusProps<P>) => void;
`;

export interface StandInOptions {
  /** The name of the screen, when the file is one whose props `web/contract.ts` declares. */
  screen?: string;
}

/**
 * Rewrites a parsed component as TypeScript for the type checker: the script as written, then
 * every template expression inside a function, with blocks turned into the control flow they
 * stand for so that names, narrowing and loop variables behave as they do in the component.
 */
export function toTypeScript(root: Root, source: string, options: StandInOptions = {}): VirtualFile {
  const mappings: Mapping[] = [];
  let code = '';

  const raw = (text: string): void => {
    code += text;
  };
  const copy = (span: Span): void => {
    mappings.push({ generated: code.length, source: span.start, length: span.end - span.start });
    code += source.slice(span.start, span.end);
  };
  /** Glue code that a problem should be reported at `at` for, having no text of its own in the file. */
  const anchored = (text: string, at: number): void => {
    mappings.push({ generated: code.length, source: at, length: text.length });
    code += text;
  };
  const expression = (span: Span): void => {
    raw('(');
    copy(span);
    // The line break keeps a trailing line comment in the expression from swallowing the `)`.
    raw('\n)');
  };
  const statement = (span: Span): void => {
    expression(span);
    raw(';\n');
  };

  /** `tag` is the element the directives are on. A component has none that TypeScript knows. */
  const directives = (nodes: AttributeNode[], tag?: string): void => {
    for (const node of nodes) {
      if (node.type !== 'Directive') continue;
      if (node.kind === 'use') statement(node.nameSpan);
      const only = node.value?.length === 1 ? node.value[0] : undefined;
      if (node.kind === 'on' && tag !== undefined && only?.type === 'ExpressionTag') {
        // Passing the handler to a typed function is what gives the parameter of an inline
        // handler its type: the event of that name, on that element.
        raw(`__nexusOn(${JSON.stringify(tag)}, ${JSON.stringify(node.name)}, `);
        expression(only.expression);
        raw(');\n');
        continue;
      }
      for (const part of node.value ?? []) {
        if (part.type === 'ExpressionTag') statement(part.expression);
      }
    }
  };

  /** The attributes of an element: every expression is checked on its own. */
  const attributes = (nodes: AttributeNode[], tag?: string): void => {
    for (const node of nodes) {
      if (node.type === 'Spread') statement(node.expression);
      else if (node.type === 'Attribute' && node.value !== true) {
        for (const part of node.value) {
          if (part.type === 'ExpressionTag') statement(part.expression);
        }
      }
    }
    directives(nodes, tag);
  };

  /** The value of an attribute as one expression: what the component receives for that prop. */
  const value = (parts: true | (Text | ExpressionTag)[]): void => {
    if (parts === true) return raw('true');
    const only = parts.length === 1 ? parts[0] : undefined;
    if (only?.type === 'ExpressionTag') return expression(only.expression);
    raw('`');
    for (const part of parts) {
      if (part.type === 'Text') raw(part.data.replace(/[`\\]|\$\{/g, '\\$&'));
      else {
        raw('${');
        expression(part.expression);
        raw('}');
      }
    }
    raw('`');
  };

  /**
   * The attributes of a component are its props, so they are checked together against what the
   * component declares. With a spread the full set is not known here, and each is checked alone.
   */
  const component = (node: Component): void => {
    const name = { start: node.start + 1, end: node.start + 1 + node.name.length };
    const props = node.attributes.filter((attribute): attribute is Attribute => attribute.type === 'Attribute' && attribute.name !== 'slot');
    if (node.attributes.some((attribute) => attribute.type === 'Spread')) {
      statement(name);
      attributes(node.attributes);
      return;
    }
    raw('__nexusUse(');
    copy(name);
    raw(')(');
    // A missing prop is reported on this brace, which has to point at the tag.
    anchored('{', name.start);
    raw('\n');
    for (const attribute of props) {
      // `{name}` is short for `name={name}`: the attribute starts at the brace, not at the name.
      const shorthand = source[attribute.start] === '{';
      const key = shorthand ? attribute.start + 1 : attribute.start;
      // A value of the wrong type is reported on the opening quote of the key.
      anchored("'", key);
      copy({ start: key, end: key + attribute.name.length });
      raw("': ");
      value(attribute.value);
      raw(',\n');
    }
    raw('});\n');
    directives(node.attributes);
  };

  const nodes = (children: TemplateNode[]): void => {
    for (const node of children) {
      switch (node.type) {
        case 'Text':
          break;
        case 'ExpressionTag':
        case 'HtmlTag':
          statement(node.expression);
          break;
        case 'Component':
          component(node);
          nodes(node.children);
          break;
        case 'Element':
          attributes(node.attributes, node.name);
          nodes(node.children);
          break;
        case 'Slot':
          attributes(node.attributes);
          nodes(node.children);
          break;
        case 'IfBlock':
          node.branches.forEach((branch, index) => {
            if (index > 0) raw('else ');
            if (branch.test) {
              raw('if ');
              expression(branch.test);
              raw(' ');
            }
            raw('{\n');
            nodes(branch.children);
            raw('}\n');
          });
          break;
        case 'EachBlock':
          raw('for (const ');
          copy(node.item);
          raw(' of __nexusEach');
          expression(node.expression);
          raw(') {\n');
          if (node.index) {
            raw('const ');
            copy(node.index);
            raw(': number = 0;\n');
          }
          if (node.key) statement(node.key);
          nodes(node.children);
          raw('}\n');
          if (node.fallback) {
            raw('{\n');
            nodes(node.fallback);
            raw('}\n');
          }
          break;
        case 'KeyBlock':
          statement(node.expression);
          raw('{\n');
          nodes(node.children);
          raw('}\n');
          break;
      }
    }
  };

  const script = root.script?.content;
  const own = script ? /\b(?:interface|type)\s+(Props)\b/.exec(script.code) : null;
  // What the contract says this screen is opened with, when it says so.
  const declared = options.screen === undefined ? null : `import('nexus').ScreenProps<${JSON.stringify(options.screen)}>`;
  const propsType = own ? 'Props' : (declared ?? 'Record<string, any>');
  if (script) {
    copy(script);
    raw('\n');
  }
  if (script && own && declared) {
    // A screen may still write its own Props. They must then accept what the contract
    // promises, and a mismatch is reported where Props is declared.
    raw('const ');
    anchored('__nexusContractProps', script.start + own.index + own[0].length - 'Props'.length);
    raw(`: Props = undefined as unknown as ${declared};\n`);
  }
  raw(`declare const props: Readonly<${propsType}>;\n`);
  raw('function __nexusTemplate() {\n');
  nodes(root.children);
  raw('}\n');
  raw(`declare const __nexusComponent: (props: ${propsType}) => Node;\nexport default __nexusComponent;\n`);

  return { code, mappings };
}

/** The offset in the `.nexus` file that a generated offset stands for, or null for glue code. */
export function toSource(file: VirtualFile, generated: number): number | null {
  for (const mapping of file.mappings) {
    if (generated >= mapping.generated && generated < mapping.generated + mapping.length) {
      return mapping.source + (generated - mapping.generated);
    }
  }
  return null;
}

/**
 * Where to report a problem that sits in glue code: at the last piece of the component that
 * was written before it, which is the expression the glue was generated for.
 */
export function nearestSource(file: VirtualFile, generated: number): number {
  let nearest = 0;
  for (const mapping of file.mappings) {
    if (mapping.generated > generated) break;
    nearest = mapping.source;
  }
  return nearest;
}
