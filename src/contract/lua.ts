import type { Contract } from './contract';
import { messages, UNKNOWN_KEY_MAX_BYTES } from './messages';
import type { Pattern } from './pattern';
import { LIMITS, nodeOf, patchOf, type Schema, type SchemaNode } from './schema';

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

const encoder = new TextEncoder();

/** A single-quoted Lua string literal holding exactly the UTF-8 bytes of `text`. */
export function luaString(text: string): string {
  let out = "'";
  for (const byte of encoder.encode(text)) {
    if (byte === 0x5c) out += '\\\\';
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x0a) out += '\\n';
    else if (byte === 0x0d) out += '\\r';
    else if (byte < 0x20 || byte > 0x7e) out += `\\${String(byte).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}'`;
}

/** A table constructor key: bare when it is a valid Lua name, bracketed otherwise. */
export function luaKey(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `[${luaString(name)}]`;
}

function luaIndex(table: string, name: string): string {
  const key = luaKey(name);
  return key.startsWith('[') ? `${table}${key}` : `${table}.${key}`;
}

function luaNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

/** A path is text with Lua expressions spliced in for the parts only known at run time. */
type PathPart = { readonly text: string } | { readonly lua: string };
type Path = readonly PathPart[];

function field(path: Path, name: string): Path {
  return [...path, { text: path.length === 0 ? name : `.${name}` }];
}

function concat(parts: Path): string {
  const merged: PathPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if ('text' in part && part.text === '') continue;
    if ('text' in part && last && 'text' in last) merged[merged.length - 1] = { text: last.text + part.text };
    else merged.push(part);
  }
  if (merged.length === 0) return "''";
  return merged.map((part) => ('text' in part ? luaString(part.text) : part.lua)).join(' .. ');
}

function failure(path: Path, message: string): string {
  return concat(path.length === 0 ? [{ text: message }] : [...path, { text: `: ${message}` }]);
}

/** Constants shared by every validator, written once at the top of the file and referred to by index. */
class Pool {
  private readonly entries: string[] = [];
  private readonly seen = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly functions = false,
  ) {}

  ref(code: string): string {
    let index = this.seen.get(code);
    if (index === undefined) {
      this.entries.push(code);
      index = this.entries.length;
      this.seen.set(code, index);
    }
    return `${this.name}[${index}]`;
  }

  get used(): boolean {
    return this.entries.length > 0;
  }

  emit(): string {
    // Functions are assigned one by one, so that one of them can refer to the table they are in.
    if (this.functions) {
      return `local ${this.name} = {}\n${this.entries.map((entry, index) => `${this.name}[${index + 1}] = ${entry}\n`).join('')}`;
    }
    return `local ${this.name} = {\n${this.entries.map((entry) => `    ${entry},\n`).join('')}}\n`;
  }
}

interface Pools {
  readonly keys: Pool;
  readonly enums: Pool;
  readonly patterns: Pool;
  /** One function per member of a union: a member is tried, not required, so it cannot be inline. */
  readonly unions: Pool;
  /** Set once a schema needs the `jsonSize` helper. */
  json: boolean;
}

function setOf(names: readonly string[]): string {
  return names.length === 0 ? '{}' : `{ ${names.map((name) => `${luaKey(name)} = true`).join(', ')} }`;
}

function patternCode(pattern: Pattern): string {
  const items = pattern.items.map((item) => {
    const ranges = item.ranges.map(([from, to]) => String.fromCharCode(from, to)).join('');
    const max = item.max === null ? 'huge' : String(item.max);
    return `{ charset(${luaString(ranges)}), ${item.min}, ${max} }`;
  });
  return items.length === 0 ? '{}' : `{ ${items.join(', ')} }`;
}

class Writer {
  readonly lines: string[] = [];
  private depth: number;

  constructor(indent: number) {
    this.depth = indent;
  }

  line(code: string): void {
    this.lines.push('    '.repeat(this.depth) + code);
  }

