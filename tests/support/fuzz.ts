import { s, type Schema } from '../../src/contract';
import { nodeOf, type SchemaNode } from '../../src/contract/schema';

/** A small seeded generator, so a failing case can be replayed from its seed. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
}

const KEYS = ['id', 'name', 'amount', 'list', 'flag', 'kind', 'meta', 'x'] as const;
const WORDS = ['car', 'bike', 'boat', 'plane', 'a', ''] as const;

/** One, two, three and four byte characters, so byte counts and character counts disagree. */
const CHARS = ['a', 'Z', '7', '_', '-', ' ', 'é', 'ß', '日', '€', '😀', '\n', '"', '\\'] as const;

const CLASSES = ['[a-z]', '[A-Z0-9]', '\\d', '\\w', '[a-f0-9]', '[ab_-]', '[A-Za-z ]', 'x', '-', '#', '\\.', '[\\w.]'] as const;
const QUANTIFIERS = ['', '', '?', '*', '+', '{2}', '{1,3}', '{0,2}', '{2,}'] as const;

export function randomPattern(random: Random): string {
  let source = '^';
  for (let i = random.int(0, 4); i > 0; i--) source += random.pick(CLASSES) + random.pick(QUANTIFIERS);
  return `${source}$`;
}

export function randomText(random: Random, maxLength: number): string {
  let text = '';
  for (let i = random.int(0, maxLength); i > 0; i--) text += random.pick(CHARS);
  return text;
}

/** Text drawn from the characters patterns are built from, so matches and near misses are both common. */
export function patternText(random: Random): string {
  const alphabet = 'abfzAZ09_-#. x';
  let text = '';
  for (let i = random.int(0, 7); i > 0; i--) text += alphabet[random.int(0, alphabet.length - 1)];
  if (random.chance(0.05)) text += random.pick(['é', '😀', '\n']);
  return text;
}

function randomLeaf(random: Random): Schema {
  switch (random.int(0, 7)) {
    case 7:
      return s.json({ maxBytes: random.int(0, 60), maxDepth: random.int(0, 3) });
    case 0: {
      const min = random.int(0, 2);
      return s.string({ min, max: min + random.int(0, 5) });
    }
    case 1:
      return s.string({ max: random.int(4, 10), pattern: randomPattern(random) });
    case 2: {
      const min = random.int(-5, 5);
      return random.chance(0.3) ? s.int() : s.int({ min, max: min + random.int(0, 10) });
    }
    case 3: {
      const min = random.int(-5, 5) / 2;
      return random.chance(0.3) ? s.number() : s.number({ min, max: min + random.int(0, 6) / 2 });
    }
    case 4:
      return s.boolean();
    case 5:
      return s.enum(['car', 'bike', 'boat']);
    default:
      return s.literal(random.pick<string | number | boolean>(['car', 1, 2.5, true, false, '']));
  }
}

export function randomSchema(random: Random, depth: number): Schema {
  if (depth === 0 || random.chance(0.35)) return randomLeaf(random);
  switch (random.int(0, 4)) {
    case 0: {
      const min = random.int(0, 2);
      return s.array(randomSchema(random, depth - 1), { min, max: min + random.int(0, 3) });
    }
    case 4:
      return random.chance(0.5)
        ? s.union(randomSchema(random, depth - 1), randomSchema(random, depth - 1))
        : s.union(randomSchema(random, depth - 1), randomSchema(random, depth - 1), randomSchema(random, depth - 1));
    case 1:
      return s.record(randomSchema(random, depth - 1), { max: random.int(0, 3) });
    default: {
      const fields: Record<string, Schema> = {};
      for (let i = random.int(0, 4); i > 0; i--) {
        const inner = randomSchema(random, depth - 1);
        const wrap = random.int(0, 4);
        fields[random.pick(KEYS)] = wrap === 0 ? s.optional(inner) : wrap === 1 ? s.nullable(inner) : inner;
      }
      return s.object(fields);
    }
  }
}

function fromRanges(random: Random, ranges: readonly (readonly [number, number])[]): string {
  const [from, to] = random.pick(ranges);
  return String.fromCharCode(random.int(from, to));
}

/** A value that is meant to pass. A pattern can clash with its own length limits, so "meant to". */
export function likelyValid(random: Random, node: SchemaNode): unknown {
  switch (node.kind) {
    case 'string': {
      if (node.pattern) {
        let text = '';
        for (const item of node.pattern.items) {
          const most = item.max === null ? item.min + 2 : Math.min(item.max, item.min + 2);
          for (let i = random.int(item.min, most); i > 0; i--) text += fromRanges(random, item.ranges);
        }
        return text;
      }
      let text = '';
      for (let i = random.int(node.min, node.max); i > 0; i--) text += random.pick(CHARS);
      return text;
    }
    case 'int':
      return random.int(Math.max(node.min, -1000), Math.min(node.max, 1000));
    case 'number': {
      const min = node.min ?? -1000;
      const max = node.max ?? 1000;
      return random.chance(0.5) ? min + (max - min) * random.next() : random.pick([min, max]);
    }
    case 'boolean':
      return random.chance(0.5);
    case 'enum':
      return random.pick(node.values);
    case 'literal':
      return node.value;
    case 'array': {
      const items: unknown[] = [];
      for (let i = random.int(node.min, node.max); i > 0; i--) items.push(likelyValid(random, node.item));
      return items;
    }
    case 'union':
      return likelyValid(random, random.pick(node.members));
    case 'json':
      return garbage(random, node.maxDepth);
    case 'record': {
      const entries: Record<string, unknown> = {};
      for (let i = random.int(0, node.max); i > 0; i--) entries[`k${i}`] = likelyValid(random, node.value);
      return entries;
    }
    case 'object': {
      const value: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(node.fields)) {
        if ((field.kind === 'optional' || field.kind === 'nullable') && random.chance(0.4)) continue;
        value[key] = likelyValid(random, field);
      }
      return value;
    }
    case 'optional':
    case 'nullable':
      return random.chance(0.2) ? (random.chance(0.5) ? null : undefined) : likelyValid(random, node.inner);
  }
}

