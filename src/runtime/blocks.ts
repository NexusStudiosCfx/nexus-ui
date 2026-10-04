import { signal, untracked, type Signal } from '@preact/signals-core';
import { afterInsert, bind, commit, createScope, currentScope, dispose, noop, own, runIn, type Scope } from './scope';

type Render = () => Node;

/**
 * A rendered piece of template and the range of nodes it occupies. The compiler guarantees that
 * the first and last node of a fragment never move, so the range stays valid while blocks inside
 * it add and remove nodes.
 */
interface Branch {
  scope: Scope;
  first: Node | null;
  last: Node | null;
}

function create(render: Render, parent: Node, before: Node | null): Branch {
  const scope = createScope();
  let node: Node;
  try {
    node = runIn(scope, render);
  } catch (error) {
    // What was set up before the failure must not stay alive without nodes.
    dispose(scope);
    throw error;
  }
  const fragment = node.nodeType === 11;
  const branch: Branch = { scope, first: fragment ? node.firstChild : node, last: fragment ? node.lastChild : node };
  parent.insertBefore(node, before);
  return branch;
}

function eachNode(branch: Branch, visit: (node: Node) => void): void {
  for (let node = branch.first; node; ) {
    const next = node === branch.last ? null : node.nextSibling;
    visit(node);
    node = next;
  }
}

/**
 * Stops a branch at once and removes its nodes after its leave transitions. The content is
 * frozen while it animates out: its bindings no longer run against state that may be gone.
 */
function destroy(branch: Branch, done: () => void = noop): void {
  const leaving = branch.scope.leaving;
  dispose(branch.scope);
  const remove = (): void => {
    eachNode(branch, (node) => (node as ChildNode).remove());
    done();
  };
  if (leaving) Promise.all(leaving.map((leave) => leave())).then(remove);
  else remove();
}

/**
 * A block's effect. `update` reads the signals and returns the structural change to make, if
 * any; that change runs untracked, and `onMount` callbacks run after its nodes are inserted.
 */
function block(update: () => (() => void) | void): void {
  bind(() => {
    const change = update();
    if (change) commit(() => untracked(change));
  });
}

/** Renders into `target`; the returned function removes the nodes and then calls `done`. */
export function attach(render: Render, target: Node, done?: () => void): () => void {
  const branch = commit(() => create(render, target, null));
  return () => destroy(branch, done);
}

/**
 * Renders `component` into `target` and returns a function that removes it again.
 *
 * @example
 * const unmount = mount(App, document.body, { title: 'Garage' });
 */
export function mount<P>(component: (props: P) => Node, target: Element, props?: P): () => void {
  return attach(() => component(props || ({} as P)), target);
}

/**
 * Shows the branch that `test` selects, and replaces it only when the selection changes.
 * `branches` is a list to pick from, or one function that renders every selection.
 */
export function $if(anchor: Node, test: () => number, branches: (Render | null)[] | Render): void {
  let index = -1;
  let branch: Branch | undefined;
  block(() => {
    const next = test();
    if (next === index) return;
    index = next;
    return () => {
      if (branch) destroy(branch);
      const render = typeof branches === 'function' ? branches : branches[next];
      branch = render ? create(render, anchor.parentNode as Node, anchor) : undefined;
    };
  });
  own(() => branch && dispose(branch.scope));
}

export function $key(anchor: Node, value: () => unknown, render: Render): void {
  let previous: unknown;
  let version = 0;
  // Every new value selects a new branch, which is what creates the content again.
  $if(
    anchor,
    () => {
      const next = value();
      if (!version || !Object.is(next, previous)) version++;
      previous = next;
      return version;
    },
    render,
  );
}

interface Row extends Branch {
  item: Signal<unknown>;
  index: Signal<number>;
  /** Position in the previous render, or -1 for a row that was just created. */
  at: number;
}

/**
 * The positions of a longest increasing run in `values`, ignoring negative entries. Rows at
 * these positions keep their place, so a reorder moves as few nodes as possible.
 */
