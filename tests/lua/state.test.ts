import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { CLIENT_LUA, Lua, SERVER_LUA, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    state: {
      death: s.object({
        stage: s.enum(['ok', 'down', 'dead']),
        timer: s.optional(s.int({ min: 0 })),
        wounds: s.optional(s.array(s.object({ part: s.string(), severity: s.int() }))),
      }),
      job: s.object({ name: s.string(), grade: s.int({ min: 0 }) }),
    },
    screens: {
      shop: s.object({ item: s.string({ max: 40 }), price: s.int({ min: 0 }) }),
    },
  }),
);

const SCREENS = `
NexusScreens = {
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
    notice = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false },
}
`;

function messages(log: LogEntry[]): Record<string, unknown>[] {
  return log.flatMap((entry) => (entry.kind === 'nui' ? [entry.message] : []));
}

describe('state in lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SCREENS);
    await lua.run(CLIENT_LUA);
    await lua.post({ t: 'ready' });
    await lua.drain();
  });

  afterEach(() => lua.close());

  it('compares tables by content, so the same value set twice is sent once', async () => {
    await lua.run(`Nexus.set('death', { stage = 'ok', wounds = { { part = 'leg', severity = 2 } } })`);
    await lua.run(`Nexus.set('death', { stage = 'ok', wounds = { { part = 'leg', severity = 2 } } })`);
    await lua.run(`Nexus.set('death', { wounds = { { part = 'leg', severity = 3 } } })`);
    await lua.run(`Nexus.set('death', { wounds = { { part = 'leg', severity = 3 }, { part = 'arm', severity = 1 } } })`);
    await lua.run(`Nexus.set('death', { wounds = { { part = 'leg', severity = 3 } } })`);
    expect(messages(await lua.drain())).toEqual([
      { __nexus: 1, t: 'state', name: 'death', data: { stage: 'ok', wounds: [{ part: 'leg', severity: 2 }] } },
      { __nexus: 1, t: 'state', name: 'death', data: { wounds: [{ part: 'leg', severity: 3 }] } },
      { __nexus: 1, t: 'state', name: 'death', data: { wounds: [{ part: 'leg', severity: 3 }, { part: 'arm', severity: 1 }] } },
      { __nexus: 1, t: 'state', name: 'death', data: { wounds: [{ part: 'leg', severity: 3 }] } },
    ]);
  });

  it('remembers a copy, so a table the caller changes afterwards is seen as changed', async () => {
    await lua.run(`
      Wounds = { { part = 'leg', severity = 2 } }
      Nexus.set('death', { wounds = Wounds })
      Wounds[1].severity = 5
      Nexus.set('death', { wounds = Wounds })
    `);
    expect(messages(await lua.drain()).map((message) => message.data)).toEqual([
      { wounds: [{ part: 'leg', severity: 2 }] },
      { wounds: [{ part: 'leg', severity: 5 }] },
    ]);
  });

  it('removes keys with Nexus.unset, once', async () => {
    await lua.run(`Nexus.set('death', { stage = 'down', timer = 30 })`);
    await lua.drain();
    await lua.run(`Nexus.unset('death', 'timer', 'wounds')`);
    await lua.run(`Nexus.unset('death', 'timer')`);
    expect(messages(await lua.drain())).toEqual([{ __nexus: 1, t: 'state', name: 'death', removed: ['timer'] }]);
    await expect(lua.run(`Nexus.unset('helth', 'x')`)).rejects.toThrow("Nexus.unset: 'helth' is not a state in web/contract.ts");
  });

  it('tells a page that is brought up to date which keys are gone, until they are set again', async () => {
    await lua.run(`Nexus.set('death', { stage = 'down', timer = 30, wounds = { { part = 'leg', severity = 2 } } })`);
    await lua.run(`Nexus.unset('death', 'wounds', 'timer')`);
    await lua.drain();

    // A page that was kept while it missed the message still holds both keys.
    await lua.post({ t: 'ready' });
    expect(messages(await lua.drain())).toEqual([{ __nexus: 1, t: 'state', name: 'death', data: { stage: 'down' }, removed: ['timer', 'wounds'] }]);

    await lua.run(`Nexus.set('death', { timer = 5 })`);
    await lua.run(`Nexus.unset('death', 'stage')`);
    await lua.drain();
    await lua.post({ t: 'ready' });
    expect(messages(await lua.drain())).toEqual([{ __nexus: 1, t: 'state', name: 'death', data: { timer: 5 }, removed: ['stage', 'wounds'] }]);
  });

  it('applies a state the server set, as its own Nexus.set would', async () => {
    await lua.trigger('demo:nexus:state', 0, 'job', { name: 'police', grade: 2 });
    await lua.trigger('demo:nexus:state', 0, 'job', { name: 'police', grade: 3 });
    await lua.trigger('demo:nexus:state', 0, 'job', null, ['grade']);
    await lua.trigger('demo:nexus:state', 0, 'nope', { name: 'x' });
    expect(messages(await lua.drain())).toEqual([
      { __nexus: 1, t: 'state', name: 'job', data: { name: 'police', grade: 2 } },
      { __nexus: 1, t: 'state', name: 'job', data: { grade: 3 } },
      { __nexus: 1, t: 'state', name: 'job', removed: ['grade'] },
    ]);
  });

  it('validates the props of a screen against the contract when nexus_dev is 1', async () => {
    await lua.run(`Nexus.open('shop', { item = 'water', price = -1 })`);
    await lua.run(`Nexus.close('shop')`);
    await lua.convar('nexus_dev', 1);
    await expect(lua.run(`Nexus.open('shop', { item = 'water', price = -1 })`)).rejects.toThrow(
      "Nexus.open('shop'): the props do not match the contract: price: expected at least 0",
    );
    await expect(lua.run(`Nexus.open('shop')`)).rejects.toThrow('item: expected a string');
    expect(await lua.run(`return Nexus.isOpen('shop')`)).toBe(false);
    await lua.run(`Nexus.open('shop', { item = 'water', price = 5 })`);
    // A screen the contract does not list takes whatever it is given.
    await lua.run(`Nexus.open('notice', { anything = true })`);
    expect(await lua.run(`return Nexus.isOpen('shop') and Nexus.isOpen('notice')`)).toBe(true);
  });
});

