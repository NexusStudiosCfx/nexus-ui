import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { CLIENT_LUA, Lua, SERVER_LUA, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    calls: {
      'garage:buy': {
        input: s.object({ model: s.string({ max: 24 }) }),
        output: s.object({ balance: s.int({ min: 0 }) }),
        rate: { limit: 2, per: 10 },
        errors: {
          not_enough_money: s.object({ missing: s.int({ min: 1 }) }),
          needs: s.object({ items: s.array(s.string(), { min: 1, max: 8 }) }),
        },
      },
      'garage:ping': {},
    },
  }),
);

const CALL = 'demo:nexus:call';
const RESULT = 'demo:nexus:res';

function serverEvents(log: LogEntry[]): unknown[][] {
  return log.flatMap((entry) => (entry.kind === 'serverEvent' ? [entry.args] : []));
}

function answers(log: LogEntry[]): unknown[][] {
  return log.flatMap((entry) => {
    if (entry.kind !== 'clientEvent' || entry.name !== RESULT) return [];
    const args = [...entry.args];
    while (args[args.length - 1] === null) args.pop();
    return [args];
  });
}

describe('Nexus.call in lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run('NexusScreens = {}');
    await lua.run(CLIENT_LUA);
    await lua.run('Seen = {}');
  });

  afterEach(() => lua.close());

  const seen = async (): Promise<unknown> => JSON.parse((await lua.run('return json.encode(Seen)')) as string);

  it('sends the call to the server and hands the answer to the callback', async () => {
    await lua.run(`Nexus.call('garage:buy', { model = 'sultan' }, function(result, problem) Seen[#Seen + 1] = { result = result, problem = problem } end)`);
    expect(serverEvents(await lua.drain())).toEqual([[1, 'garage:buy', { model: 'sultan' }]]);
    await lua.trigger(RESULT, 0, 1, true, { balance: 100 });
    expect(await seen()).toEqual([{ result: { balance: 100 } }]);
  });

  it('waits for the answer when it is given no callback and runs in a thread', async () => {
    await lua.run(`
      Sim.run(function()
          local result, problem = Nexus.call('garage:buy', { model = 'sultan' })
          Seen[#Seen + 1] = { result = result, problem = problem }
          result, problem = Nexus.call('garage:buy', { model = 'banshee' })
          Seen[#Seen + 1] = { result = result, problem = problem }
      end)
    `);
    expect(await seen()).toEqual([]);
    await lua.trigger(RESULT, 0, 1, true, { balance: 100 });
    await lua.trigger(RESULT, 0, 2, false, 'not_enough_money', null, { missing: 40 });
    expect(await seen()).toEqual([{ result: { balance: 100 } }, { problem: { code: 'not_enough_money', details: { missing: 40 } } }]);
    expect((await lua.drain()).some((entry) => entry.kind === 'error')).toBe(false);
  });

  it('refuses invalid input and a call over the limit without a trip to the server', async () => {
    await lua.run(`
      local function note(result, problem) Seen[#Seen + 1] = problem end
      Nexus.call('garage:buy', { model = 5 }, note)
      Nexus.call('garage:buy', { model = 'a' }, note)
      Nexus.call('garage:buy', { model = 'b' }, note)
    `);
    expect(await seen()).toEqual([{ code: 'invalid', message: 'model: expected a string' }, { code: 'rate_limited' }]);
    expect(serverEvents(await lua.drain())).toHaveLength(1);
  });

  it('gives up after ten seconds', async () => {
    await lua.run(`Nexus.call('garage:ping', nil, function(result, problem) Seen[#Seen + 1] = problem end)`);
    await lua.tick(10000);
    expect(await seen()).toEqual([{ code: 'timeout' }]);
    await lua.trigger(RESULT, 0, 1, true);
    expect(await seen()).toHaveLength(1);
  });

  it('isolates a callback that raises an error', async () => {
    await lua.run(`Nexus.call('garage:ping', nil, function() error('no garage here') end)`);
    await lua.trigger(RESULT, 0, 1, true);
    const log = await lua.drain();
    const printed = log.flatMap((entry) => (entry.kind === 'print' ? [entry.text] : []));
    expect(printed[0]).toContain("[nexus] the callback of Nexus.call('garage:ping') raised an error:");
    expect(log.some((entry) => entry.kind === 'error')).toBe(false);
  });

  it('only takes calls that are in the contract', async () => {
    await expect(lua.run(`Nexus.call('garage:steal', {})`)).rejects.toThrow("Nexus.call: 'garage:steal' is not a call in web/contract.ts");
    await expect(lua.run(`Nexus.call('garage:ping', nil, 'later')`)).rejects.toThrow("Nexus.call('garage:ping', data, callback): callback must be a function");
  });
});