  block(open: string, body: () => void): void {
    this.line(open);
    this.depth++;
    body();
    this.depth--;
    this.line('end');
  }
}

/**
 * Writes the checks for one value. `name` is the Lua local that holds it and `level` numbers the
 * locals this value needs, so a value nested inside another never reuses its parent's names.
 */
function emit(node: SchemaNode, name: string, path: Path, level: number, out: Writer, pools: Pools): void {
  const reject = (condition: string, message: string): void => {
    out.line(`if ${condition} then return false, ${failure(path, message)} end`);
  };
  const count = `n${level}`;
  const inner = `v${level + 1}`;

  const countUpTo = (max: number, message: string): void => {
    out.line(`local ${count} = 0`);
    out.block(`for _ in pairs(${name}) do`, () => {
      out.line(`${count} = ${count} + 1`);
      reject(`${count} > ${max}`, message);
    });
  };

  switch (node.kind) {
    case 'string':
      reject(`type(${name}) ~= 'string'`, messages.string);
      out.line(`local ${count} = utf8len(${name})`);
      reject(`not ${count}`, messages.malformed);
      reject(`${count} > ${node.max}`, messages.maxChars(node.max));
      if (node.min > 0) reject(`${count} < ${node.min}`, messages.minChars(node.min));
      if (node.pattern) {
        reject(`not matches(${name}, ${pools.patterns.ref(patternCode(node.pattern))})`, messages.pattern(node.pattern.source));
      }
      return;
    case 'int':
      reject(`not isInt(${name})`, messages.int);
      if (node.min > Number.MIN_SAFE_INTEGER) reject(`${name} < ${luaNumber(node.min)}`, messages.atLeast(node.min));
      if (node.max < Number.MAX_SAFE_INTEGER) reject(`${name} > ${luaNumber(node.max)}`, messages.atMost(node.max));
      return;
    case 'number':
      reject(`not isNumber(${name})`, messages.number);
      if (node.min !== null) reject(`${name} < ${luaNumber(node.min)}`, messages.atLeast(node.min));
      if (node.max !== null) reject(`${name} > ${luaNumber(node.max)}`, messages.atMost(node.max));
      return;
    case 'boolean':
      reject(`type(${name}) ~= 'boolean'`, messages.boolean);
      return;
    case 'enum':
      reject(`type(${name}) ~= 'string' or not ${pools.enums.ref(setOf(node.values))}[${name}]`, messages.oneOf(node.values));
      return;
    case 'literal': {
      const literal = typeof node.value === 'string' ? luaString(node.value) : typeof node.value === 'number' ? luaNumber(node.value) : String(node.value);
      reject(`${name} ~= ${literal}`, messages.literal(node.value));
      return;
    }
    case 'array': {
      const index = `i${level}`;
      reject(`not isTable(${name})`, messages.array);
      countUpTo(node.max, messages.maxItems(node.max));
      if (node.min > 0) reject(`${count} < ${node.min}`, messages.minItems(node.min));
      out.block(`for ${index} = 1, ${count} do`, () => {
        out.line(`local ${inner} = ${name}[${index}]`);
        emit(node.item, inner, [...path, { text: '[' }, { lua: index }, { text: ']' }], level + 1, out, pools);
      });
      return;
    }
    case 'object': {
      const key = `k${level}`;
      const names = Object.keys(node.fields);
      reject(`not isTable(${name}) or ${name}[1] ~= nil`, messages.object);
      out.block(`for ${key} in pairs(${name}) do`, () => {
        out.line(`if not ${pools.keys.ref(setOf(names))}[${key}] then return false, unknownKey(${concat(path)}, ${key}) end`);
      });
      for (const fieldName of names) {
        out.block('do', () => {
          out.line(`local ${inner} = ${luaIndex(name, fieldName)}`);
          emit(node.fields[fieldName] as SchemaNode, inner, field(path, fieldName), level + 1, out, pools);
        });
      }
      return;
    }
    case 'record': {
      const key = `k${level}`;
      const length = `c${level}`;
      reject(`not isTable(${name})`, messages.object);
      countUpTo(node.max, messages.maxEntries(node.max));
      out.block(`for ${key}, ${inner} in pairs(${name}) do`, () => {
        out.line(`local ${length} = type(${key}) == 'string' and utf8len(${key})`);
        reject(`not ${length} or ${length} > ${LIMITS.keyMax}`, messages.keys);
        emit(node.value, inner, [...path, { text: path.length === 0 ? '' : '.' }, { lua: key }], level + 1, out, pools);
      });
      return;
    }
    case 'union': {
      const tries = node.members.map((member) => `${pools.unions.ref(validator(member as unknown as Schema, 0, pools))}(${name})`);
      reject(`not (${tries.join(' or ')})`, messages.union);
      return;
    }
    case 'json':
      pools.json = true;
      reject(`jsonSize(${name}, ${node.maxDepth}, ${node.maxBytes}) < 0`, messages.json(node.maxBytes, node.maxDepth));
      return;
    case 'optional':
    case 'nullable':
      out.block(`if ${name} ~= nil then`, () => emit(node.inner, name, path, level, out, pools));
      return;
  }
}

