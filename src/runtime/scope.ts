import { batch, effect as rawEffect, untracked } from '@preact/signals-core';

export type Cleanup = () => void;

/**
 * Everything one piece of mounted template owns: a component root, an `{#if}` branch, one row of
 * an `{#each}`. Disposing it stops its effects and runs its cleanups.
 */
export interface Scope {
  cleanups: Set<Cleanup>;
  /** Leave transitions of the nodes created directly in this scope. */
  leaving?: (() => Promise<unknown>)[];
  disposed?: boolean;
}

let current: Scope | null = null;

/**
 * Owner for runtime calls made outside setup, typically after an `await` in a handler: the screen
 * opened last. Without it a looping sound started there would outlive its screen.
 */
let fallback: Scope | null = null;

let mounts: Cleanup[] = [];
let depth = 0;

export const noop = (): void => {};

export function createScope(): Scope {
  return { cleanups: new Set() };
}

export function currentScope(): Scope | null {
  return current;
}

export function setFallbackScope(scope: Scope | null): void {
  fallback = scope;
}

/** Runs `fn` with `scope` as the owner of whatever it creates, without tracking signal reads. */
export function runIn<T>(scope: Scope | null, fn: () => T): T {
  const previous = current;
  current = scope;
  try {
    return untracked(fn);
  } finally {
    current = previous;
  }
}

/**
 * Calls a user callback (event handler, key handler, push handler) as its component would have:
 * owned by the component's scope, and with signal writes batched so effects see the final state.
 */
export function invoke<A>(scope: Scope | null, fn: (argument: A) => unknown, argument: A): void {
  if (scope && scope.disposed) return;
  runIn(scope, () => batch(() => fn(argument)));
}

/**
 * Registers `fn` to run when the current scope is disposed. The returned function runs it now
 * instead, which is what an unsubscribe or a stop function wants.
 */
export function own(fn: Cleanup): Cleanup {
  const scope = current || fallback;
  if (!scope) return fn;
  scope.cleanups.add(fn);
  return () => {
    scope.cleanups.delete(fn);
    fn();
  };
}

export function dispose(scope: Scope): void {
  if (scope.disposed) return;
  scope.disposed = true;
  for (const cleanup of scope.cleanups) {
    try {
      cleanup();
    } catch (error) {
      // One failing cleanup must not keep the rest of the screen alive.
      reportError(error);
    }
  }
  scope.cleanups.clear();
}

/** An effect that belongs to the current scope. This is what every compiled binding uses. */
export function bind(fn: () => unknown): void {
  own(rawEffect(fn as () => void));
}

/**
 * Runs `fn`, which creates and inserts nodes, and then the `onMount` callbacks queued meanwhile.
 * Nested calls wait for the outermost one, so a callback never sees a detached node.
 */
export function commit<T>(fn: () => T): T {
  depth++;
  let done = false;
  try {
    const result = fn();
    done = true;
    return result;
  } finally {
    if (!--depth) {
      const queue = mounts;
      mounts = [];
      if (done) for (const mounted of queue) mounted();
    }
  }
}

export function afterInsert(fn: Cleanup): void {
  const scope = current;
  mounts.push(() => {
    if (!scope || !scope.disposed) runIn(scope, fn);
  });
}

/**
 * Runs `fn` once the component's nodes are in the document.
 *
 * @example
 * onMount(() => input.value?.focus());
 */
export function onMount(fn: () => void): void {
  if (depth) afterInsert(fn);
  else fn();
}

/**
 * Runs `fn` when the component is removed. Also works inside `onMount` and event handlers.
 *
 * @example
 * const timer = setInterval(tick, 1000);
 * onCleanup(() => clearInterval(timer));
 */
export function onCleanup(fn: () => void): void {
  own(fn);
}

/**
 * Like the `effect` of the signals library, but stopped with the component that created it.
 * Returning a function from `fn` registers a cleanup that runs before the next run.
 */
export function effect(fn: () => unknown): Cleanup {
  return own(rawEffect(fn as () => void));
}
