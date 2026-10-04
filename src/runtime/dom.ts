import { Signal, untracked } from '@preact/signals-core';
import { afterInsert, bind, currentScope, invoke, own } from './scope';

type Getter<T = unknown> = () => T;

/** The value of a signal, or the value itself: how the template reads `{count}`. */
export function $get<T>(value: T | Signal<T>): T {
  return value instanceof Signal ? value.value : value;
}

/**
 * Parses `html` once and returns a function that clones it. Bit 1 of `flags` asks for the whole
 * fragment instead of its only node, bit 2 parses the markup as SVG.
 */
export function $template(html: string, flags = 0): () => Node {
  let source: Node | undefined;
  return () => {
    if (!source) {
      const template = document.createElement('template');
      template.innerHTML = flags & 2 ? `<svg>${html}</svg>` : html;
      let content: Node = template.content;
      if (flags & 2) {
        // Children parsed outside an <svg> would be HTML elements that never render.
        const svg = content.firstChild as Element;
        content = document.createDocumentFragment();
        (content as DocumentFragment).append(...svg.childNodes);
      }
      source = flags & 1 ? content : (content.firstChild as Node);
    }
    return source.cloneNode(true);
  };
}

export function $text(node: Text, value: Getter): void {
  bind(() => {
    const next = value();
    node.data = next == null ? '' : (next as string);
  });
}

// These reflect user input, so the attribute alone would not update what the control shows.
const PROPERTIES = /^(value|checked|selected|muted)$/;

function setAttribute(node: Element, name: string, value: unknown): void {
  if (PROPERTIES.test(name) && name in node) {
    const target = node as unknown as Record<string, unknown>;
    if (target[name] !== value) target[name] = value ?? '';
  } else if (value == null || value === false) {
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value === true ? '' : (value as string));
  }
}

export function $attr(node: Element, name: string, value: Getter): void {
  bind(() => setAttribute(node, name, value()));
}

export function $spread(node: Element, value: Getter<Record<string, unknown> | null | undefined>): void {
  let previous: Record<string, unknown> = {};
  bind(() => {
    const next = value() || {};
    for (const name in previous) if (!(name in next)) setAttribute(node, name, null);
    for (const name in next) setAttribute(node, name, next[name]);
    previous = next;
  });
}

/**
 * A dynamic `class` attribute. It only adds and removes its own names, so `class:` directives
 * and transition classes on the same element survive an update.
 */
export function $class(node: Element, value: Getter): void {
  let previous: string[] = [];
  bind(() => {
    const next = value();
    node.classList.remove(...previous);
    previous = next ? String(next).split(/\s+/).filter(Boolean) : [];
    node.classList.add(...previous);
  });
}

export function $toggle(node: Element, name: string, value: Getter): void {
  bind(() => node.classList.toggle(name, !!value()));
}

export function $style(node: HTMLElement | SVGElement, property: string, value: Getter): void {
  bind(() => {
    const next = value();
    if (next == null || next === false) node.style.removeProperty(property);
    else node.style.setProperty(property, next as string);
  });
}

/** Bits of `flags`: 1 prevent, 2 stop, 4 self, 8 once, 16 capture. */
export function $on(node: EventTarget, type: string, handler: (event: Event) => unknown, flags = 0): void {
  const scope = currentScope();
  node.addEventListener(
    type,
    (event) => {
      if (flags & 4 && event.target !== node) return;
      if (flags & 1) event.preventDefault();
      if (flags & 2) event.stopPropagation();
      invoke(scope, handler, event);
    },
    { once: !!(flags & 8), capture: !!(flags & 16) },
  );
}

/**
 * Two-way binding for form controls. `kind` is 0 for `bind:value`, 1 for `bind:checked` and 2
 * for `bind:group`. The target is a signal, or a property (of a store) written through `set`.
 */
export function $bind(node: HTMLInputElement, kind: number, get: Getter, set?: (value: unknown) => void, where?: string): void {
  const read = (): unknown => $get(get());
  const numeric = node.type === 'number' || node.type === 'range';
  const multiple = node.type === 'checkbox';

  /** What the control says the value is now. */
  const taken = (): unknown => {
    const { value } = node;
    if (!kind) return numeric ? (value === '' ? null : +value) : value;
    if (kind === 1) return node.checked;
    if (!multiple) return value;
    const group = untracked(read) as unknown[];
    return node.checked ? [...group, value] : group.filter((entry) => entry !== value);
  };

  bind(() => {
    const next = read();
    if (kind) node.checked = kind === 1 ? !!next : multiple ? (next as unknown[]).includes(node.value) : next == node.value;
    // Loose on purpose: writing "1" over a typed "1.0" would move the caret.
    else if (node.value != (next ?? '')) node.value = (next ?? '') as string;
  });

  $on(node, kind || node.tagName === 'SELECT' ? 'change' : 'input', () => {
    const target = untracked(get);
    if (target instanceof Signal) target.value = taken();
    else if (set) set(taken());
    else if (globalThis.__NEXUS_DEV__) throw new Error(`[nexus] bind: needs a signal or a store property (${where})`);
  });
}

export function $ref(node: Element, target: Signal<Element | null>): void {
  target.value = node;
  own(() => {
    if (target.peek() === node) target.value = null;
  });
}

/** Runs an action once the node is in the document, and again when its argument changes. */
export function $use(
  node: Element,
  action: (node: Element, argument: unknown) => void | (() => void),
  argument?: Getter,
): void {
  afterInsert(() =>
    bind(() => {
      const value = argument && argument();
      return untracked(() => action(node, value));
    }),
  );
}

type Source = Record<string, unknown> | Getter<Record<string, unknown> | null | undefined>;

/**
 * The props of a component that uses `{...spread}`: later sources win, and every read goes to
 * the source at that moment, so the result stays reactive.
 */
export function $props(...sources: Source[]): Record<string, unknown> {
  const resolve = (source: Source): Record<string, unknown> => (typeof source === 'function' ? source() : source) || {};
  const find = (key: string | symbol): Record<string, unknown> | undefined => {
    for (let index = sources.length; index--; ) {
      const candidate = resolve(sources[index] as Source);
      if (key in candidate) return candidate;
    }
    return undefined;
  };
  return new Proxy(
    {},
    {
      get: (_, key) => find(key)?.[key as string],
      has: (_, key) => !!find(key),
      ownKeys: () => [...new Set(sources.flatMap((source) => Reflect.ownKeys(resolve(source))))],
      getOwnPropertyDescriptor: (_, key) => {
        const owner = find(key);
        return owner && { configurable: true, enumerable: true, value: owner[key as string] };
      },
    },
  );
}

/** Adds a component's styles to the document once. Used when the compiler is not given a bundler. */
export function $css(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}