function longestRun(values: number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = [];
  values.forEach((value, position) => {
    if (value < 0) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] as number] as number) < value) low = middle + 1;
      else high = middle;
    }
    previous[position] = low ? (tails[low - 1] as number) : -1;
    tails[low] = position;
  });
  const keep = new Set<number>();
  for (let position = tails.length ? (tails[tails.length - 1] as number) : -1; position >= 0; ) {
    keep.add(position);
    position = previous[position] as number;
  }
  return keep;
}

export function $each<T>(
  anchor: Node,
  list: () => Iterable<T> | null | undefined,
  key: ((item: T, index: number) => unknown) | null,
  render: (item: Signal<T>, index: Signal<number>) => Node,
  fallback?: Render | null,
  where?: string,
): void {
  let rows = new Map<unknown, Row>();
  let empty: Branch | undefined;

  block(() => {
    const items = [...(list() || [])];
    return () => {
      const parent = anchor.parentNode as Node;
      const next = new Map<unknown, Row>();
      const order = items.map((item, index) => {
        // Without a key the position is the key: rows stay in place and only their item changes.
        const id = key ? key(item, index) : index;
        if (next.has(id)) {
          throw new Error(`[nexus] duplicate {#each} key ${String(id)} ${where || ''}`);
        }
        let row = rows.get(id);
        if (row) {
          rows.delete(id);
          row.item.value = item;
          row.index.value = index;
        } else {
          const itemSignal = signal<unknown>(item);
          const indexSignal = signal(index);
          const branch = create(() => render(itemSignal as Signal<T>, indexSignal), parent, anchor);
          row = { ...branch, item: itemSignal, index: indexSignal, at: -1 };
        }
        next.set(id, row);
        return row;
      });

      rows.forEach((row) => destroy(row));
      rows = next;

      const settled = longestRun(order.map((row) => row.at));
      let before: Node = anchor;
      for (let position = order.length; position--; ) {
        const row = order[position] as Row;
        if (!settled.has(position) && row.last && row.last.nextSibling !== before) {
          eachNode(row, (node) => parent.insertBefore(node, before));
        }
        row.at = position;
        before = row.first || before;
      }

      if (fallback && !items.length && !empty) {
        empty = create(fallback, parent, anchor);
      } else if (empty && items.length) {
        destroy(empty);
        empty = undefined;
      }
    };
  });

  own(() => {
    rows.forEach((row) => dispose(row.scope));
    if (empty) dispose(empty.scope);
  });
}

/** Raw HTML. Never give it text typed by a player: it is parsed as markup. */
export function $html(anchor: Node, value: () => unknown): void {
  let nodes: ChildNode[] = [];
  bind(() => {
    const next = value();
    for (const node of nodes) node.remove();
    const template = document.createElement('template');
    template.innerHTML = next == null ? '' : (next as string);
    nodes = [...template.content.childNodes];
    (anchor as ChildNode).before(template.content);
  });
}

type Slots = Record<string, Render | undefined>;

export function $slot(anchor: Node, props: { $slots?: Slots }, name: string, fallback?: Render): void {
  const render = (props.$slots && props.$slots[name]) || fallback;
  if (render) (anchor as ChildNode).before(render());
}

const settle = (node: Element, known: Animation[]): Promise<unknown> =>
  Promise.all(
    node
      .getAnimations()
      // An endless animation (a spinner) would otherwise keep the node in the document forever.
      .filter((animation) => !known.includes(animation) && animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(noop)),
  );

/**
 * `transition:name`. The enter class is on the node before it is inserted and comes off when the
 * animation it started ends; with no animation it comes off at once, which starts a CSS
 * transition from the enter styles. The leave class stays until the node is removed.
 */
export function $transition(node: Element, name: string): void {
  const scope = currentScope() as Scope;
  const enter = `${name}-enter`;
  node.classList.add(enter);
  // Reading the animations also flushes style, so the enter styles count as the starting point.
  afterInsert(() => void settle(node, []).then(() => node.classList.remove(enter)));
  (scope.leaving ||= []).push(() => {
    const known = node.getAnimations();
    node.classList.add(`${name}-leave`);
    return settle(node, known);
  });
}
