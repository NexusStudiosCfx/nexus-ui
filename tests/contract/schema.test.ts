import { describe, expect, expectTypeOf, it } from 'vitest';
import { contract, ContractError, mock, reject, s, validate } from '../../src/contract';
import type { CallInput, CallOutput, ClientData, Contract, ContractDefinition, Infer, PushData, StateData } from '../../src/contract';

describe('s', () => {
  it('infers the TypeScript type of a schema', () => {
    const schema = s.object({
      item: s.string({ max: 40 }),
      amount: s.int({ min: 1 }),
      kind: s.enum(['car', 'bike']),
      exact: s.literal('yes'),
      tags: s.array(s.string()),
      prices: s.record(s.number()),
      note: s.optional(s.string()),
      owner: s.nullable(s.int()),
    });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{
      item: string;
      amount: number;
      kind: 'car' | 'bike';
      exact: 'yes';
      tags: string[];
      prices: Record<string, number>;
      note?: string | undefined;
      owner?: number | null | undefined;
    }>();
  });

  it('applies default limits so that every payload is bounded', () => {
    expect(s.string()).toMatchObject({ min: 0, max: 1024 });
    expect(s.array(s.int())).toMatchObject({ max: 256 });
    expect(s.record(s.int())).toMatchObject({ max: 256 });
    expect(validate(s.string(), 'x'.repeat(1025))).toEqual({ ok: false, error: 'expected at most 1024 characters' });
    expect(validate(s.array(s.int()), Array.from({ length: 257 }, () => 1))).toEqual({
      ok: false,
      error: 'expected at most 256 items',
    });
  });

  it('builds frozen schemas', () => {
    const schema = s.object({ a: s.int() }) as unknown as { fields: Record<string, unknown> };
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.fields)).toBe(true);
  });

  it.each([
    [() => s.string({ min: 5, max: 2 }), 's.string: min (5) is greater than max (2)'],
    [() => s.string({ max: -1 }), 's.string: max must be a whole number of 0 or more, got -1'],
    [() => s.string({ max: 1.5 }), 's.string: max must be a whole number of 0 or more, got 1.5'],
    [() => s.int({ min: 0.5 }), 's.int: min must be a whole number, got 0.5'],
    [() => s.int({ min: 3, max: 1 }), 's.int: min (3) is greater than max (1)'],
    [() => s.number({ max: Infinity }), 's.number: max must be a finite number, got Infinity'],
    [() => s.enum([] as unknown as [string]), 's.enum: pass a non-empty array of strings'],
    [() => s.enum(['a', 'a']), 's.enum: the same value is listed twice'],
    [() => s.enum([1] as unknown as [string]), 's.enum: values must be strings'],
    [() => s.literal(NaN), 's.literal: expected a string, a finite number or a boolean'],
    [() => s.array(s.optional(s.int())), 's.array: the item cannot be optional. A Lua table cannot hold nil'],
    [() => s.record(s.nullable(s.int())), 's.record: the value cannot be nullable. A Lua table cannot hold nil'],
    [() => s.array('string' as never), 's.array: the item must be a schema built with s, got string string'],
    [() => s.object({ a: 1 as never }), 's.object: "a" must be a schema built with s, got number 1'],
    [() => s.object(null as never), 's.object: expected an object of schemas, got null'],
    [() => s.optional({} as never), 's.optional: expected a schema built with s, got a plain object'],
  ])('refuses a schema it could not enforce (%#)', (build, message) => {
    expect(build).toThrow(ContractError);
    expect(build).toThrow(message);
  });
});

describe('s.string pattern', () => {
  it.each([
    ['^[A-Z0-9 ]{1,8}$', 'AB 12', true],
    ['^[A-Z0-9 ]{1,8}$', '', false],
    ['^[A-Z0-9 ]{1,8}$', 'ABCDEFGHI', false],
    ['^[a-z_]+:\\d{2,}$', 'shop_buy:42', true],
    ['^[a-z_]+:\\d{2,}$', 'shop_buy:4', false],
    ['^#[0-9a-fA-F]{6}$', '#ff00AA', true],
    ['^#[0-9a-fA-F]{6}$', '#ff00A', false],
    ['^\\w*\\.?lua$', 'client.lua', true],
    ['^$', '', true],
    ['^$', 'a', false],
    ['^[a-z]+$', 'héllo', false],
  ])('%s on %j is %s', (pattern, text, expected) => {
    expect(validate(s.string({ pattern }), text).ok).toBe(expected);
  });

  it('accepts a RegExp and reports the source in the message', () => {
    expect(validate(s.string({ pattern: /^[a-z]+$/ }), 'ABC')).toEqual({
      ok: false,
      error: 'expected text matching ^[a-z]+$',
    });
  });

  it.each([
    ['[a-z]+', 'the pattern must start with ^ and end with $'],
    ['^a.c$', '"." is not supported'],
    ['^(ab)+$', 'groups and alternatives are not supported'],
    ['^a|b$', 'groups and alternatives are not supported'],
    ['^[^a]$', 'negated classes such as [^a] are not supported'],
    ['^\\s+$', '\\s is not supported'],
    ['^a+?$', 'lazy and possessive quantifiers are not supported'],
    ['^é$', 'only ASCII characters can be matched'],
    ['^[a-$', 'a [ is never closed'],
    ['^[!-/]$', 'a range must run between letters or digits'],
    ['^[z-a]$', 'the range z-a is backwards'],
    ['^a{3,1}$', 'the quantifier {3,1} is backwards'],
    ['^a{x}$', 'a { must be a quantifier'],
    ['^*a$', 'unexpected "*"'],
    ['^a$b$', '"$" is only allowed as the anchor at the end'],
    ['^a\\$', 'the final $ is escaped'],
    ['^[]$', 'an empty class [] can never match'],
  ])('refuses %s', (pattern, message) => {
    expect(() => s.string({ pattern })).toThrow(ContractError);
    expect(() => s.string({ pattern })).toThrow(message);
  });

  it('refuses flags', () => {
    expect(() => s.string({ pattern: /^[a-z]+$/i })).toThrow('flags are not supported (found "i")');
  });
});