const SCALARS: readonly unknown[] = [
  null, undefined, true, false, 0, 1, -1, 2.5, -0.5, 7, 1e300, -1e300, 9007199254740992, 0.1,
  '', 'car', 'a', 'é', '日本', '😀', '\ud83d', 'x'.repeat(70), 'ß'.repeat(21), '1',
];

/** A value with no structure of its own, or an empty container: one defect at most wherever it lands. */
export function simpleValue(random: Random): unknown {
  return random.chance(0.15) ? random.pick([[], {}]) : random.pick(SCALARS);
}

export function garbage(random: Random, depth: number): unknown {
  if (depth === 0 || random.chance(0.5)) return simpleValue(random);
  if (random.chance(0.5)) {
    const items: unknown[] = [];
    for (let i = random.int(0, 4); i > 0; i--) items.push(garbage(random, depth - 1));
    return items;
  }
  const value: Record<string, unknown> = {};
  for (let i = random.int(0, 4); i > 0; i--) {
    value[random.pick([...KEYS, ...WORDS, '1', '2', 'k1'])] = garbage(random, depth - 1);
  }
  return value;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
    return copy as T;
  }
  return value;
}

/**
 * Changes one spot of a value. The result has at most one defect, so both validators must report
 * it with the same message whatever order they walk the value in.
 */
export function mutateOnce(random: Random, node: SchemaNode, value: unknown): unknown {
  const here = (): unknown => {
    if (typeof value === 'string' && random.chance(0.5)) {
      return random.pick([value + random.pick(CHARS), value.slice(1), value + '\ud800', value.toUpperCase(), value + value]);
    }
    if (typeof value === 'number' && random.chance(0.5)) {
      return random.pick([value + 1, value - 1, value + 0.5, -value, value * 1000, value + 100]);
    }
    return simpleValue(random);
  };

  if (node.kind === 'optional' || node.kind === 'nullable') {
    return value === null || value === undefined ? here() : mutateOnce(random, node.inner, value);
  }
  // Whatever happens inside a union or loose data, the verdict is one message at this place.
  if (node.kind === 'union') return mutateOnce(random, random.pick(node.members), value);
  if (node.kind === 'json') return random.chance(0.5) ? garbage(random, 4) : here();
  if (random.chance(0.3) || typeof value !== 'object' || value === null) return here();

  if (node.kind === 'array' && Array.isArray(value)) {
    const items = clone(value);
    const choice = random.int(0, 4);
    if (choice === 0) items.push(likelyValid(random, node.item));
    else if (choice === 1) items.push(null);
    else if (choice === 2 && items.length > 0) items[random.int(0, items.length - 1)] = null;
    else if (choice === 3 && items.length > 0) items.pop();
    else if (items.length > 0) {
      const index = random.int(0, items.length - 1);
      items[index] = mutateOnce(random, node.item, items[index]);
    } else items.push(simpleValue(random));
    return items;
  }

  if (node.kind === 'record' && !Array.isArray(value)) {
    const entries = clone(value) as Record<string, unknown>;
    const keys = Object.keys(entries);
    const choice = random.int(0, 3);
    if (choice === 0) entries[random.pick(['extra', 'é'.repeat(64), 'k'.repeat(65), '😀'])] = likelyValid(random, node.value);
    else if (choice === 1 && keys.length > 0) delete entries[random.pick(keys)];
    else if (choice === 2 && keys.length > 0) entries[random.pick(keys)] = null;
    else if (keys.length > 0) {
      const key = random.pick(keys);
      entries[key] = mutateOnce(random, node.value, entries[key]);
    } else entries.extra = simpleValue(random);
    return entries;
  }

  if (node.kind === 'object' && !Array.isArray(value)) {
    const object = clone(value) as Record<string, unknown>;
    const names = Object.keys(node.fields);
    const choice = random.int(0, 3);
    if (choice === 0 || names.length === 0) object[random.pick(['extra', 'toString', '1', 'é', 'k'.repeat(41)])] = simpleValue(random);
    else {
      const name = random.pick(names);
      if (choice === 1) delete object[name];
      else if (choice === 2) object[name] = random.pick([null, undefined]);
      else object[name] = mutateOnce(random, node.fields[name] as SchemaNode, object[name]);
    }
    return object;
  }

  return here();
}

export { nodeOf };
