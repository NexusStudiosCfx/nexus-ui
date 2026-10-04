import { batch, signal, type Signal } from '@preact/signals-core';

const RAW = Symbol();

const proxies = new WeakMap<object, object>();

type Target = Record<PropertyKey, unknown>;

function wrappable(value: unknown): value is object {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || prototype === Array.prototype;
}

/** The object behind a store, so a store assigned into another store is not wrapped twice. */
function raw<T>(value: T): T {
  return ((wrappable(value) && (value as Target)[RAW]) || value) as T;
}

/**
 * Makes an object reactive, one property at a time: an effect that reads `state.health` runs
 * again only when `health` changes. Nested plain objects and arrays are wrapped when they are
 * read. Other values (dates, maps, class instances) are stored as they are.
 *
 * @example
 * const form = store({ name: '', tags: [] as string[] });
 * form.tags.push('new');
 */
export function store<T extends object>(target: T): T {
  target = raw(target);
  const known = proxies.get(target);
  if (known) return known as T;

  const signals = new Map<PropertyKey, Signal<unknown>>();
  // Bumped when a key appears or disappears, for effects that list the keys.
  const shape = signal(0);

  const proxy = new Proxy(target as Target, {
    get(object, key, receiver) {
      if (key === RAW) return object;
      const value = Reflect.get(object, key, receiver);
      if (typeof key === 'symbol') return value;
      if (typeof value === 'function') {
        // Array methods write several properties; effects should see only the result.
        return Array.isArray(object) ? (...args: unknown[]) => batch(() => value.apply(receiver, args)) : value;
      }
      let entry = signals.get(key);
      if (!entry) signals.set(key, (entry = signal(value)));
      entry.value;
      return wrappable(value) ? store(value) : value;
    },
    set(object, key, value, receiver) {
      value = raw(value);
      const added = !(key in object);
      const done = Reflect.set(object, key, value, receiver);
      batch(() => {
        const entry = signals.get(key);
        if (entry) entry.value = value;
        if (added) shape.value++;
        if (key === 'length' && Array.isArray(object)) {
          // Shortening an array drops entries without a trap being called for them.
          signals.forEach((entry, index) => {
            if (index !== 'length' && +(index as string) >= (value as number)) entry.value = undefined;
          });
        }
      });
      return done;
    },
    deleteProperty(object, key) {
      const done = Reflect.deleteProperty(object, key);
      batch(() => {
        const entry = signals.get(key);
        if (entry) entry.value = undefined;
        shape.value++;
      });
      return done;
    },
    has(object, key) {
      shape.value;
      return key in object;
    },
    ownKeys(object) {
      shape.value;
      return Reflect.ownKeys(object);
    },
  });

  proxies.set(target, proxy);
  return proxy as T;
}

/** Makes `state` equal to `next` (or, with `merge`, only assigns the keys of `next`). */
export function patch(state: object, next: Record<string, unknown>, merge?: boolean): void {
  const target = state as Record<string, unknown>;
  batch(() => {
    if (!merge) for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
    for (const key in next) target[key] = next[key];
  });
}

const refuse = (): boolean => false;

/** A view of a store that throws on writes. Component props are handed out through it. */
export function readonly<T extends object>(state: T): T {
  return new Proxy(state, { set: refuse, deleteProperty: refuse });
}
