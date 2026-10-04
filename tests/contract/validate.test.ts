import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contract, generateLua, patchOf, s, validate, type Schema } from '../../src/contract';
import { Lua } from '../support/lua';

const buy = s.object({
  item: s.string({ min: 1, max: 40 }),
  amount: s.int({ min: 1, max: 100 }),
  gift: s.optional(s.boolean()),
  note: s.nullable(s.string({ max: 10 })),
  tags: s.optional(s.array(s.enum(['new', 'sale']), { max: 2 })),
  prices: s.optional(s.record(s.number({ min: 0 }), { max: 2 })),
});

const valid = { item: 'water', amount: 2 };

const atLeastTwo = s.array(s.string(), { min: 2, max: 3 });
const shape = s.union(s.object({ kind: s.literal('car'), plate: s.string({ max: 8 }) }), s.object({ kind: s.literal('boat') }), s.int());
const loose = s.json({ maxBytes: 64, maxDepth: 3 });

/**
 * Every row is checked twice: by the TypeScript validator, and by the generated Lua validator
 * after the value has gone through JSON. The expected text is what both must say.
 */
const rows: [name: string, schema: Schema | null, value: unknown, error: string | null][] = [
  ['a valid object', buy, valid, null],
  ['every optional key present', buy, { ...valid, gift: true, note: 'hi', tags: ['new'], prices: { water: 1.5 } }, null],
  ['null for an optional key', buy, { ...valid, gift: null }, null],
  ['undefined for a nullable key', buy, { ...valid, note: undefined }, null],
  ['a missing key', buy, { item: 'water' }, 'amount: expected an integer'],
  ['an unknown key', buy, { ...valid, admin: true }, 'unknown key "admin"'],
  ['a key from the prototype', buy, { ...valid, constructor: 1 }, 'unknown key "constructor"'],
  ['a very long unknown key', buy, { ...valid, ['k'.repeat(41)]: 1 }, 'unknown key'],
  ['the wrong type', buy, { ...valid, item: 5 }, 'item: expected a string'],
  ['a string that is too short', buy, { ...valid, item: '' }, 'item: expected at least 1 character'],
  ['a string that is too long', buy, { ...valid, item: 'x'.repeat(41) }, 'item: expected at most 40 characters'],
  ['length counted in characters, not bytes', buy, { ...valid, note: '日本語日本語日本語😀' }, null],
  ['one character too many', buy, { ...valid, note: '日本語日本語日本語😀!' }, 'note: expected at most 10 characters'],
  ['a lone surrogate', buy, { ...valid, note: 'a\ud83d' }, 'note: expected well-formed text'],
  ['a fraction for an integer', buy, { ...valid, amount: 1.5 }, 'amount: expected an integer'],
  ['an integer below the minimum', buy, { ...valid, amount: 0 }, 'amount: expected at least 1'],
  ['an integer above the maximum', buy, { ...valid, amount: 101 }, 'amount: expected at most 100'],
  ['an integer JavaScript cannot hold exactly', s.int(), 9007199254740992, 'expected an integer'],
  ['a huge float for an integer', s.int(), 1e300, 'expected an integer'],
  ['a number as a string', buy, { ...valid, amount: '2' }, 'amount: expected an integer'],
  ['a non-boolean', buy, { ...valid, gift: 1 }, 'gift: expected true or false'],
  ['a value outside the enum', buy, { ...valid, tags: ['old'] }, 'tags[1]: expected one of "new", "sale"'],
  ['too many items', buy, { ...valid, tags: ['new', 'sale', 'new'] }, 'tags: expected at most 2 items'],
  ['a null in the middle of an array', buy, { ...valid, tags: [null, 'new'] }, 'tags[1]: expected one of "new", "sale"'],
  ['a trailing null, which Lua cannot see', buy, { ...valid, tags: ['new', null] }, null],
  ['an object where an array belongs', buy, { ...valid, tags: { a: 'new' } }, 'tags[1]: expected one of "new", "sale"'],
  ['an empty object where an array belongs', buy, { ...valid, tags: {} }, null],
  ['an array where an object belongs', buy, [valid], 'expected an object'],
  ['an empty array where an object belongs', s.object({ a: s.optional(s.int()) }), [], null],
  ['a scalar where an object belongs', buy, 'water', 'expected an object'],
  ['null where an object belongs', buy, null, 'expected an object'],
  ['a record value out of range', buy, { ...valid, prices: { water: -1 } }, 'prices.water: expected at least 0'],
  ['too many record entries', buy, { ...valid, prices: { a: 1, b: 2, c: 3 } }, 'prices: expected at most 2 entries'],
  ['a record key that is too long', buy, { ...valid, prices: { ['k'.repeat(65)]: 1 } }, 'prices: expected text keys of at most 64 characters'],
  ['an array where a record belongs', buy, { ...valid, prices: [1] }, 'prices: expected text keys of at most 64 characters'],
  ['a literal', s.literal('yes'), 'yes', null],
  ['the wrong literal', s.literal('yes'), 'no', 'expected "yes"'],
  ['a numeric literal', s.literal(2), '2', 'expected 2'],
  ['a number out of range', s.number({ min: 0, max: 1 }), 1.5, 'expected at most 1'],
  ['a nested path', s.array(s.object({ at: s.array(s.int()) })), [{ at: [1] }, { at: [1, 'x'] }], '[2].at[2]: expected an integer'],
  ['a patch with one key', patchOf(buy), { amount: 3 }, null],
  ['a patch with a bad key', patchOf(buy), { amount: 0 }, 'amount: expected at least 1'],
  ['a patch with an unknown key', patchOf(buy), { amont: 3 }, 'unknown key "amont"'],
  ['nothing where nothing is expected', null, undefined, null],
  ['null where nothing is expected', null, null, null],
  ['something where nothing is expected', null, {}, 'expected no value'],
  ['enough items', atLeastTwo, ['a', 'b'], null],
  ['too few items', atLeastTwo, ['a'], 'expected at least 2 items'],
  ['an empty list where one item is the least', s.array(s.int(), { min: 1 }), [], 'expected at least 1 item'],
  ['the first shape of a union', shape, { kind: 'car', plate: 'ABC 123' }, null],
  ['the second shape of a union', shape, { kind: 'boat' }, null],
  ['a scalar member of a union', shape, 7, null],
  ['a value no member of a union accepts', shape, { kind: 'car' }, 'expected a value that matches one of the allowed shapes'],
  ['a mix of two members of a union', shape, { kind: 'boat', plate: 'ABC 123' }, 'expected a value that matches one of the allowed shapes'],
  ['nothing where a union is expected', shape, null, 'expected a value that matches one of the allowed shapes'],
  ['a union inside an object', s.object({ target: shape }), { target: 'x' }, 'target: expected a value that matches one of the allowed shapes'],
  ['loose data of any shape', loose, { a: [1, 'two', true], b: { c: 'd' } }, null],
  ['a scalar as loose data', loose, 'text', null],
  ['an empty list as loose data', loose, [], null],
  ['loose data exactly at its size', s.json({ maxBytes: 11 }), { ab: 'cd' }, null],
  ['loose data one byte over', s.json({ maxBytes: 10 }), { ab: 'cd' }, 'expected JSON data of at most 10 bytes, nested at most 8 deep'],
  ['loose data that is too large', loose, { text: 'x'.repeat(70) }, 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['size counted in bytes, not characters', loose, ['日本語日本語日本語日本語日本語日本語日本語'], 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['many small entries', loose, Array.from({ length: 30 }, () => true), 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['loose data nested as deep as allowed', loose, [[['x']]], null],
  ['loose data nested too deep', loose, [[[['x']]]], 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['a gap in a loose list', loose, [1, null, 3], 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['a trailing null in a loose list', loose, [1, null], null],
  ['a null key in loose data, which Lua cannot see', loose, { a: 1, b: null }, null],
  ['a lone surrogate in loose data', loose, { a: '\ud83d' }, 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
  ['nothing as loose data', loose, undefined, 'expected JSON data of at most 64 bytes, nested at most 3 deep'],
];

describe('validate', () => {
  let lua: Lua;

  beforeAll(async () => {
    lua = await Lua.create();
    const client: Record<string, Schema> = {};
    const calls: Record<string, object> = {};
    rows.forEach(([, schema], index) => {
      if (schema === null) calls[`m${index}`] = {};
      else client[`m${index}`] = schema;
    });
    await lua.run(generateLua(contract({ client, calls })));
  });

  afterAll(() => lua.close());

  it.each(rows.map((row, index) => [...row, index] as const))('%s', async (_name, schema, value, error, index) => {
    expect(validate(schema, value)).toEqual(error === null ? { ok: true } : { ok: false, error });

    const fromLua = await lua.call(
      `
      local validator = NexusContract.client['m${index}'] or NexusContract.calls['m${index}'].input
      local ok, problem = validator(...)
      return ok and 'ok' or problem
      `,
      value,
    );
    expect(fromLua).toBe(error ?? 'ok');
  });
});

describe('the generated Lua validators', () => {
  let lua: Lua;

  beforeAll(async () => {
    lua = await Lua.create();
    await lua.run(
      generateLua(
        contract({
          client: {
            list: s.array(s.int(), { max: 100 }),
            map: s.record(s.string({ max: 8 })),
            plate: s.string({ max: 8, pattern: /^[A-Z0-9]{1,8}$/ }),
            long: s.string({ max: 20000, pattern: /^a*a*a*a*a*b$/ }),
            point: s.object({ x: s.number(), y: s.number() }),
          },
        }),
      ),
    );
  });

  afterAll(() => lua.close());

  const check = (name: string, lua54: string): Promise<unknown> =>
    lua.run(`local ok, problem = NexusContract.client.${name}(${lua54}) return ok and 'ok' or problem`);

  it('refuse values JSON cannot carry', async () => {
    expect(await check('point', '{ x = 0/0, y = 1 }')).toBe('x: expected a number');
    expect(await check('point', '{ x = math.huge, y = 1 }')).toBe('x: expected a number');
    expect(await check('point', '{ x = 1, y = -math.huge }')).toBe('y: expected a number');
    expect(await check('list', '{ math.huge }')).toBe('[1]: expected an integer');
    expect(await check('list', '{ 2^53 }')).toBe('[1]: expected an integer');
    expect(await check('point', 'function() end')).toBe('expected an object');
    expect(await check('point', 'coroutine.create(print)')).toBe('expected an object');
    expect(await check('list', '{ [1.5] = 1 }')).toBe('[1]: expected an integer');
    expect(await check('point', '{ x = 1, y = 2, [true] = 3 }')).toBe('unknown key');
    expect(await check('plate', "'AB\\0CD'")).toBe('expected text matching ^[A-Z0-9]{1,8}$');
    expect(await check('map', "{ ['\\255'] = 'x' }")).toBe('expected text keys of at most 64 characters');
  });

  it('accept an integer that arrives as a float', async () => {
    expect(await check('list', '{ 1.0, 2.0 }')).toBe('ok');
  });

  it('refuse a table with a metatable, which is how a function reference arrives', async () => {
    expect(await check('map', "setmetatable({ __cfx_functionReference = 'demo:1' }, { __call = print })")).toBe('expected an object');
    expect(await check('list', 'setmetatable({ 1, 2 }, { __index = table })')).toBe('expected an array');
  });

  it('accept the tables json.decode returns, which carry a marker metatable', async () => {
    expect(await check('map', "setmetatable({ a = 'x' }, { __jsontype = 'object' })")).toBe('ok');
    expect(await check('list', "setmetatable({ 1, 2 }, { __jsontype = 'array' })")).toBe('ok');
  });

  it('survive a hostile metatable', async () => {
    expect(await check('map', 'setmetatable({}, { __metatable = false })')).toBe('expected an object');
    expect(await check('map', "setmetatable({}, { __metatable = 'locked' })")).toBe('expected an object');
  });

  it('stop counting as soon as a table is too large', async () => {
    // The validators capture `pairs` when the file loads, so a counting one has to be in place
    // before that, in a state of its own.
    const counting = await Lua.create();
    await counting.run(`
      visited = 0
      local realPairs = pairs
      pairs = function(t)
          local nextKey, state, first = realPairs(t)
          return function(s, k)
              visited = visited + 1
              return nextKey(s, k)
          end, state, first
      end
    `);
    await counting.run(generateLua(contract({ client: { list: s.array(s.int(), { max: 100 }), map: s.record(s.int(), { max: 10 }) } })));
    const steps = await counting.run(`
      local huge = {}
      for i = 1, 200000 do huge[i] = i end
      local ok, problem = NexusContract.client.list(huge)
      assert(not ok and problem == 'expected at most 100 items', problem)
      local afterList = visited
      ok, problem = NexusContract.client.map(huge)
      assert(not ok and problem == 'expected at most 10 entries', problem)
      return afterList .. ' ' .. visited - afterList
    `);
    counting.close();
    expect(steps).toBe('101 11');
  });

  it('match a pattern in time that does not depend on how adversarial the text is', async () => {
    const elapsed = await lua.run(`
      local text = string.rep('a', 20000)
      local started = os.clock()
      local ok, problem = NexusContract.client.long(text)
      assert(not ok and problem == 'expected text matching ^a*a*a*a*a*b$', problem)
      return os.clock() - started
    `);
    // A backtracking matcher needs on the order of 20000^5 steps for this input.
    expect(elapsed).toBeLessThan(2);
  });
});