describe('state in lua/server.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SERVER_LUA);
  });

  afterEach(() => lua.close());

  it('sets and unsets a state for one player or for everyone', async () => {
    await lua.run(`Nexus.set(7, 'job', { name = 'police', grade = 2 })`);
    await lua.run(`Nexus.set(-1, 'death', { stage = 'ok' })`);
    await lua.run(`Nexus.unset(7, 'job', 'grade')`);
    expect(await lua.drain()).toEqual([
      { kind: 'clientEvent', name: 'demo:nexus:state', target: 7, args: ['job', { name: 'police', grade: 2 }] },
      { kind: 'clientEvent', name: 'demo:nexus:state', target: -1, args: ['death', { stage: 'ok' }] },
      { kind: 'clientEvent', name: 'demo:nexus:state', target: 7, args: ['job', null, ['grade']] },
    ]);
  });

  it('refuses a state that is not in the contract, a missing target and, in dev mode, a patch that does not fit', async () => {
    await expect(lua.run(`Nexus.set(7, 'jbo', {})`)).rejects.toThrow("Nexus.set: 'jbo' is not a state in web/contract.ts");
    await expect(lua.run(`Nexus.set('job', { name = 'x' })`)).rejects.toThrow('is not a state in web/contract.ts');
    await expect(lua.run(`Nexus.set('7', 'job', {})`)).rejects.toThrow('Nexus.set(source, name, patch): source must be a player id, or -1 for everyone');
    await expect(lua.run(`Nexus.set(7, 'job', 'police')`)).rejects.toThrow("Nexus.set(source, 'job', patch): patch must be a table");
    await expect(lua.run(`Nexus.unset(7, 'jbo', 'x')`)).rejects.toThrow("Nexus.unset: 'jbo' is not a state in web/contract.ts");
    await lua.run(`Nexus.set(7, 'job', { grade = -1 })`);
    await lua.convar('nexus_dev', 1);
    await expect(lua.run(`Nexus.set(7, 'job', { grade = -1 })`)).rejects.toThrow(
      "Nexus.set('job'): the patch does not match the contract: grade: expected at least 0",
    );
  });
});