function validator(schema: Schema | null, indent: number, pools: Pools): string {
  const out = new Writer(indent + 1);
  if (schema === null) out.line(`if v ~= nil then return false, ${luaString(messages.none)} end`);
  else emit(nodeOf(schema), 'v', [], 0, out, pools);
  out.line('return true');
  return `function(v)\n${out.lines.join('\n')}\n${'    '.repeat(indent)}end`;
}

const HELPERS = `local type, pairs, getmetatable = type, pairs, getmetatable
local floor, huge, byte, utf8len = math.floor, math.huge, string.byte, utf8.len

-- A payload from the network is plain tables. Anything with a metatable is a wrapped value such
-- as a function reference and is refused, except what json.decode returns, which marks its
-- tables with __jsontype and is plain data that a handler may well pass on.
local function isTable(v)
    if type(v) ~= 'table' then return false end
    local meta = getmetatable(v)
    return meta == nil or (type(meta) == 'table' and meta.__jsontype ~= nil)
end

-- Integers are held to the range a JavaScript number can represent exactly, so a value means the
-- same thing on both sides of the bridge.
local function isInt(v)
    return type(v) == 'number' and v == floor(v) and v >= -9007199254740991 and v <= 9007199254740991
end

local function isNumber(v)
    return type(v) == 'number' and v == v and v ~= huge and v ~= -huge
end

local function unknownKey(path, key)
    local message = ${luaString(messages.unknownKey)}
    if type(key) == 'string' and #key <= ${UNKNOWN_KEY_MAX_BYTES} then
        message = message .. ' "' .. key .. '"'
    end
    if path == '' then return message end
    return path .. ': ' .. message
end
`;

const PATTERN_HELPERS = `
local function charset(ranges)
    local set = {}
    for i = 1, #ranges, 2 do
        for code = byte(ranges, i), byte(ranges, i + 1) do set[code] = true end
    end
    return set
end

-- Matches text against a list of { set, min, max } steps. It walks the text once per step and
-- tracks every position the steps so far can end at, so the cost is steps * length whatever the
-- input: there is no backtracking for a crafted string to exploit.
local function matches(text, steps)
    local length = #text
    local reach = { [0] = true }
    for s = 1, #steps do
        local set, min, max = steps[s][1], steps[s][2], steps[s][3]
        local before = { 0 }
        for p = 0, length do
            before[p + 2] = before[p + 1] + (reach[p] and 1 or 0)
        end
        local nextReach, runStart, any = {}, 0, false
        for p = 0, length do
            if p > 0 and not set[byte(text, p)] then runStart = p end
            local from, to = p - max, p - min
            if from < runStart then from = runStart end
            if to >= from and before[to + 2] > before[from + 1] then
                nextReach[p] = true
                any = true
            end
        end
        if not any then return false end
        reach = nextReach
    end
    return reach[length] == true
end
`;