describe('contract', () => {
  const definition = contract({
    calls: {
      'shop:buy': {
        input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
        output: s.object({ ok: s.boolean(), balance: s.int() }),
        rate: { limit: 5, per: 10 },
      },
      'shop:refresh': {},
    },
    pushes: { 'shop:stock': s.object({ item: s.string(), stock: s.int({ min: 0 }) }) },
    client: { 'shop:preview': s.object({ item: s.string() }) },
    state: { hud: s.object({ health: s.int(), cash: s.int() }) },
  });

  it('fills in the defaults', () => {
    expect(definition.calls['shop:buy']?.rate).toEqual({ limit: 5, per: 10 });
    expect(definition.calls['shop:refresh']).toEqual({ input: null, output: null, rate: { limit: 30, per: 10 }, errors: {} });
    expect(contract({})).toEqual({ calls: {}, pushes: {}, client: {}, state: {}, screens: {} });
  });

  it('keeps the definition for type inference', () => {
    type D = typeof definition extends Contract<infer T extends ContractDefinition> ? T : never;
    expectTypeOf<CallInput<D, 'shop:buy'>>().toEqualTypeOf<{ item: string; amount: number }>();
    expectTypeOf<CallOutput<D, 'shop:buy'>>().toEqualTypeOf<{ ok: boolean; balance: number }>();
    expectTypeOf<CallInput<D, 'shop:refresh'>>().toEqualTypeOf<void>();
    expectTypeOf<CallOutput<D, 'shop:refresh'>>().toEqualTypeOf<void>();
    expectTypeOf<PushData<D, 'shop:stock'>>().toEqualTypeOf<{ item: string; stock: number }>();
    expectTypeOf<ClientData<D, 'shop:preview'>>().toEqualTypeOf<{ item: string }>();
    expectTypeOf<StateData<D, 'hud'>>().toEqualTypeOf<{ health: number; cash: number }>();
  });

  it.each([
    [() => contract({ push: {} } as never), 'unknown section "push". A contract has calls, pushes, client, state and screens.'],
    [() => contract({ calls: { 'bad name': {} } }), 'calls "bad name": a name is 1 to 64 characters'],
    [() => contract({ calls: { a: { input: {} as never } } }), 'calls["a"].input must be a schema built with s'],
    [() => contract({ calls: { a: { inputs: s.int() } as never } }), 'calls["a"] has an unknown key "inputs"'],
    [() => contract({ calls: { a: s.int() as never } }), 'calls["a"] must be an object with any of: input, output, rate'],
    [() => contract({ calls: { a: { rate: { limit: 0, per: 1 } } } }), 'calls["a"].rate.limit must be a whole number from 1 to 10000, got 0'],
    [() => contract({ calls: { a: { rate: { limit: 1, per: 0 } } } }), 'calls["a"].rate.per must be a number of seconds above 0, got 0'],
    [() => contract({ pushes: { a: 'x' as never } }), 'pushes["a"] must be a schema built with s'],
    [() => contract({ state: { hud: s.int() } }), 'state["hud"] must be an s.object, because state is patched key by key'],
    [() => contract(null as never), 'contract() takes one object'],
  ])('refuses a contract it could not enforce (%#)', (build, message) => {
    expect(build).toThrow(ContractError);
    expect(build).toThrow(message);
  });

  it('types and checks the mock against the same definitions', () => {
    const built = mock(definition, {
      screens: { shop: { item: 'water' } },
      state: { hud: { health: 100 } },
      calls: {
        'shop:buy': (input, context) => {
          expectTypeOf(input).toEqualTypeOf<{ item: string; amount: number }>();
          context.push('shop:stock', { item: input.item, stock: 1 });
          context.set('hud', { cash: 5 });
          return input.amount > 3 ? reject('not_enough_stock') : { ok: true, balance: 1 };
        },
        // @ts-expect-error shop:refresh declares no output
        'shop:refresh': () => ({ total: 1 }),
      },
      client: {
        'shop:preview': (data) => expectTypeOf(data).toEqualTypeOf<{ item: string }>(),
      },
    });
    expect(built.contract).toBe(definition);
    expect(() => mock(definition, { calls: { 'shop:sell': () => undefined } as never })).toThrow(
      'mock: calls["shop:sell"] is not in the contract',
    );
    expect(() => mock({} as never, {})).toThrow('the first argument must be the default export of web/contract.ts');
    expect(() => reject('')).toThrow('the code must be a string of 1 to 64 characters');
  });
});
