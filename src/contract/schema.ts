import { ContractError } from './errors';
import { compilePattern, type Pattern } from './pattern';

declare const TYPE: unique symbol;

export type Kind =
  | 'string'
  | 'int'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'literal'
  | 'array'
  | 'object'
  | 'record'
  | 'union'
  | 'json'
  | 'optional'
  | 'nullable';

/** Describes a value that crosses the bridge. `T` is the TypeScript type of a value that passes. */
export interface Schema<T = unknown> {
  readonly kind: Kind;
  readonly [TYPE]?: T;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly kind: 'optional';
}

export interface NullableSchema<T> extends Schema<T | null | undefined> {
  readonly kind: 'nullable';
}

/** The TypeScript type a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Fields = Record<string, Schema>;

type MaybeAbsent<F> = {
  [K in keyof F]: F[K] extends { readonly kind: 'optional' | 'nullable' } ? K : never;
}[keyof F];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferObject<F extends Fields> = Simplify<
  { [K in Exclude<keyof F, MaybeAbsent<F>>]: Infer<F[K]> } & {
    [K in MaybeAbsent<F>]?: Infer<F[K]>;
  }
>;

/** What a schema is at runtime: plain frozen data, so both generators can walk it. */
export type SchemaNode =
  | { readonly kind: 'string'; readonly min: number; readonly max: number; readonly pattern: Pattern | null }
  | { readonly kind: 'int'; readonly min: number; readonly max: number }
  | { readonly kind: 'number'; readonly min: number | null; readonly max: number | null }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly item: SchemaNode; readonly min: number; readonly max: number }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, SchemaNode>> }
  | { readonly kind: 'record'; readonly value: SchemaNode; readonly max: number }
  | { readonly kind: 'union'; readonly members: readonly SchemaNode[] }
  | { readonly kind: 'json'; readonly maxBytes: number; readonly maxDepth: number }
  | { readonly kind: 'optional'; readonly inner: SchemaNode }
  | { readonly kind: 'nullable'; readonly inner: SchemaNode };

/**
 * Limits that apply when a schema does not set its own. They exist so that every payload has a
 * bounded size even when the author never thought about it.
 */
export const LIMITS = {
  stringMax: 1024,
  arrayMax: 256,
  recordMax: 256,
  keyMax: 64,
  jsonBytes: 4096,
  jsonDepth: 8,
} as const;

const KINDS: ReadonlySet<string> = new Set<Kind>([
  'string',
  'int',
  'number',
  'boolean',
  'enum',
  'literal',
  'array',
  'object',
  'record',
  'union',
  'json',
  'optional',
  'nullable',
]);

export function isSchema(value: unknown): value is Schema {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    KINDS.has((value as { kind: string }).kind)
  );
}

/** The runtime view of a schema. Schemas are only ever built by `s`, so this is a cast. */
export function nodeOf(schema: Schema): SchemaNode {
  return schema as unknown as SchemaNode;
}

function make<S extends Schema>(node: SchemaNode): S {
  return Object.freeze(node) as unknown as S;
}

function count(where: string, name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractError(`${where}: ${name} must be a whole number of 0 or more, got ${String(value)}`);
  }
  return value;
}

function ordered(where: string, min: number | null, max: number | null): void {
  if (min !== null && max !== null && min > max) {
    throw new ContractError(`${where}: min (${min}) is greater than max (${max})`);
  }
}

function child(where: string, what: string, why: string, schema: Schema): SchemaNode {
  if (!isSchema(schema)) {
    throw new ContractError(`${where}: ${what} must be a schema built with s, got ${describe(schema)}`);
  }
  const node = nodeOf(schema);
  if (node.kind === 'optional' || node.kind === 'nullable') {
    throw new ContractError(`${where}: ${what} cannot be ${node.kind}. ${why}`);
  }
  return node;
}

const NO_NIL = 'A Lua table cannot hold nil, so the gap would be lost on the way.';

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'a plain object' : `${typeof value} ${String(value)}`;
}

