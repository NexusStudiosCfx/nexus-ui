import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { Lua, SERVER_LUA, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    calls: {
      'shop:buy': {
        input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
        output: s.object({ ok: s.boolean(), balance: s.int() }),
        rate: { limit: 3, per: 10 },
      },
      'shop:list': { output: s.array(s.string()) },
      'shop:ping': {},
    },
    pushes: { 'shop:stock': s.object({ item: s.string(), stock: s.int({ min: 0 }) }) },
  }),
);

const CALL = 'demo:nexus:call';
const RESULT = 'demo:nexus:res';

/** The answers sent to players as [player, id, ok, result or code, message], without trailing nils. */
function results(log: LogEntry[]): unknown[][] {
  return log.flatMap((entry) => {
    if (entry.kind !== 'clientEvent' || entry.name !== RESULT) return [];
    const args = [...entry.args];
    while (args[args.length - 1] === null) args.pop();
    return [[entry.target, ...args]];
  });
}

function prints(log: LogEntry[]): string[] {
  return log.flatMap((entry) => (entry.kind === 'print' ? [entry.text] : []));
}

describe('lua/server.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SERVER_LUA);
    await lua.run(`
      Seen = {}
      Nexus.handle('shop:buy', function(source, data)
          Seen[#Seen + 1] = { source = source, item = data.item, amount = data.amount }
          return { ok = true, balance = 100 - data.amount }
      end)
    `);
  });

  afterEach(() => lua.close());

  const seen = async (): Promise<unknown> => JSON.parse((await lua.run('return json.encode(Seen)')) as string);

  it('runs the handler with the validated input and answers the caller only', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:buy', { item: 'water', amount: 2 });
    expect(await seen()).toEqual([{ source: 7, item: 'water', amount: 2 }]);
    expect(results(await lua.drain())).toEqual([[7, 1, true, { ok: true, balance: 98 }]]);
  });

  it('drops a call that is not in the contract without answering', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:steal', { item: 'water' });
    await lua.trigger(CALL, 7, 2, 'toString', {});
    await lua.trigger(CALL, 7, 3, 42, {});
    await lua.trigger(CALL, 7, 4);
    expect(await lua.drain()).toEqual([]);
    expect(await seen()).toEqual([]);
  });

  it('validates the input before the handler runs', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:buy', { item: 'water', amount: 0 });
    await lua.trigger(CALL, 7, 2, 'shop:buy', { item: 'water', amount: 1, free: true });
    await lua.trigger(CALL, 7, 3, 'shop:buy', 'water');
    expect(await seen()).toEqual([]);
    expect(results(await lua.drain())).toEqual([
      [7, 1, false, 'invalid', 'amount: expected at least 1'],
      [7, 2, false, 'invalid', 'unknown key "free"'],
      [7, 3, false, 'invalid', 'expected an object'],
    ]);
  });

  it('refuses a payload that is larger than the contract allows', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:buy', { item: 'x'.repeat(100000), amount: 1 });
    expect(await seen()).toEqual([]);
    expect(results(await lua.drain())).toEqual([[7, 1, false, 'invalid', 'item: expected at most 40 characters']]);
  });

  it('takes the identity of the caller from the event, never from the payload', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:buy', { item: 'water', amount: 1, source: 1 });
    expect(await seen()).toEqual([]);
    await lua.trigger(CALL, 7, 2, 'shop:buy', { item: 'water', amount: 1 });
    expect(await seen()).toEqual([{ source: 7, item: 'water', amount: 1 }]);
  });

  it('ignores the event when it does not come from a player', async () => {
    // A local TriggerEvent on the server has an empty string as its source.
    await lua.trigger(CALL, '', 1, 'shop:buy', { item: 'water', amount: 1 });
    await lua.trigger(CALL, 0, 2, 'shop:buy', { item: 'water', amount: 1 });
    await lua.trigger(CALL, -1, 3, 'shop:buy', { item: 'water', amount: 1 });
    expect(await seen()).toEqual([]);
    expect(await lua.drain()).toEqual([]);
  });

  describe('rate limit', () => {
    const buy = (player: number, id: number): Promise<void> => lua.trigger(CALL, player, id, 'shop:buy', { item: 'water', amount: 1 });

    it('allows `limit` calls per window, per player and per call', async () => {
      await lua.run(`Nexus.handle('shop:ping', function() end)`);
      for (let id = 1; id <= 5; id++) await buy(7, id);
      await buy(8, 6);
      await lua.trigger(CALL, 7, 7, 'shop:ping');
      const outcome = results(await lua.drain()).map(([player, id, ok, code]) => [player, id, ok ? 'ok' : code]);
      expect(outcome).toEqual([
        [7, 1, 'ok'],
        [7, 2, 'ok'],
        [7, 3, 'ok'],
        [7, 4, 'rate_limited'],
        [7, 5, 'rate_limited'],
        [8, 6, 'ok'],
        [7, 7, 'ok'],
      ]);
      expect(await seen()).toHaveLength(4);
    });

    it('is a sliding window: a slot frees up exactly `per` seconds after the call that took it', async () => {
      await buy(7, 1);
      await lua.tick(4000);
      await buy(7, 2);
      await buy(7, 3);
      await buy(7, 4);
      await lua.tick(5999);
      await buy(7, 5);
      await lua.tick(1);
      await buy(7, 6);
      await buy(7, 7);
      const outcome = results(await lua.drain()).map(([, id, ok, code]) => [id, ok ? 'ok' : code]);
      expect(outcome).toEqual([
        [1, 'ok'],
        [2, 'ok'],
        [3, 'ok'],
        [4, 'rate_limited'],
        [5, 'rate_limited'],
        [6, 'ok'],
        [7, 'rate_limited'],
      ]);
    });

    it('counts invalid calls too, so validation cannot be flooded', async () => {
      for (let id = 1; id <= 4; id++) await lua.trigger(CALL, 7, id, 'shop:buy', { item: 5 });
      expect(results(await lua.drain()).map(([, , , code]) => code)).toEqual(['invalid', 'invalid', 'invalid', 'rate_limited']);
    });

    it('does not let refused calls extend the wait', async () => {
      for (let id = 1; id <= 3; id++) await buy(7, id);
      for (let id = 4; id <= 30; id++) {
        await lua.tick(300);
        await buy(7, id);
      }
      await lua.tick(1900);
      await buy(7, 31);
      const outcome = results(await lua.drain());
      expect(outcome.filter(([, , ok]) => ok).map(([, id]) => id)).toEqual([1, 2, 3, 31]);
    });

    it('forgets a player who leaves', async () => {
      for (let id = 1; id <= 4; id++) await buy(7, id);
      expect(await lua.run('return next(Sim.handlers.playerDropped) ~= nil')).toBe(true);
      await lua.trigger('playerDropped', 7, 'Quit');
      await buy(7, 5);
      const outcome = results(await lua.drain()).map(([, id, ok]) => [id, ok]);
      expect(outcome).toEqual([[1, true], [2, true], [3, true], [4, false], [5, true]]);
    });
  });

  describe('handler failures', () => {
    it('are caught, logged with the call and the player, and reach the UI as rejected', async () => {
      await lua.run(`Nexus.handle('shop:list', function() error('database is down') end)`);
      await lua.trigger(CALL, 7, 1, 'shop:list');
      const log = await lua.drain();
      expect(results(log)).toEqual([[7, 1, false, 'rejected']]);
      expect(prints(log)).toHaveLength(1);
      expect(prints(log)[0]).toContain("[nexus] the handler of 'shop:list' raised an error for player 7:");
      expect(prints(log)[0]).toContain('database is down');
      expect(log.some((entry) => entry.kind === 'error')).toBe(false);
    });

    it('do not affect the next call', async () => {
      await lua.run(`
        local calls = 0
        Nexus.handle('shop:list', function()
            calls = calls + 1
            if calls == 1 then error({ code = 'not a string' }) end
            return { 'water' }
        end)
      `);
      await lua.trigger(CALL, 7, 1, 'shop:list');
      await lua.trigger(CALL, 7, 2, 'shop:list');
      expect(results(await lua.drain())).toEqual([
        [7, 1, false, 'rejected'],
        [7, 2, true, ['water']],
      ]);
    });

    it('are caught when the handler fails after waiting', async () => {
      await lua.run(`Nexus.handle('shop:list', function() Wait(50) error('late failure') end)`);
      await lua.trigger(CALL, 7, 1, 'shop:list');
      expect(results(await lua.drain())).toEqual([]);
      await lua.tick(50);
      const log = await lua.drain();
      expect(results(log)).toEqual([[7, 1, false, 'rejected']]);
      expect(prints(log)[0]).toContain('late failure');
    });
  });

  it('answers after a handler that waits, to the player who called', async () => {
    await lua.run(`Nexus.handle('shop:list', function(source) Wait(100) return { 'for ' .. source } end)`);
    await lua.trigger(CALL, 7, 1, 'shop:list');
    await lua.trigger(CALL, 8, 1, 'shop:list');
    await lua.tick(100);
    expect(results(await lua.drain())).toEqual([
      [7, 1, true, ['for 7']],
      [8, 1, true, ['for 8']],
    ]);
  });

  it('turns Nexus.reject into the code the handler chose', async () => {
    await lua.run(`Nexus.handle('shop:list', function() return Nexus.reject('not_enough_money') end)`);
    await lua.trigger(CALL, 7, 1, 'shop:list');
    expect(results(await lua.drain())).toEqual([[7, 1, false, 'not_enough_money']]);
    await expect(lua.run(`Nexus.reject('')`)).rejects.toThrow('Nexus.reject(code): code must be a string of 1 to 64 characters');
    await expect(lua.run(`Nexus.reject(404)`)).rejects.toThrow('Nexus.reject(code)');
  });

  it('answers rejected and says so once when a call has no handler', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:ping');
    await lua.trigger(CALL, 7, 2, 'shop:ping');
    const log = await lua.drain();
    expect(results(log)).toEqual([[7, 1, false, 'rejected'], [7, 2, false, 'rejected']]);
    expect(prints(log)).toEqual([
      "[nexus] call 'shop:ping' has no handler. Add Nexus.handle('shop:ping', function(source, data) ... end) to a server script.",
    ]);
  });

  describe('output', () => {
    beforeEach(() => lua.run(`Nexus.handle('shop:list', function() return { 1, 2 } end)`));

    it('is sent as it is in production', async () => {
      await lua.trigger(CALL, 7, 1, 'shop:list');
      const log = await lua.drain();
      expect(results(log)).toEqual([[7, 1, true, [1, 2]]]);
      expect(prints(log)).toEqual([]);
    });

    it('is validated when nexus_dev is 1', async () => {
      await lua.convar('nexus_dev', 1);
      await lua.trigger(CALL, 7, 1, 'shop:list');
      const log = await lua.drain();
      expect(results(log)).toEqual([[7, 1, false, 'rejected']]);
      expect(prints(log)).toEqual([
        "[nexus] the handler of 'shop:list' returned something that does not match the contract: [1]: expected a string",
      ]);
    });
  });

  it('logs refused input only when nexus_dev is 1, so a flood cannot fill the console', async () => {
    await lua.trigger(CALL, 7, 1, 'shop:buy', {});
    expect(prints(await lua.drain())).toEqual([]);
    await lua.convar('nexus_dev', 1);
    await lua.trigger(CALL, 7, 2, 'shop:buy', {});
    expect(prints(await lua.drain())).toEqual(["[nexus] call 'shop:buy' from player 7 was refused: item: expected a string"]);
  });

  describe('Nexus.handle', () => {
    it.each([
      [`Nexus.handle('shop:sell', function() end)`, "Nexus.handle: 'shop:sell' is not a call in web/contract.ts"],
      [`Nexus.handle('shop:list', 'nope')`, "Nexus.handle('shop:list', handler): handler must be a function"],
      [`Nexus.handle('shop:buy', function() end)`, "Nexus.handle: 'shop:buy' already has a handler"],
    ])('refuses %s', async (code, message) => {
      await expect(lua.run(code)).rejects.toThrow(message);
    });
  });

  describe('Nexus.push', () => {
    it('sends to one player or to everyone', async () => {
      await lua.run(`Nexus.push(7, 'shop:stock', { item = 'water', stock = 2 })`);
      await lua.run(`Nexus.push(-1, 'shop:stock', { item = 'water', stock = 1 })`);
      expect(await lua.drain()).toEqual([
        { kind: 'clientEvent', name: 'demo:nexus:push', target: 7, args: ['shop:stock', { item: 'water', stock: 2 }] },
        { kind: 'clientEvent', name: 'demo:nexus:push', target: -1, args: ['shop:stock', { item: 'water', stock: 1 }] },
      ]);
    });

    it('refuses a push that is not in the contract, and a missing target', async () => {
      await expect(lua.run(`Nexus.push(7, 'shop:gone', {})`)).rejects.toThrow("Nexus.push: 'shop:gone' is not a push in web/contract.ts");
      await expect(lua.run(`Nexus.push('shop:stock', {})`)).rejects.toThrow('is not a push in web/contract.ts');
      await expect(lua.run(`Nexus.push('7', 'shop:stock', {})`)).rejects.toThrow('source must be a player id, or -1 for everyone');
    });

    it('validates the data when nexus_dev is 1', async () => {
      await lua.run(`Nexus.push(7, 'shop:stock', { item = 'water', stock = -1 })`);
      expect(await lua.drain()).toHaveLength(1);
      await lua.convar('nexus_dev', 1);
      await expect(lua.run(`Nexus.push(7, 'shop:stock', { item = 'water', stock = -1 })`)).rejects.toThrow(
        "Nexus.push('shop:stock'): the data does not match the contract: stock: expected at least 0",
      );
      expect(await lua.drain()).toEqual([]);
    });
  });

  it('says what to do when the contract was not loaded first', async () => {
    const bare = await Lua.create({ fivem: true });
    await expect(bare.run(SERVER_LUA)).rejects.toThrow("nexus/contract.lua must load before nexus/server.lua. Run 'nexus build'");
    bare.close();
  });
});
