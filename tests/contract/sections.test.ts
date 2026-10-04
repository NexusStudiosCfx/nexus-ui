import { describe, expect, expectTypeOf, it } from 'vitest';
import { contract, ContractError, generateLua, generateTypes, mock, reject, s } from '../../src/contract';
import type { CallError, Contract, ContractDefinition, Infer, ScreenData } from '../../src/contract';
import { Lua } from '../support/lua';

const garage = contract({
  calls: {
    'garage:buy': {
      input: s.object({ model: s.string({ max: 24 }) }),
      output: s.object({ balance: s.int({ min: 0 }) }),
      errors: {
        not_enough_money: s.object({ missing: s.int({ min: 1 }) }),
        needs: s.object({ items: s.array(s.string(), { min: 1, max: 8 }) }),
      },
    },
    'garage:meta': { input: s.json({ maxBytes: 256 }), output: s.union(s.string(), s.object({ ok: s.boolean() })) },
  },
  screens: {
    garage: s.object({ player: s.string({ max: 64 }), tab: s.optional(s.enum(['all', 'owned'])) }),
  },
});

type Definition = typeof garage extends Contract<infer D extends ContractDefinition> ? D : never;

describe('s.union, s.json and the minimum of s.array', () => {
  it('infer their types', () => {
    const shape = s.union(s.object({ kind: s.literal('car'), plate: s.string() }), s.object({ kind: s.literal('boat') }), s.int());
    expectTypeOf<Infer<typeof shape>>().toEqualTypeOf<{ kind: 'car'; plate: string } | { kind: 'boat' } | number>();
    expectTypeOf<Infer<ReturnType<typeof s.json>>>().toEqualTypeOf<unknown>();
  });

  it.each([
    [() => (s.union as (...members: unknown[]) => unknown)(s.string()), 's.union: pass at least two schemas'],
    [() => s.union(s.string(), s.optional(s.int())), 's.union: member 2 cannot be optional. Wrap the union itself instead: s.optional(s.union(...)).'],
    [() => s.union(s.string(), 5 as never), 's.union: member 2 must be a schema built with s, got number 5'],
    [() => s.array(s.int(), { min: 5, max: 2 }), 's.array: min (5) is greater than max (2)'],
    [() => s.array(s.int(), { min: -1 }), 's.array: min must be a whole number of 0 or more, got -1'],
    [() => s.json({ maxBytes: 1.5 }), 's.json: maxBytes must be a whole number of 0 or more, got 1.5'],
  ])('refuse what cannot be enforced (%#)', (build, message) => {
    expect(build).toThrow(ContractError);
    expect(build).toThrow(message);
  });

  it('have defaults that bound loose data', () => {
    expect(s.json()).toMatchObject({ maxBytes: 4096, maxDepth: 8 });
    expect(s.array(s.int())).toMatchObject({ min: 0, max: 256 });
  });
});

describe('errors and screens in a contract', () => {
  it('keep the details of each refusal and the props of each screen for type inference', () => {
    expectTypeOf<CallError<Definition, 'garage:buy'>>().toEqualTypeOf<
      { code: 'not_enough_money'; details: { missing: number } } | { code: 'needs'; details: { items: string[] } }
    >();
    expectTypeOf<CallError<Definition, 'garage:meta'>>().toEqualTypeOf<never>();
    expectTypeOf<ScreenData<Definition, 'garage'>>().toEqualTypeOf<{ player: string; tab?: 'all' | 'owned' | undefined }>();
  });

  it.each([
    [() => contract({ calls: { a: { errors: s.int() as never } } }), 'calls["a"].errors must map a code to the schema of its details'],
    [() => contract({ calls: { a: { errors: { 'bad code': s.int() } } } }), 'calls["a"].errors "bad code": a name is 1 to 64 characters'],
    [() => contract({ calls: { a: { errors: { late: 5 as never } } } }), 'calls["a"].errors["late"] must be a schema built with s'],
    [() => contract({ screens: { shop: s.string() } }), 'screens["shop"] must be an s.object, because the props of a screen are an object'],
  ])('refuse a definition that cannot be enforced (%#)', (build, message) => {
    expect(build).toThrow(ContractError);
    expect(build).toThrow(message);
  });

  it('are written into the declarations', () => {
    const types = generateTypes(garage);
    expect(types).toContain(`      'garage:buy': {
        input: { model: string };
        output: { balance: number };
        errors: {
          not_enough_money: { missing: number };
          needs: { items: string[] };
        };
      };
      'garage:meta': {
        input: unknown;
        output: string | { ok: boolean };
      };`);
    expect(types).toContain(`    screens: {
      garage: { player: string; tab?: 'all' | 'owned' };
    };`);
  });

  it('are written into the Lua, which validates them', async () => {
    const lua = await Lua.create();
    await lua.run(generateLua(garage));
    const check = (expression: string, value: unknown): Promise<unknown> =>
      lua.call(`local ok, problem = NexusContract.${expression}(...) return ok and 'ok' or problem`, value);

    expect(await check("calls['garage:buy'].errors.not_enough_money", { missing: 40 })).toBe('ok');
    expect(await check("calls['garage:buy'].errors.not_enough_money", { missing: 0 })).toBe('missing: expected at least 1');
    expect(await check("calls['garage:buy'].errors.needs", { items: [] })).toBe('items: expected at least 1 item');
    expect(await lua.run(`return next(NexusContract.calls['garage:meta'].errors) == nil`)).toBe(true);
    expect(await check('screens.garage', { player: 'Ada', tab: 'owned' })).toBe('ok');
    expect(await check('screens.garage', { player: 'Ada', tab: 'mine' })).toBe('tab: expected one of "all", "owned"');
    expect(await check("calls['garage:meta'].input", { any: ['thing', 1, true] })).toBe('ok');
    expect(await check("calls['garage:meta'].output", { ok: true })).toBe('ok');
    expect(await check("calls['garage:meta'].output", { ok: 1 })).toBe('expected a value that matches one of the allowed shapes');
    lua.close();
  });

  it('share one function between unions that have the same member, and nest', async () => {
    const point = s.object({ x: s.int() });
    const nested = s.union(s.array(s.union(point, s.string())), point);
    const text = generateLua(contract({ pushes: { a: nested, b: s.union(point, s.string()) } }));
    expect(text.match(/^unions\[\d+\] = function/gm)).toHaveLength(3);
    const lua = await Lua.create();
    await lua.run(text);
    expect(await lua.call(`return (NexusContract.pushes.a(...))`, [{ x: 1 }, 'two'])).toBe(true);
    expect(await lua.call(`return (NexusContract.pushes.a(...))`, [{ x: 1 }, 2])).toBe(false);
    lua.close();
  });

  it('type the mock: details on a rejection and props for the screens it lists', () => {
    mock(garage, {
      screens: {
        // @ts-expect-error tab is 'all' or 'owned'
        garage: { player: 'Ada', tab: 'mine' },
        // A screen the contract does not list takes anything.
        other: { anything: true },
      },
      calls: {
        'garage:buy': () => reject('not_enough_money', { missing: 40 }),
      },
      setup: ({ action, unset }) => {
        expectTypeOf(action).toEqualTypeOf<(label: string, run: () => void) => () => void>();
        expectTypeOf(unset).toBeFunction();
      },
    });
    expect(reject('needs', { items: ['keys'] })).toEqual({ nexusRejection: 'needs', details: { items: ['keys'] } });
    expect(reject('banned')).toEqual({ nexusRejection: 'banned' });
  });
});