export interface StringOptions {
  /** Fewest characters allowed. Default 0. */
  min?: number;
  /** Most characters allowed. Default 1024. */
  max?: number;
  /**
   * A regular expression the whole string must match. Only a subset is allowed, because the
   * same check has to run in Lua: see the bridge documentation.
   */
  pattern?: RegExp | string;
}

export interface RangeOptions {
  min?: number;
  max?: number;
}

export interface SizeOptions {
  /** Most entries allowed. Default 256. */
  max?: number;
}

export interface ArrayOptions extends SizeOptions {
  /** Fewest items allowed. Default 0. */
  min?: number;
}

export interface JsonOptions {
  /** The size budget, see `s.json`. Default 4096. */
  maxBytes?: number;
  /** How many lists and objects may be nested inside each other. Default 8. */
  maxDepth?: number;
}

/**
 * The schema builders. Every schema is strict: unknown object keys are rejected and every string,
 * array and record has a maximum size.
 *
 * @example
 * s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) })
 */
export const s = {
  /** Text. Length is counted in characters, not bytes. */
  string(options: StringOptions = {}): Schema<string> {
    const min = count('s.string', 'min', options.min, 0);
    const max = count('s.string', 'max', options.max, LIMITS.stringMax);
    ordered('s.string', min, max);
    const pattern = options.pattern === undefined ? null : compilePattern(options.pattern);
    return make({ kind: 'string', min, max, pattern });
  },

  /** A whole number. Without bounds it accepts every integer JavaScript can hold exactly. */
  int(options: RangeOptions = {}): Schema<number> {
    const min = options.min ?? Number.MIN_SAFE_INTEGER;
    const max = options.max ?? Number.MAX_SAFE_INTEGER;
    for (const [name, value] of [['min', min], ['max', max]] as const) {
      if (!Number.isSafeInteger(value)) {
        throw new ContractError(`s.int: ${name} must be a whole number, got ${String(value)}`);
      }
    }
    ordered('s.int', min, max);
    return make({ kind: 'int', min, max });
  },

  /** A finite number. NaN and infinity never pass. */
  number(options: RangeOptions = {}): Schema<number> {
    const min = options.min ?? null;
    const max = options.max ?? null;
    for (const [name, value] of [['min', min], ['max', max]] as const) {
      if (value !== null && !Number.isFinite(value)) {
        throw new ContractError(`s.number: ${name} must be a finite number, got ${String(value)}`);
      }
    }
    ordered('s.number', min, max);
    return make({ kind: 'number', min, max });
  },

  boolean(): Schema<boolean> {
    return make({ kind: 'boolean' });
  },

  /** One of a fixed list of strings. */
  enum<const T extends readonly [string, ...string[]]>(values: T): Schema<T[number]> {
    if (!Array.isArray(values) || values.length === 0) {
      throw new ContractError('s.enum: pass a non-empty array of strings, for example s.enum(["car", "bike"])');
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new ContractError(`s.enum: values must be strings, got ${describe(value)}. Use s.literal for one number.`);
      }
    }
    if (new Set(values).size !== values.length) {
      throw new ContractError('s.enum: the same value is listed twice');
    }
    return make({ kind: 'enum', values: Object.freeze([...values]) });
  },

  /** Exactly one string, number or boolean. */
  literal<const T extends string | number | boolean>(value: T): Schema<T> {
    const ok =
      typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    if (!ok) {
      throw new ContractError(`s.literal: expected a string, a finite number or a boolean, got ${describe(value)}`);
    }
    return make({ kind: 'literal', value });
  },

  /** A list. Items cannot be optional or nullable. */
  array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
    const node = child('s.array', 'the item', `${NO_NIL} Wrap the array itself instead.`, item);
    const min = count('s.array', 'min', options.min, 0);
    const max = count('s.array', 'max', options.max, LIMITS.arrayMax);
    ordered('s.array', min, max);
    return make({ kind: 'array', item: node, min, max });
  },

  /**
   * A value that passes at least one of the given schemas. They are tried in the order written.
   *
   * @example
   * s.union(s.object({ kind: s.literal('car'), plate: s.string() }), s.object({ kind: s.literal('boat') }))
   */
  union<const M extends readonly [Schema, Schema, ...Schema[]]>(...members: M): Schema<Infer<M[number]>> {
    if (members.length < 2) {
      throw new ContractError('s.union: pass at least two schemas, for example s.union(s.string(), s.int())');
    }
    const nodes = members.map((member, index) => child('s.union', `member ${index + 1}`, 'Wrap the union itself instead: s.optional(s.union(...)).', member));
    return make({ kind: 'union', members: Object.freeze(nodes) });
  },

  /**
   * Any JSON data: text, numbers, booleans, and lists and objects of those, to any shape. It is
   * the loose end of a contract, for data whose shape the bridge has no business knowing, and it
   * is still bounded: `maxBytes` limits its size and `maxDepth` how deep it nests. The size is
   * close to that of the JSON text: the bytes of every string and key plus 2, 8 per number, 4
   * per boolean, 2 per list or object and 1 per entry.
   */
  json(options: JsonOptions = {}): Schema<unknown> {
    const maxBytes = count('s.json', 'maxBytes', options.maxBytes, LIMITS.jsonBytes);
    const maxDepth = count('s.json', 'maxDepth', options.maxDepth, LIMITS.jsonDepth);
    return make({ kind: 'json', maxBytes, maxDepth });
  },

  /** An object with exactly these keys. Keys wrapped in `s.optional` may be left out. */
  object<F extends Fields>(fields: F): Schema<InferObject<F>> {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      throw new ContractError(`s.object: expected an object of schemas, got ${describe(fields)}`);
    }
    const nodes: Record<string, SchemaNode> = Object.create(null);
    for (const key of Object.keys(fields)) {
      const field = fields[key];
      if (!isSchema(field)) {
        throw new ContractError(`s.object: "${key}" must be a schema built with s, got ${describe(field)}`);
      }
      nodes[key] = nodeOf(field);
    }
    return make({ kind: 'object', fields: Object.freeze(nodes) });
  },

  /** An object used as a map from text keys to values of one type. */
  record<T>(value: Schema<T>, options: SizeOptions = {}): Schema<Record<string, T>> {
    const node = child('s.record', 'the value', `${NO_NIL} Wrap the record itself instead.`, value);
    return make({ kind: 'record', value: node, max: count('s.record', 'max', options.max, LIMITS.recordMax) });
  },

  /** The value may be left out. */
  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    if (!isSchema(inner)) {
      throw new ContractError(`s.optional: expected a schema built with s, got ${describe(inner)}`);
    }
    return make({ kind: 'optional', inner: nodeOf(inner) });
  },

  /**
   * The value may be `null`. Lua has no null, so on the Lua side this is the same as
   * `s.optional`, and a value Lua leaves out reaches the UI as `undefined`.
   */
  nullable<T>(inner: Schema<T>): NullableSchema<T> {
    if (!isSchema(inner)) {
      throw new ContractError(`s.nullable: expected a schema built with s, got ${describe(inner)}`);
    }
    return make({ kind: 'nullable', inner: nodeOf(inner) });
  },
};

/**
 * The same object schema with every key optional. State travels as patches, so this is what a
 * patch has to satisfy.
 */
export function patchOf(schema: Schema): Schema {
  const node = nodeOf(schema);
  if (node.kind !== 'object') return schema;
  const fields: Record<string, SchemaNode> = Object.create(null);
  for (const name of Object.keys(node.fields)) {
    const field = node.fields[name] as SchemaNode;
    fields[name] = field.kind === 'optional' || field.kind === 'nullable' ? field : Object.freeze({ kind: 'optional', inner: field });
  }
  return make({ kind: 'object', fields: Object.freeze(fields) });
}