const JSON_HELPERS = `
-- What is left of the budget after the size of a JSON value is taken from it, or a negative
-- number when the value is too large, nests too deep or is not JSON data. Every entry costs at
-- least its separator, so the budget also bounds how many entries are looked at.
local function jsonSize(v, depth, budget)
    local kind = type(v)
    if kind == 'string' then
        if not utf8len(v) then return -1 end
        return budget - #v - 2
    elseif kind == 'number' then
        if not isNumber(v) then return -1 end
        return budget - 8
    elseif kind == 'boolean' then
        return budget - 4
    elseif not isTable(v) or depth < 1 then
        return -1
    end
    local count = 0
    for _ in pairs(v) do
        count = count + 1
        if count > budget then return -1 end
    end
    local left = budget - 2
    -- A table is a list when it has an item at 1. A list with a gap, or with other keys, has
    -- fewer items in a row than it has entries and is refused.
    if count == 0 or v[1] ~= nil then
        for i = 1, count do
            local item = v[i]
            if item == nil then return -1 end
            left = jsonSize(item, depth - 1, left - 1)
            if left < 0 then return left end
        end
    else
        for key, item in pairs(v) do
            if type(key) ~= 'string' or not utf8len(key) then return -1 end
            left = jsonSize(item, depth - 1, left - #key - 3)
            if left < 0 then return left end
        end
    end
    return left
end
`;

export interface LuaOptions {
  /** Named in the header comment so a reader knows where the file came from. */
  source?: string;
}

/**
 * Generates `nexus/contract.lua`: one validator per message and the rate limit of every call,
 * as plain Lua with no dependencies. Both Lua runtimes load it as the global `NexusContract`.
 */
export function generateLua(contract: Contract, options: LuaOptions = {}): string {
  const pools: Pools = { keys: new Pool('keys'), enums: new Pool('enums'), patterns: new Pool('patterns'), unions: new Pool('unions', true), json: false };

  const section = (name: string, schemas: Readonly<Record<string, Schema>>, map: (schema: Schema) => Schema): string => {
    const names = Object.keys(schemas);
    if (names.length === 0) return `    ${name} = {},\n`;
    const body = names.map((key) => `        ${luaKey(key)} = ${validator(map(schemas[key] as Schema), 2, pools)},\n`);
    return `    ${name} = {\n${body.join('')}    },\n`;
  };

  const callNames = Object.keys(contract.calls);
  const calls = callNames.map((name) => {
    const call = contract.calls[name]!;
    const codes = Object.keys(call.errors);
    const errors = codes.map((code) => `                ${luaKey(code)} = ${validator(call.errors[code] as Schema, 4, pools)},\n`);
    return (
      `        ${luaKey(name)} = {\n` +
      `            limit = ${call.rate.limit},\n` +
      `            per = ${luaNumber(call.rate.per)},\n` +
      `            input = ${validator(call.input, 3, pools)},\n` +
      `            output = ${validator(call.output, 3, pools)},\n` +
      (codes.length === 0 ? '            errors = {},\n' : `            errors = {\n${errors.join('')}            },\n`) +
      `        },\n`
    );
  });

  const table =
    'NexusContract = {\n' +
    (calls.length === 0 ? '    calls = {},\n' : `    calls = {\n${calls.join('')}    },\n`) +
    section('pushes', contract.pushes, (schema) => schema) +
    section('client', contract.client, (schema) => schema) +
    section('state', contract.state, patchOf) +
    section('screens', contract.screens, (schema) => schema) +
    '}\n';

  const constants = [pools.keys, pools.enums, pools.patterns, pools.unions].filter((pool) => pool.used).map((pool) => `\n${pool.emit()}`);

  return (
    `-- Generated by Nexus UI from ${options.source ?? 'web/contract.ts'}. Do not edit: the next build overwrites it.\n\n` +
    HELPERS +
    (pools.patterns.used ? PATTERN_HELPERS : '') +
    (pools.json ? JSON_HELPERS : '') +
    constants.join('') +
    '\n' +
    table
  );
}
