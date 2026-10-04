import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { Lua, CLIENT_LUA, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    calls: {
      'shop:buy': {
        input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
        output: s.object({ ok: s.boolean() }),
        rate: { limit: 2, per: 10 },
      },
    },
    pushes: { 'shop:stock': s.object({ item: s.string(), stock: s.int({ min: 0 }) }) },
    client: { 'shop:preview': s.object({ item: s.string({ max: 40 }) }) },
    state: { hud: s.object({ health: s.int({ min: 0, max: 200 }), cash: s.int(), job: s.string() }) },
  }),
);

const SCREENS = `
NexusScreens = {
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
    radial = { layer = 'screen', mouse = true, keyboard = false, keepInput = true, escape = true },
    chatbox = { layer = 'screen', mouse = false, keyboard = true, keepInput = false, escape = false },
    toast = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false },
    hud = { layer = 'hud', mouse = true, keyboard = true, keepInput = false, escape = false },
}
`;

function messages(log: LogEntry[]): Record<string, unknown>[] {
  return log.flatMap((entry) => (entry.kind === 'nui' ? [entry.message] : []));
}

/** The focus calls in order: `[hasFocus, hasCursor]` for SetNuiFocus, `keep true` for SetNuiFocusKeepInput. */
function focus(log: LogEntry[]): unknown[] {
  const calls: unknown[] = [];
  for (const entry of log) {
    if (entry.kind === 'focus') calls.push([entry.focus, entry.cursor]);
    else if (entry.kind === 'keepInput') calls.push(`keep ${entry.keep}`);
  }
  return calls;
}

function prints(log: LogEntry[]): string[] {
  return log.flatMap((entry) => (entry.kind === 'print' ? [entry.text] : []));
}

