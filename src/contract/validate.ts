import { messages, UNKNOWN_KEY_MAX_BYTES } from './messages';
import type { Pattern } from './pattern';
import { LIMITS, nodeOf, type Schema, type SchemaNode } from './schema';

export type Validation = { readonly ok: true } | { readonly ok: false; readonly error: string };

type Table = Record<string, unknown> | readonly unknown[];
type Key = string | number;

const regexes = new WeakMap<Pattern, RegExp>();

function regexFor(pattern: Pattern): RegExp {
  let regex = regexes.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern.source);
    regexes.set(pattern, regex);
  }
  return regex;
}

/**
 * Counts characters the way Lua's `utf8.len` does: by code point. Returns -1 for a string with a
 * lone surrogate, which has no valid UTF-8 form and so can never reach Lua intact.
 */
function characters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return -1;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return -1;
    }
    count++;
  }
  return count;
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/*
 * Everything below reads a JavaScript value the way Lua will see it after the trip through JSON,
 * because that is the value the server actually validates:
 *   - null and undefined do not exist in a Lua table, so a key or item holding one is absent;
 *   - an array and an object are both tables, told apart only by their keys, so an empty one of
 *     either kind is acceptable as the other.
 */

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null;
}

function keysOf(table: Table): Key[] {
  const keys: Key[] = [];
  if (Array.isArray(table)) {
    for (let i = 0; i < table.length; i++) {
      if (present(table[i])) keys.push(i + 1);
    }
  } else {
    const object = table as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (present(object[key])) keys.push(key);
    }
  }
  return keys;
}

function valueAt(table: Table, key: Key): unknown {
  if (Array.isArray(table)) return typeof key === 'number' ? table[key - 1] : undefined;
  if (typeof key === 'number') return undefined;
  return Object.prototype.hasOwnProperty.call(table, key) ? (table as Record<string, unknown>)[key] : undefined;
}

/**
 * What is left of `budget` after the size of a JSON value is taken from it, or a negative number
 * when the value is too large, nests deeper than `depth` allows, or is not JSON data as Lua
 * would receive it. The generated Lua counts in exactly the same way.
 */
function jsonSize(value: unknown, depth: number, budget: number): number {
  if (typeof value === 'string') return characters(value) < 0 ? -1 : budget - utf8Bytes(value) - 2;
  if (typeof value === 'number') return Number.isFinite(value) ? budget - 8 : -1;
  if (typeof value === 'boolean') return budget - 4;
  if (!isTable(value) || depth < 1) return -1;

  const keys = keysOf(value);
  let left = budget - 2;
  // A table is a list when it has an item at 1, as it is for Lua.
  const list = keys.length === 0 || present(valueAt(value, 1));
  for (let index = 0; index < keys.length && left >= 0; index++) {
    const key = list ? index + 1 : (keys[index] as Key);
    if (!list) {
      if (typeof key !== 'string' || characters(key) < 0) return -1;
      left -= utf8Bytes(key) + 2;
    }
    const item = valueAt(value, key);
    if (!present(item)) return -1;
    // Every entry costs at least its separator, so a budget also bounds how many there can be.
    left = jsonSize(item, depth - 1, left - 1);
  }
  return left;
}

function fail(path: string, message: string): string {
  return path === '' ? message : `${path}: ${message}`;
}

function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function check(node: SchemaNode, value: unknown, path: string): string | null {
  switch (node.kind) {
    case 'string': {
      if (typeof value !== 'string') return fail(path, messages.string);
      const length = characters(value);
      if (length < 0) return fail(path, messages.malformed);
      if (length > node.max) return fail(path, messages.maxChars(node.max));
      if (length < node.min) return fail(path, messages.minChars(node.min));
      if (node.pattern && !regexFor(node.pattern).test(value)) return fail(path, messages.pattern(node.pattern.source));
      return null;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(path, messages.int);
      if (value < node.min) return fail(path, messages.atLeast(node.min));
      if (value > node.max) return fail(path, messages.atMost(node.max));
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, messages.number);
      if (node.min !== null && value < node.min) return fail(path, messages.atLeast(node.min));
      if (node.max !== null && value > node.max) return fail(path, messages.atMost(node.max));
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : fail(path, messages.boolean);
    case 'enum':
      return typeof value === 'string' && node.values.includes(value) ? null : fail(path, messages.oneOf(node.values));
    case 'literal':
      return value === node.value ? null : fail(path, messages.literal(node.value));
    case 'array': {
      if (!isTable(value)) return fail(path, messages.array);
      const count = keysOf(value).length;
      if (count > node.max) return fail(path, messages.maxItems(node.max));
      if (count < node.min) return fail(path, messages.minItems(node.min));
      for (let index = 1; index <= count; index++) {
        const error = check(node.item, valueAt(value, index), `${path}[${index}]`);
        if (error) return error;
      }
      return null;
    }
    case 'object': {
      if (!isTable(value) || present(valueAt(value, 1))) return fail(path, messages.object);
      for (const key of keysOf(value)) {
        if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(node.fields, key)) continue;
        const named = typeof key === 'string' && utf8Bytes(key) <= UNKNOWN_KEY_MAX_BYTES;
        return fail(path, named ? `${messages.unknownKey} "${key}"` : messages.unknownKey);
      }
      for (const key of Object.keys(node.fields)) {
        const error = check(node.fields[key] as SchemaNode, valueAt(value, key), child(path, key));
        if (error) return error;
      }
      return null;
    }
    case 'record': {
      if (!isTable(value)) return fail(path, messages.object);
      const keys = keysOf(value);
      if (keys.length > node.max) return fail(path, messages.maxEntries(node.max));
      for (const key of keys) {
        const length = typeof key === 'string' ? characters(key) : -1;
        if (length < 0 || length > LIMITS.keyMax) return fail(path, messages.keys);
        const error = check(node.value, valueAt(value, key), child(path, key as string));
        if (error) return error;
      }
      return null;
    }
    case 'union':
      return node.members.some((member) => check(member, value, path) === null) ? null : fail(path, messages.union);
    case 'json':
      return jsonSize(value, node.maxDepth, node.maxBytes) < 0 ? fail(path, messages.json(node.maxBytes, node.maxDepth)) : null;
    case 'optional':
    case 'nullable':
      return present(value) ? check(node.inner, value, path) : null;
  }
}

const VALID: Validation = Object.freeze({ ok: true });

/**
 * Checks a value against a schema with the same rules, in the same order and with the same
 * messages as the generated Lua validators. Pass `null` as the schema for "no value expected".
 *
 * @example
 * const result = validate(s.int({ min: 1 }), 0);
 * // { ok: false, error: 'expected at least 1' }
 */
export function validate(schema: Schema | null, value: unknown): Validation {
  const error = schema === null ? (present(value) ? messages.none : null) : check(nodeOf(schema), value, '');
  return error === null ? VALID : { ok: false, error };
}
