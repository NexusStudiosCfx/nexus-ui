import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { CLIENT_LUA, Lua, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    calls: { 'garage:list': { output: s.array(s.string()) } },
    pushes: { 'garage:balance': s.object({ balance: s.int() }) },
    client: { 'garage:waypoint': s.object({ model: s.string() }) },
    state: { garage: s.object({ count: s.int() }) },
  }),
);

const SCREENS = `
NexusScreens = {
    garage = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
    garagePhone = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'phone' },
    garageTablet = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'tablet' },
}
`;

const PHONE = `Nexus.app('phone', { identifier = 'garage', name = 'Garage', description = 'Your vehicles', icon = 'web/dist/icon.png', defaultApp = true })`;
const TABLET = `Nexus.app('tablet', { name = 'Garage', icon = 'web/dist/icon.png', developer = 'Demo' })`;

type AppMessage = Extract<LogEntry, { kind: 'appMessage' }>;

function appMessages(log: LogEntry[]): [string, ...unknown[]][] {
  return log.flatMap((entry) => (entry.kind === 'appMessage' ? [[entry.resource, ...(entry as AppMessage).args] as [string, ...unknown[]]] : []));
}

describe('LB Phone and LB Tablet apps in lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SCREENS);
    await lua.run(CLIENT_LUA);
  });

  afterEach(() => lua.close());

  it('does nothing and says nothing when LB is not on the server', async () => {
    await lua.run(PHONE);
    await lua.run(TABLET);
    await lua.tick(1000, 6);
    expect(await lua.drain()).toEqual([]);
    expect(await lua.threads()).toBe(0);
  });

  it('registers the app with the page, the icon and the options each LB expects', async () => {
    await lua.run(`Sim.startLB('lb-phone') Sim.startLB('lb-tablet')`);
    await lua.run(PHONE);
    await lua.run(TABLET);
    expect(await lua.drain()).toEqual([
      {
        kind: 'addApp',
        resource: 'lb-phone',
        app: {
          identifier: 'garage',
          name: 'Garage',
          description: 'Your vehicles',
          defaultApp: true,
          fixBlur: true,
          ui: 'demo/web/dist/index.html?surface=phone&resource=demo',
          icon: 'https://cfx-nui-demo/web/dist/icon.png',
        },
      },
      {
        kind: 'addApp',
        resource: 'lb-tablet',
        app: {
          identifier: 'demo',
          name: 'Garage',
          developer: 'Demo',
          ui: 'web/dist/index.html?surface=tablet&resource=demo',
          icon: '/web/dist/icon.png',
        },
      },
    ]);
  });

  it('registers when LB starts later, and again when it restarts', async () => {
    await lua.run(PHONE);
    await lua.run(`Sim.startLB('lb-phone')`);
    await lua.trigger('onClientResourceStart', '', 'lb-phone');
    await lua.trigger('onClientResourceStart', '', 'some-other-resource');
    expect((await lua.drain()).map((entry) => entry.kind)).toEqual(['addApp']);

    await lua.run(`Sim.startLB('lb-phone')`);
    await lua.trigger('onClientResourceStart', '', 'lb-phone');
    expect((await lua.drain()).map((entry) => entry.kind)).toEqual(['addApp']);
  });

  it('retries while the exports of LB are not there yet, then says what happened', async () => {
    await lua.run(`Sim.resources['lb-phone'] = 'started'`);
    await lua.run(PHONE);
    await lua.tick(1000, 2);
    await lua.run(`Sim.startLB('lb-phone')`);
    await lua.tick(1000);
    expect((await lua.drain()).map((entry) => entry.kind)).toEqual(['addApp']);

    await lua.run(`Sim.resources['lb-tablet'] = 'started'`);
    await lua.run(TABLET);
    await lua.tick(1000, 6);
    const log = await lua.drain();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'print' });
    expect((log[0] as { text: string }).text).toContain("[nexus] lb-tablet did not add the app 'demo':");
  });

  it('replaces an app that a previous run of the resource left behind', async () => {
    await lua.run(`Sim.startLB('lb-phone')`);
    await lua.run(`exports['lb-phone']:AddCustomApp({ identifier = 'garage', name = 'Old' })`);
    await lua.drain();
    await lua.run(PHONE);
    expect((await lua.drain()).map((entry) => entry.kind)).toEqual(['removeApp', 'addApp']);
  });

  describe('with both apps registered', () => {
    beforeEach(async () => {
      await lua.run(`Sim.startLB('lb-phone') Sim.startLB('lb-tablet')`);
      await lua.run(PHONE);
      await lua.run(TABLET);
      await lua.run(`Nexus.locale({ title = 'Garage' }) Nexus.set('garage', { count = 2 })`);
      await lua.drain();
    });

    it('brings an app up to date when its page says ready, through the export of its LB', async () => {
      await lua.post({ t: 'ready', surface: 'phone' });
      await lua.post({ t: 'ready', surface: 'tablet' });
      expect(appMessages(await lua.drain())).toEqual([
        ['lb-phone', { __nexus: 1, t: 'locale', data: { title: 'Garage' } }],
        ['lb-phone', { __nexus: 1, t: 'state', name: 'garage', data: { count: 2 } }],
        ['lb-tablet', 'nexus', { __nexus: 1, t: 'locale', data: { title: 'Garage' } }],
        ['lb-tablet', 'nexus', { __nexus: 1, t: 'state', name: 'garage', data: { count: 2 } }],
      ]);
      expect(await lua.run(`return Nexus.isOpen('garagePhone') and Nexus.isOpen('garageTablet')`)).toBe(true);
    });

    it('answers a call to the surface that asked, and only that one', async () => {
      await lua.post({ t: 'ready' });
      await lua.post({ t: 'ready', surface: 'phone' });
      await lua.post({ t: 'ready', surface: 'tablet' });
      await lua.drain();
      // The three pages count their calls from 1, each on its own.
      await lua.post({ t: 'call', id: 1, name: 'garage:list', surface: 'phone' });
      await lua.post({ t: 'call', id: 1, name: 'garage:list', surface: 'tablet' });
      await lua.post({ t: 'call', id: 1, name: 'garage:list' });
      await lua.drain();
      await lua.trigger('demo:nexus:res', 0, 2, true, ['tablet']);
      await lua.trigger('demo:nexus:res', 0, 1, true, ['phone']);
      await lua.trigger('demo:nexus:res', 0, 3, true, ['main']);
      const log = await lua.drain();
      expect(appMessages(log)).toEqual([
        ['lb-tablet', 'nexus', { __nexus: 1, t: 'res', id: 1, ok: true, data: ['tablet'] }],
        ['lb-phone', { __nexus: 1, t: 'res', id: 1, ok: true, data: ['phone'] }],
      ]);
      expect(log.filter((entry) => entry.kind === 'nui')).toEqual([{ kind: 'nui', message: { __nexus: 1, t: 'res', id: 1, ok: true, data: ['main'] } }]);
    });

    it('sends pushes, state and the locale to every page that is up', async () => {
      await lua.post({ t: 'ready' });
      await lua.post({ t: 'ready', surface: 'phone' });
      await lua.drain();
      await lua.run(`Nexus.push('garage:balance', { balance = 5 })`);
      await lua.run(`Nexus.set('garage', { count = 3 })`);
      const log = await lua.drain();
      expect(log.map((entry) => entry.kind).sort()).toEqual(['appMessage', 'appMessage', 'nui', 'nui']);
      expect(appMessages(log)).toContainEqual(['lb-phone', { __nexus: 1, t: 'state', name: 'garage', data: { count: 3 } }]);
      expect(appMessages(log).every(([resource]) => resource === 'lb-phone')).toBe(true);
    });

    it('validates a client message from an app like any other', async () => {
      await lua.run(`Seen = {} Nexus.on('garage:waypoint', function(data) Seen[#Seen + 1] = data.model end)`);
      await lua.post({ t: 'client', name: 'garage:waypoint', data: { model: 'sultan' }, surface: 'phone' });
      await lua.post({ t: 'client', name: 'garage:waypoint', data: { model: 5 }, surface: 'phone' });
      expect(await lua.run(`return table.concat(Seen, ', ')`)).toBe('sultan');
    });

    it('runs onOpen and onClose when LB opens and closes the app, and stops sending to a closed one', async () => {
      await lua.run(`
        Events = {}
        Nexus.onOpen('garagePhone', function() Events[#Events + 1] = 'open' end)
        Nexus.onClose('garagePhone', function() Events[#Events + 1] = 'close' end)
      `);
      await lua.run(`Sim.app('lb-phone', 'garage', 'onOpen')`);
      await lua.post({ t: 'ready', surface: 'phone' });
      await lua.run(`Sim.app('lb-phone', 'garage', 'onClose')`);
      await lua.drain();
      expect(await lua.run(`return Nexus.isOpen('garagePhone')`)).toBe(false);
      await lua.run(`Nexus.set('garage', { count = 9 })`);
      expect(await lua.drain()).toEqual([]);

      // The phone kept the frame, so the app does not say ready again: it is told what it missed.
      await lua.run(`Sim.app('lb-phone', 'garage', 'onOpen')`);
      expect(appMessages(await lua.drain())).toEqual([
        ['lb-phone', { __nexus: 1, t: 'locale', data: { title: 'Garage' } }],
        ['lb-phone', { __nexus: 1, t: 'state', name: 'garage', data: { count: 9 } }],
      ]);
      expect(await lua.run(`return table.concat(Events, ', ')`)).toBe('open, close, open');
    });

    it('ignores a close from an app, whose frame is not ours to close', async () => {
      await lua.post({ t: 'ready' });
      await lua.run(`Nexus.open('garage')`);
      await lua.post({ t: 'close', surface: 'phone' });
      expect(await lua.run(`return Nexus.isOpen('garage')`)).toBe(true);
    });

    it('removes the apps when the resource stops', async () => {
      await lua.trigger('onResourceStop', '', 'demo');
      expect(await lua.drain()).toEqual([
        { kind: 'removeApp', resource: expect.any(String), identifier: expect.any(String) },
        { kind: 'removeApp', resource: expect.any(String), identifier: expect.any(String) },
      ]);
    });

    it('does not raise when LB has stopped while its app was up', async () => {
      await lua.post({ t: 'ready', surface: 'phone' });
      await lua.run(`Sim.exports['lb-phone'] = nil`);
      await lua.run(`Nexus.set('garage', { count = 4 })`);
      await lua.trigger('onResourceStop', '', 'demo');
      expect((await lua.drain()).some((entry) => entry.kind === 'error')).toBe(false);
    });
  });

  it('refuses a surface it does not know, a missing screen, a missing name and Nexus.open on an app', async () => {
    await expect(lua.run(`Nexus.app('watch', { name = 'Garage' })`)).rejects.toThrow("Nexus.app: the surface is 'phone' or 'tablet', got 'watch'");
    await expect(lua.run(`Nexus.app('phone', {})`)).rejects.toThrow("Nexus.app('phone', options): options.name must be the name of the app");
    await expect(lua.run(`Nexus.open('garagePhone')`)).rejects.toThrow("Nexus.open: 'garagePhone' is the phone app. LB opens and closes it, not Lua.");
    await expect(lua.run(`Nexus.close('garageTablet')`)).rejects.toThrow("Nexus.close: 'garageTablet' is the tablet app.");

    const plain = await Lua.create({ fivem: true });
    await plain.run(CONTRACT);
    await plain.run(`NexusScreens = { garage = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true } }`);
    await plain.run(CLIENT_LUA);
    await expect(plain.run(PHONE)).rejects.toThrow('Nexus.app: no screen declares <screen surface="phone" />. Add one in web/screens and build again.');
    plain.close();
  });

  it('drops a message from an app that was never registered', async () => {
    await lua.post({ t: 'ready', surface: 'phone' });
    await lua.post({ t: 'call', id: 1, name: 'garage:list', surface: 'phone' });
    await lua.post({ t: 'call', id: 1, name: 'garage:list', surface: 'watch' });
    expect((await lua.drain()).filter((entry) => entry.kind !== 'nuiResponse')).toEqual([]);
  });
});