describe('lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SCREENS);
    await lua.run(CLIENT_LUA);
  });

  afterEach(() => lua.close());

  const ready = async (): Promise<void> => {
    await lua.post({ t: 'ready' });
    await lua.drain();
  };

  describe('idle cost', () => {
    it('starts no thread when it loads, and registers one NUI callback', async () => {
      expect(await lua.threads()).toBe(0);
      expect(await lua.run('local n = 0 for _ in pairs(Sim.nui) do n = n + 1 end return n')).toBe(1);
    });

    it('starts no thread for a screen that does not keep game input', async () => {
      await ready();
      await lua.run(`Nexus.open('shop')`);
      await lua.run(`Nexus.open('hud')`);
      await lua.run(`Nexus.set('hud', { health = 100 })`);
      expect(await lua.threads()).toBe(0);
      await lua.run(`Nexus.close('shop')`);
      await lua.tick(16, 10);
      expect(await lua.threads()).toBe(0);
      expect(await lua.disabledControls()).toEqual({});
    });
  });

  describe('the ready handshake', () => {
    it('sends nothing and takes no focus until the page is ready', async () => {
      await lua.run(`Nexus.locale({ title = 'Shop' })`);
      await lua.run(`Nexus.set('hud', { health = 90, cash = 5 })`);
      await lua.run(`Nexus.open('hud')`);
      await lua.run(`Nexus.open('shop', { item = 'water' })`);
      await lua.run(`Nexus.push('shop:stock', { item = 'water', stock = 1 })`);
      expect(await lua.drain()).toEqual([]);

      await lua.post({ t: 'ready' });
      const log = await lua.drain();
      expect(log[0]).toEqual({ kind: 'nuiResponse', body: [] });
      expect(messages(log)).toEqual([
        { __nexus: 1, t: 'locale', data: { title: 'Shop' } },
        { __nexus: 1, t: 'state', name: 'hud', data: { health: 90, cash: 5 } },
        { __nexus: 1, t: 'open', screen: 'hud' },
        { __nexus: 1, t: 'open', screen: 'shop', props: { item: 'water' } },
      ]);
      expect(focus(log)).toEqual([[true, true], 'keep false']);
    });

    it('replays everything when the page reloads', async () => {
      await ready();
      await lua.run(`Nexus.open('shop', { item = 'water' })`);
      await lua.run(`Nexus.set('hud', { health = 90 })`);
      await lua.drain();
      await lua.post({ t: 'ready' });
      const log = await lua.drain();
      expect(messages(log)).toEqual([
        { __nexus: 1, t: 'state', name: 'hud', data: { health: 90 } },
        { __nexus: 1, t: 'open', screen: 'shop', props: { item: 'water' } },
      ]);
      expect(focus(log)).toEqual([]);
    });
  });

  describe('screens', () => {
    beforeEach(ready);

    it('opens, updates the props of an open screen, and closes', async () => {
      await lua.run(`Nexus.open('shop', { item = 'water' })`);
      expect(await lua.run(`return Nexus.isOpen('shop')`)).toBe(true);
      await lua.run(`Nexus.open('shop', { item = 'bread' })`);
      expect(await lua.run(`return Nexus.close('shop')`)).toBe(true);
      expect(await lua.run(`return Nexus.close('shop')`)).toBe(false);
      expect(await lua.run(`return Nexus.isOpen('shop')`)).toBe(false);
      const log = await lua.drain();
      expect(messages(log)).toEqual([
        { __nexus: 1, t: 'open', screen: 'shop', props: { item: 'water' } },
        { __nexus: 1, t: 'open', screen: 'shop', props: { item: 'bread' } },
        { __nexus: 1, t: 'close', screen: 'shop' },
      ]);
      expect(focus(log)).toEqual([[true, true], 'keep false', [false, false], 'keep false']);
    });

    it('maps the focus attribute to SetNuiFocus', async () => {
      const focusOf = async (screen: string): Promise<unknown[]> => {
        await lua.run(`Nexus.open('${screen}')`);
        const taken = focus(await lua.drain());
        await lua.run(`Nexus.close('${screen}')`);
        await lua.drain();
        return taken;
      };
      expect(await focusOf('shop')).toEqual([[true, true], 'keep false']);
      expect(await focusOf('radial')).toEqual([[true, true], 'keep true']);
      expect(await focusOf('chatbox')).toEqual([[true, false], 'keep false']);
      expect(await focusOf('toast')).toEqual([]);
      expect(await focusOf('hud')).toEqual([]);
    });

    it('gives focus to the screen opened last and hands it back when that one closes', async () => {
      await lua.run(`Nexus.open('hud')`);
      await lua.run(`Nexus.open('chatbox')`);
      await lua.run(`Nexus.open('shop')`);
      await lua.run(`Nexus.open('toast')`);
      expect(focus(await lua.drain())).toEqual([[true, false], 'keep false', [true, true], 'keep false']);

      expect(await lua.run(`return Nexus.close()`)).toBe(true);
      expect(await lua.run(`return Nexus.isOpen('shop')`)).toBe(false);
      expect(focus(await lua.drain())).toEqual([[true, false], 'keep false']);

      expect(await lua.run(`return Nexus.close()`)).toBe(true);
      expect(focus(await lua.drain())).toEqual([[false, false], 'keep false']);

      expect(await lua.run(`return Nexus.close()`)).toBe(false);
      expect(await lua.run(`return Nexus.isOpen('hud') and Nexus.isOpen('toast')`)).toBe(true);
    });

    it('runs onOpen with the props and onClose, and survives a handler that fails', async () => {
      await lua.run(`
        Events = {}
        Nexus.onOpen('shop', function() error('camera failed') end)
        Nexus.onOpen('shop', function(props) Events[#Events + 1] = 'open ' .. props.item end)
        Nexus.onClose('shop', function() Events[#Events + 1] = 'close' end)
      `);
      await lua.run(`Nexus.open('shop', { item = 'water' })`);
      await lua.run(`Nexus.open('shop', { item = 'bread' })`);
      await lua.run(`Nexus.close('shop')`);
      expect(await lua.run(`return table.concat(Events, ', ')`)).toBe('open water, close');
      const log = prints(await lua.drain());
      expect(log).toHaveLength(1);
      expect(log[0]).toContain("[nexus] an onOpen handler of 'shop' raised an error:");
      expect(log[0]).toContain('camera failed');
    });

    it('refuses a screen that does not exist', async () => {
      const message = "there is no screen 'shpo'. Screens are the .nexus files in web/screens.";
      await expect(lua.run(`Nexus.open('shpo')`)).rejects.toThrow(`Nexus.open: ${message}`);
      await expect(lua.run(`Nexus.close('shpo')`)).rejects.toThrow(`Nexus.close: ${message}`);
      await expect(lua.run(`Nexus.isOpen('shpo')`)).rejects.toThrow(`Nexus.isOpen: ${message}`);
      await expect(lua.run(`Nexus.onOpen('shpo', print)`)).rejects.toThrow(`Nexus.onOpen: ${message}`);
      await expect(lua.run(`Nexus.open('shop', 'water')`)).rejects.toThrow("Nexus.open('shop', props): props must be a table");
    });
  });

  describe('closing from the page', () => {
    beforeEach(ready);

    it('closes the named screen, or the one with focus', async () => {
      await lua.run(`Closed = 0 Nexus.onClose('shop', function() Closed = Closed + 1 end)`);
      await lua.run(`Nexus.open('chatbox') Nexus.open('shop')`);
      await lua.drain();
      await lua.post({ t: 'close' });
      expect(await lua.run(`return Nexus.isOpen('shop')`)).toBe(false);
      await lua.post({ t: 'close', screen: 'chatbox' });
      await lua.post({ t: 'close', screen: 'nope' });
      await lua.post({ t: 'close', screen: 5 });
      expect(await lua.run('return Closed')).toBe(1);
      expect(messages(await lua.drain())).toEqual([
        { __nexus: 1, t: 'close', screen: 'shop' },
        { __nexus: 1, t: 'close', screen: 'chatbox' },
      ]);
    });

    it('keeps the pause menu shut for a moment, because Escape is still held down', async () => {
      await lua.run(`Nexus.open('shop')`);
      await lua.post({ t: 'close' });
      await lua.disabledControls();
      await lua.tick(16, 10);
      expect(await lua.disabledControls()).toEqual({ '200': 10 });
      expect(await lua.threads()).toBe(1);
      await lua.tick(16, 10);
      expect(await lua.threads()).toBe(0);
    });
  });

  describe('a keep-input screen', () => {
    beforeEach(ready);

    it('disables the mouse controls and the pause menu every frame while it has focus, and stops after', async () => {
      await lua.run(`Nexus.open('radial')`);
      await lua.tick(16, 5);
      const disabled = await lua.disabledControls();
      expect(disabled['1']).toBe(5);
      expect(disabled['24']).toBe(5);
      expect(disabled['200']).toBe(5);
      expect(await lua.threads()).toBe(1);

      await lua.run(`Nexus.close('radial')`);
      await lua.tick(16, 5);
      expect(await lua.disabledControls()).toEqual({});
      expect(await lua.threads()).toBe(0);
    });

    it('runs one loop however often focus moves', async () => {
      await lua.run(`Nexus.open('radial')`);
      await lua.run(`Nexus.open('shop')`);
      await lua.run(`Nexus.close('shop')`);
      await lua.run(`Nexus.open('shop')`);
      await lua.run(`Nexus.close('shop')`);
      await lua.tick(16, 3);
      expect(await lua.threads()).toBe(1);
      await lua.disabledControls();
      await lua.tick(16);
      expect((await lua.disabledControls())['1']).toBe(1);
    });
  });

  describe('calls', () => {
    beforeEach(ready);

    it('forwards a valid call to the server under an id of its own, and the answer to the page under the page id', async () => {
      await lua.post({ t: 'call', id: 40, name: 'shop:buy', data: { item: 'water', amount: 2 } });
      await lua.post({ t: 'call', id: 41, name: 'shop:buy', data: { item: 'bread', amount: 1 } });
      expect(await lua.drain()).toEqual([
        { kind: 'nuiResponse', body: [] },
        { kind: 'serverEvent', name: 'demo:nexus:call', args: [1, 'shop:buy', { item: 'water', amount: 2 }] },
        { kind: 'nuiResponse', body: [] },
        { kind: 'serverEvent', name: 'demo:nexus:call', args: [2, 'shop:buy', { item: 'bread', amount: 1 }] },
      ]);
      await lua.trigger('demo:nexus:res', 0, 2, false, 'not_enough_money', null, { missing: 40 });
      await lua.trigger('demo:nexus:res', 0, 1, true, { ok: true });
      // An answer nobody is waiting for, or a second answer to the same call, goes nowhere.
      await lua.trigger('demo:nexus:res', 0, 1, true, { ok: true });
      await lua.trigger('demo:nexus:res', 0, 99, true, { ok: true });
      expect(messages(await lua.drain())).toEqual([
        { __nexus: 1, t: 'res', id: 41, ok: false, code: 'not_enough_money', details: { missing: 40 } },
        { __nexus: 1, t: 'res', id: 40, ok: true, data: { ok: true } },
      ]);
    });

    it('answers timeout when the server never does', async () => {
      await lua.post({ t: 'call', id: 7, name: 'shop:buy', data: { item: 'water', amount: 2 } });
      await lua.drain();
      await lua.tick(9999);
      expect(messages(await lua.drain())).toEqual([]);
      await lua.tick(1);
      expect(messages(await lua.drain())).toEqual([{ __nexus: 1, t: 'res', id: 7, ok: false, code: 'timeout' }]);
      await lua.trigger('demo:nexus:res', 0, 1, true, { ok: true });
      expect(await lua.drain()).toEqual([]);
    });

    it('answers invalid input itself, without a trip to the server', async () => {
      await lua.post({ t: 'call', id: 1, name: 'shop:buy', data: { item: 'water', amount: 0 } });
      await lua.post({ t: 'call', id: 2, name: 'shop:sell', data: {} });
      await lua.post({ t: 'call', id: 3 });
      const log = await lua.drain();
      expect(log.filter((entry) => entry.kind === 'serverEvent')).toEqual([]);
      expect(messages(log)).toEqual([
        { __nexus: 1, t: 'res', id: 1, ok: false, code: 'invalid', message: 'amount: expected at least 1' },
        { __nexus: 1, t: 'res', id: 2, ok: false, code: 'invalid', message: "'shop:sell' is not a call in web/contract.ts" },
        { __nexus: 1, t: 'res', id: 3, ok: false, code: 'invalid', message: "'nil' is not a call in web/contract.ts" },
      ]);
    });

    it('applies the rate limit before the network', async () => {
      for (let id = 1; id <= 3; id++) await lua.post({ t: 'call', id, name: 'shop:buy', data: { item: 'water', amount: 1 } });
      const log = await lua.drain();
      expect(log.filter((entry) => entry.kind === 'serverEvent')).toHaveLength(2);
      expect(messages(log)).toEqual([{ __nexus: 1, t: 'res', id: 3, ok: false, code: 'rate_limited' }]);
      await lua.tick(10000);
      await lua.post({ t: 'call', id: 4, name: 'shop:buy', data: { item: 'water', amount: 1 } });
      expect((await lua.drain()).filter((entry) => entry.kind === 'serverEvent')).toHaveLength(1);
    });

    it('ignores a body that is not a message', async () => {
      await lua.post('call');
      await lua.post({ t: 'launch' });
      await lua.post({ t: 'call', id: 'x', name: 'shop:buy' });
      await lua.post(null);
      const log = await lua.drain();
      expect(log.every((entry) => entry.kind === 'nuiResponse')).toBe(true);
      expect(log).toHaveLength(4);
    });
  });

  describe('client messages', () => {
    beforeEach(async () => {
      await ready();
      await lua.run(`
        Seen = {}
        Nexus.on('shop:preview', function(data) Seen[#Seen + 1] = data.item end)
      `);
    });

    it('reach the handlers after validation', async () => {
      await lua.post({ t: 'client', name: 'shop:preview', data: { item: 'water' } });
      await lua.post({ t: 'client', name: 'shop:preview', data: { item: 'x'.repeat(41) } });
      await lua.post({ t: 'client', name: 'shop:preview', data: { item: 'bread', admin: true } });
      await lua.post({ t: 'client', name: 'shop:nope', data: {} });
      expect(await lua.run(`return table.concat(Seen, ', ')`)).toBe('water');
      expect(prints(await lua.drain())).toEqual([]);
    });

    it('say why a message was dropped when nexus_dev is 1', async () => {
      await lua.convar('nexus_dev', 1);
      await lua.post({ t: 'client', name: 'shop:preview', data: { item: 5 } });
      await lua.post({ t: 'client', name: 'shop:nope', data: {} });
      expect(prints(await lua.drain())).toEqual([
        "[nexus] the page sent 'shop:preview' with data that does not match the contract: item: expected a string",
        "[nexus] the page sent 'shop:nope', which is not a client message in web/contract.ts",
      ]);
    });

    it('isolate a handler that fails', async () => {
      await lua.run(`Nexus.on('shop:preview', function() error('no camera') end)`);
      await lua.run(`Nexus.on('shop:preview', function(data) Seen[#Seen + 1] = 'second ' .. data.item end)`);
      await lua.post({ t: 'client', name: 'shop:preview', data: { item: 'water' } });
      expect(await lua.run(`return table.concat(Seen, ', ')`)).toBe('water, second water');
      const log = await lua.drain();
      expect(prints(log)[0]).toContain("[nexus] a handler of 'shop:preview' raised an error:");
      expect(log.some((entry) => entry.kind === 'error')).toBe(false);
    });

    it('can only be handled when they are in the contract', async () => {
      await expect(lua.run(`Nexus.on('shop:nope', print)`)).rejects.toThrow("Nexus.on: 'shop:nope' is not a client message in web/contract.ts");
      await expect(lua.run(`Nexus.on('shop:preview', 5)`)).rejects.toThrow("Nexus.on('shop:preview', handler): handler must be a function");
    });
  });

  describe('state', () => {
    beforeEach(ready);

    it('sends only the keys that changed', async () => {
      await lua.run(`Nexus.set('hud', { health = 100, cash = 50 })`);
      await lua.run(`Nexus.set('hud', { health = 100, cash = 50 })`);
      await lua.run(`Nexus.set('hud', { health = 87, cash = 50 })`);
      await lua.run(`Nexus.set('hud', { job = 'police' })`);
      expect(messages(await lua.drain())).toEqual([
        { __nexus: 1, t: 'state', name: 'hud', data: { health: 100, cash: 50 } },
        { __nexus: 1, t: 'state', name: 'hud', data: { health: 87 } },
        { __nexus: 1, t: 'state', name: 'hud', data: { job: 'police' } },
      ]);
    });

    it('is validated when nexus_dev is 1', async () => {
      await lua.run(`Nexus.set('hud', { health = 500 })`);
      expect(messages(await lua.drain())).toHaveLength(1);
      await lua.convar('nexus_dev', 1);
      await expect(lua.run(`Nexus.set('hud', { health = 900 })`)).rejects.toThrow(
        "Nexus.set('hud'): the patch does not match the contract: health: expected at most 200",
      );
      await expect(lua.run(`Nexus.set('hud', { helth = 1 })`)).rejects.toThrow('unknown key "helth"');
      expect(await lua.drain()).toEqual([]);
    });

    it('refuses a state that is not in the contract', async () => {
      await expect(lua.run(`Nexus.set('hood', {})`)).rejects.toThrow("Nexus.set: 'hood' is not a state in web/contract.ts");
      await expect(lua.run(`Nexus.set('hud', 5)`)).rejects.toThrow("Nexus.set('hud', patch): patch must be a table");
    });
  });

  describe('pushes and locale', () => {
    beforeEach(ready);

    it('forwards pushes from client Lua and from the server', async () => {
      await lua.run(`Nexus.push('shop:stock', { item = 'water', stock = 2 })`);
      await lua.trigger('demo:nexus:push', 0, 'shop:stock', { item: 'water', stock: 1 });
      expect(messages(await lua.drain())).toEqual([
        { __nexus: 1, t: 'push', name: 'shop:stock', data: { item: 'water', stock: 2 } },
        { __nexus: 1, t: 'push', name: 'shop:stock', data: { item: 'water', stock: 1 } },
      ]);
    });

    it('checks a client push against the contract', async () => {
      await expect(lua.run(`Nexus.push('shop:gone', {})`)).rejects.toThrow("Nexus.push: 'shop:gone' is not a push in web/contract.ts");
      await lua.convar('nexus_dev', 1);
      await expect(lua.run(`Nexus.push('shop:stock', { item = 'water' })`)).rejects.toThrow(
        "Nexus.push('shop:stock'): the data does not match the contract: stock: expected an integer",
      );
    });

    it('sends the locale now and again on the next ready', async () => {
      await lua.run(`Nexus.locale({ ['shop.title'] = 'Shop' })`);
      expect(messages(await lua.drain())).toEqual([{ __nexus: 1, t: 'locale', data: { 'shop.title': 'Shop' } }]);
      await expect(lua.run(`Nexus.locale('en')`)).rejects.toThrow('Nexus.locale(strings): strings must be a table');
    });
  });

  describe('when the resource stops', () => {
    beforeEach(ready);

    it('releases focus and runs the onClose handlers of open screens', async () => {
      await lua.run(`Closed = {} Nexus.onClose('shop', function() Closed[#Closed + 1] = 'shop' end)`);
      await lua.run(`Nexus.open('shop')`);
      await lua.drain();
      await lua.trigger('onResourceStop', '', 'other');
      expect(await lua.drain()).toEqual([]);
      await lua.trigger('onResourceStop', '', 'demo');
      expect(focus(await lua.drain())).toEqual([[false, false], 'keep false']);
      expect(await lua.run(`return table.concat(Closed, ', ')`)).toBe('shop');
    });

    it('leaves focus alone when it never took it', async () => {
      await lua.run(`Nexus.open('hud')`);
      await lua.drain();
      await lua.trigger('onResourceStop', '', 'demo');
      expect(await lua.drain()).toEqual([]);
    });
  });

  it('says what to do when the generated files were not loaded first', async () => {
    const bare = await Lua.create({ fivem: true });
    await expect(bare.run(CLIENT_LUA)).rejects.toThrow(
      "nexus/contract.lua and nexus/screens.lua must load before nexus/client.lua. Run 'nexus build'",
    );
    bare.close();
  });
});