describe('refusals with details in lua/server.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SERVER_LUA);
    await lua.run(`
      Nexus.handle('garage:buy', function(source, data)
          if data.model == 'zentorno' then return Nexus.reject('not_enough_money', { missing = 40 }) end
          if data.model == 'wrong' then return Nexus.reject('not_enough_money', { missing = 'a lot' }) end
          if data.model == 'undeclared' then return Nexus.reject('banned', { reason = 'x' }) end
          if data.model == 'plain' then return Nexus.reject('banned') end
          return Nexus.reject('needs', { items = { 'keys', 'licence' } })
      end)
    `);
  });

  afterEach(() => lua.close());

  const buy = async (id: number, player: number, model: string): Promise<LogEntry[]> => {
    await lua.trigger(CALL, player, id, 'garage:buy', { model });
    return lua.drain();
  };

  it('reach the caller with the code', async () => {
    expect(answers(await buy(1, 7, 'zentorno'))).toEqual([[1, false, 'not_enough_money', null, { missing: 40 }]]);
    expect(answers(await buy(2, 7, 'sultan'))).toEqual([[2, false, 'needs', null, { items: ['keys', 'licence'] }]]);
    expect(answers(await buy(3, 8, 'plain'))).toEqual([[3, false, 'banned']]);
  });

  it('are not checked in production', async () => {
    expect(answers(await buy(1, 7, 'wrong'))).toEqual([[1, false, 'not_enough_money', null, { missing: 'a lot' }]]);
  });

  it('are checked against the contract when nexus_dev is 1', async () => {
    await lua.convar('nexus_dev', 1);
    const wrong = await buy(1, 7, 'wrong');
    expect(answers(wrong)).toEqual([[1, false, 'rejected']]);
    expect(wrong).toContainEqual({
      kind: 'print',
      text: "[nexus] the handler of 'garage:buy' returned details with 'not_enough_money' that do not match the contract: missing: expected an integer",
    });
    const undeclared = await buy(2, 7, 'undeclared');
    expect(answers(undeclared)).toEqual([[2, false, 'rejected']]);
    expect(undeclared).toContainEqual({
      kind: 'print',
      text: "[nexus] the handler of 'garage:buy' returned details with 'banned', which the call does not declare under errors",
    });
    expect(answers(await buy(3, 8, 'zentorno'))).toEqual([[3, false, 'not_enough_money', null, { missing: 40 }]]);
  });
});

describe('what the runtimes log', () => {
  it('never says "failed", which log scanners read as a fatal error', async () => {
    const lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SERVER_LUA);
    await lua.run(`Nexus.handle('garage:ping', function() error('database is down') end)`);
    await lua.trigger(CALL, 7, 1, 'garage:ping');
    const printed = (await lua.drain()).flatMap((entry) => (entry.kind === 'print' ? [entry.text] : []));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("[nexus] the handler of 'garage:ping' raised an error for player 7:");
    expect(printed[0]).toContain('database is down');
    lua.close();

    for (const source of [SERVER_LUA, CLIENT_LUA]) expect(source).not.toMatch(/failed|\[ERROR\]|Error:/);
  });
});
