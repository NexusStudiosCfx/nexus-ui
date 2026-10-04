import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua, s } from '../../src/contract';
import { CLIENT_LUA, Lua, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(
  contract({
    calls: { 'clock:punch': { input: s.object({ pin: s.string({ max: 8 }) }), output: s.object({ ok: s.boolean() }) } },
    pushes: { 'clock:tick': s.object({ time: s.int() }) },
    client: { 'clock:beep': s.object({ tone: s.int() }) },
    state: { shift: s.object({ onDuty: s.boolean() }) },
    screens: { clock: s.object({ business: s.string({ max: 40 }) }) },
  }),
);

const SCREENS = `
NexusScreens = {
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
    clock = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'world', width = 1280, height = 720 },
    terminal = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'world', width = 800, height = 600 },
}
`;

const CLOCK = `clock = Nexus.world('clock', { txd = 'prop_clock', texture = 'clock_face', props = { business = 'police' } })`;
const TERMINAL = `terminal = Nexus.world('terminal', { txd = 'prop_terminal', texture = 'terminal_screen' })`;

type Of<Kind extends LogEntry['kind']> = Extract<LogEntry, { kind: Kind }>;

function of<Kind extends LogEntry['kind']>(log: LogEntry[], kind: Kind): Of<Kind>[] {
  return log.filter((entry): entry is Of<Kind> => entry.kind === kind);
}

/** What Lua sent to each display, by the handle of its browser. */
function toDisplays(log: LogEntry[]): [number, Record<string, unknown>][] {
  return of(log, 'duiMessage').map((entry) => [entry.dui, entry.message]);
}

describe('world screens in lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SCREENS);
    await lua.run(CLIENT_LUA);
  });

  afterEach(() => lua.close());

  const ready = async (display: number): Promise<LogEntry[]> => {
    await lua.post({ t: 'ready', surface: 'world', display: String(display) });
    return lua.drain();
  };

  describe('creating a display', () => {
    it('starts a browser of the size of the screen on the page of the resource, and replaces the texture with its picture', async () => {
      await lua.run(CLOCK);
      const log = await lua.drain();
      const [browser] = of(log, 'createDui');
      expect(browser).toMatchObject({
        url: 'https://cfx-nui-demo/web/dist/index.html?surface=world&screen=clock&display=1&resource=demo',
        width: 1280,
        height: 720,
      });
      const [texture] = of(log, 'runtimeTexture');
      expect(texture).toMatchObject({ name: 'display_1', handle: `handle:${browser!.dui}` });
      expect(of(log, 'replaceTexture')).toEqual([
        { kind: 'replaceTexture', txd: 'prop_clock', texture: 'clock_face', with: [texture!.txd.replace('txd:', ''), 'display_1'] },
      ]);
      expect(log.map((entry) => entry.kind)).toEqual(['createDui', 'runtimeTexture', 'replaceTexture']);
      expect(await lua.run('return clock:alive()')).toBe(true);
      expect(await lua.run(`return Nexus.isOpen('clock')`)).toBe(true);
      expect(await lua.run(`return Nexus.isOpen('terminal')`)).toBe(false);
    });

    it('starts no thread, and sends nothing until the page of the display says it is ready', async () => {
      await lua.run(CLOCK);
      await lua.run(`Nexus.locale({ title = 'Clock' }) Nexus.set('shift', { onDuty = true }) clock:type('x')`);
      await lua.tick(16, 5);
      expect(await lua.threads()).toBe(0);
      expect(toDisplays(await lua.drain())).toEqual([]);

      const dui = 101;
      expect(toDisplays(await ready(1))).toEqual([
        [dui, { __nexus: 1, t: 'locale', data: { title: 'Clock' } }],
        [dui, { __nexus: 1, t: 'state', name: 'shift', data: { onDuty: true } }],
        [dui, { __nexus: 1, t: 'open', screen: 'clock', props: { business: 'police' } }],
      ]);
    });

    it('loads the page from the dev server when the manifest points there', async () => {
      await lua.run(`Sim.metadata.ui_page = 'http://localhost:5173/'`);
      await lua.run(CLOCK);
      expect(of(await lua.drain(), 'createDui')[0]!.url).toBe('http://localhost:5173/?surface=world&screen=clock&display=1&resource=demo');
    });

    it('runs onOpen with the props, and refuses what is not a world screen or names no texture', async () => {
      await lua.run(`Nexus.onOpen('clock', function(props) print('opened for ' .. props.business) end)`);
      await lua.run(CLOCK);
      expect(of(await lua.drain(), 'print').map((entry) => entry.text)).toEqual(['opened for police']);

      await expect(lua.run(`Nexus.world('shop', { txd = 'a', texture = 'b' })`)).rejects.toThrow("Nexus.world: 'shop' is not a world screen");
      await expect(lua.run(`Nexus.world('nope', { txd = 'a', texture = 'b' })`)).rejects.toThrow("there is no screen 'nope'");
      await expect(lua.run(`Nexus.world('clock', { txd = 'a' })`)).rejects.toThrow('options.txd and options.texture must name the texture to draw on');
      await expect(lua.run(`Nexus.world('clock', { txd = 'a', texture = 'b', props = 5 })`)).rejects.toThrow('options.props must be a table');
    });

    it('checks the props against the contract when nexus_dev is 1', async () => {
      await lua.convar('nexus_dev', 1);
      await expect(lua.run(`Nexus.world('clock', { txd = 'a', texture = 'b', props = { business = 5 } })`)).rejects.toThrow(
        "Nexus.world('clock'): the props do not match the contract: business: expected a string",
      );
      await lua.run(CLOCK);
      await expect(lua.run(`clock:set({})`)).rejects.toThrow('display:set(props): the props do not match the contract: business: expected a string');
    });
  });

  describe('the limits', () => {
    it('returns nil and limit at the cap, which is 2 unless the convar says otherwise', async () => {
      await lua.run(CLOCK);
      await lua.run(TERMINAL);
      await lua.drain();
      const third = `local display, problem = Nexus.world('clock', { txd = 'prop_other', texture = 'face' }) return tostring(display) .. ' ' .. tostring(problem)`;
      expect(await lua.run(third)).toBe('nil limit');
      expect(await lua.drain()).toEqual([]);

      await lua.convar('nexus_world_limit', 3);
      expect(await lua.run(third)).not.toBe('nil limit');
      expect(of(await lua.drain(), 'createDui')).toHaveLength(1);
    });

    it('frees a place when a display is destroyed', async () => {
      await lua.run(CLOCK);
      await lua.run(TERMINAL);
      await lua.run('clock:destroy()');
      expect(await lua.run(`return Nexus.world('clock', { txd = 'prop_other', texture = 'face' }) ~= nil`)).toBe(true);
    });

    it('returns nil and taken for a texture that already has a display', async () => {
      await lua.run(CLOCK);
      expect(await lua.run(`local display, problem = Nexus.world('terminal', { txd = 'prop_clock', texture = 'clock_face' }) return tostring(display) .. ' ' .. problem`)).toBe('nil taken');
    });

    it('returns nil and unavailable when the game has no browser to give', async () => {
      const attempt = `local display, problem = Nexus.world('clock', { txd = 'a', texture = 'b' }) return tostring(display) .. ' ' .. problem`;
      await lua.run('Sim.noDui = true');
      expect(await lua.run(attempt)).toBe('nil unavailable');
      await lua.run('Sim.noDui = false CreateDui = nil');
      expect(await lua.run(attempt)).toBe('nil unavailable');
      expect(await lua.drain()).toEqual([]);
    });
  });
  describe('routing', () => {
    beforeEach(async () => {
      await lua.post({ t: 'ready' });
      await lua.run(CLOCK);
      await lua.run(TERMINAL);
      await ready(1);
      await ready(2);
    });

    it('answers a call to the display that made it, and to no other page', async () => {
      await lua.post({ t: 'call', id: 4, name: 'clock:punch', data: { pin: '1234' }, surface: 'world', display: '2' });
      const [sent] = of(await lua.drain(), 'serverEvent');
      await lua.trigger('demo:nexus:res', '', sent!.args[0], true, { ok: true });
      const log = await lua.drain();
      expect(toDisplays(log)).toEqual([[102, { __nexus: 1, t: 'res', id: 4, ok: true, data: { ok: true } }]]);
      expect(of(log, 'nui')).toEqual([]);
    });

    it('refuses invalid input from a display at once, on that display', async () => {
      await lua.post({ t: 'call', id: 9, name: 'clock:punch', data: { pin: 5 }, surface: 'world', display: '1' });
      expect(toDisplays(await lua.drain())).toEqual([[101, { __nexus: 1, t: 'res', id: 9, ok: false, code: 'invalid', message: 'pin: expected a string' }]]);
    });

    it('sends pushes, state and the locale to every display and to the page of the resource', async () => {
      await lua.run(`Nexus.push('clock:tick', { time = 5 })`);
      await lua.run(`Nexus.set('shift', { onDuty = true }) Nexus.locale({ title = 'Clock' })`);
      const log = await lua.drain();
      const expected = [
        { __nexus: 1, t: 'push', name: 'clock:tick', data: { time: 5 } },
        { __nexus: 1, t: 'state', name: 'shift', data: { onDuty: true } },
        { __nexus: 1, t: 'locale', data: { title: 'Clock' } },
      ];
      expect(of(log, 'nui').map((entry) => entry.message)).toEqual(expected);
      for (const dui of [101, 102]) {
        expect(toDisplays(log).filter(([to]) => to === dui).map(([, message]) => message)).toEqual(expected);
      }
    });

    it('hands a client message from a display to its handlers', async () => {
      await lua.run(`Nexus.on('clock:beep', function(data) print('beep ' .. data.tone) end)`);
      await lua.post({ t: 'client', name: 'clock:beep', data: { tone: 3 }, surface: 'world', display: '1' });
      expect(of(await lua.drain(), 'print').map((entry) => entry.text)).toEqual(['beep 3']);
    });

    it('ignores a display that does not exist, and a close from a display', async () => {
      await lua.post({ t: 'ready', surface: 'world', display: '7' });
      await lua.post({ t: 'ready', surface: 'world' });
      await lua.post({ t: 'ready', surface: 'world', display: { id: 1 } });
      await lua.post({ t: 'close', surface: 'world', display: '1' });
      expect((await lua.drain()).filter((entry) => entry.kind !== 'nuiResponse')).toEqual([]);
    });

    it('replaces the props with set, and opens a page that loads again with the newest', async () => {
      await lua.run(`clock:set({ business = 'ambulance' })`);
      expect(toDisplays(await lua.drain())).toEqual([[101, { __nexus: 1, t: 'open', screen: 'clock', props: { business: 'ambulance' } }]]);
      expect(toDisplays(await ready(1)).pop()).toEqual([101, { __nexus: 1, t: 'open', screen: 'clock', props: { business: 'ambulance' } }]);
      await lua.run(`terminal:set()`);
      expect(toDisplays(await lua.drain())).toEqual([[102, { __nexus: 1, t: 'open', screen: 'terminal' }]]);
    });
  });

  describe('destroying a display', () => {
    it('puts the texture back, frees the browser and runs onClose', async () => {
      await lua.run(`Nexus.onClose('clock', function() print('closed') end)`);
      await lua.run(CLOCK);
      await ready(1);
      await lua.run('clock:destroy()');
      expect(await lua.drain()).toEqual([
        { kind: 'restoreTexture', txd: 'prop_clock', texture: 'clock_face' },
        { kind: 'destroyDui', dui: 101 },
        { kind: 'print', text: 'closed' },
      ]);
      expect(await lua.run(`return tostring(clock:alive()) .. ' ' .. tostring(Nexus.isOpen('clock'))`)).toBe('false false');
    });

    it('leaves a destroyed display alone: no second destroy, no input, no props, no answer', async () => {
      await lua.run(CLOCK);
      await ready(1);
      await lua.post({ t: 'call', id: 1, name: 'clock:punch', data: { pin: '1' }, surface: 'world', display: '1' });
      const [sent] = of(await lua.drain(), 'serverEvent');
      await lua.run('clock:destroy()');
      await lua.drain();
      await lua.run(`clock:destroy() clock:set({ business = 'x' }) clock:pointer(0.5, 0.5) clock:press('left') clock:release('left') clock:scroll(1) clock:type('a') clock:key('Enter')`);
      await lua.trigger('demo:nexus:res', '', sent!.args[0], true, { ok: true });
      await lua.post({ t: 'ready', surface: 'world', display: '1' });
      expect((await lua.drain()).filter((entry) => entry.kind !== 'nuiResponse')).toEqual([]);
    });

    it('gives each display an id and a texture of its own, also after one is gone', async () => {
      await lua.run(CLOCK);
      await lua.run('clock:destroy()');
      await lua.run(CLOCK);
      const log = await lua.drain();
      expect(of(log, 'createDui').map((entry) => /display=(\d+)/.exec(entry.url)![1])).toEqual(['1', '2']);
      const names = of(log, 'replaceTexture').map((entry) => entry.with.join('/'));
      expect(new Set(names).size).toBe(2);
    });

    it('destroys every display when the resource stops, and only then', async () => {
      await lua.run(`Nexus.onClose('terminal', function() print('terminal closed') end)`);
      await lua.run(CLOCK);
      await lua.run(TERMINAL);
      await lua.drain();
      await lua.trigger('onResourceStop', '', 'another');
      expect(await lua.drain()).toEqual([]);

      await lua.trigger('onResourceStop', '', 'demo');
      const log = await lua.drain();
      expect(of(log, 'restoreTexture').map((entry) => entry.texture).sort()).toEqual(['clock_face', 'terminal_screen']);
      expect(of(log, 'destroyDui').map((entry) => entry.dui).sort()).toEqual([101, 102]);
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['terminal closed']);
      expect(of(log, 'error')).toEqual([]);
    });
  });

  describe('a world screen and the page', () => {
    it('cannot be opened or closed as a screen of the page', async () => {
      await expect(lua.run(`Nexus.open('clock', { business = 'police' })`)).rejects.toThrow(
        "Nexus.open: 'clock' is a world screen. Nexus.world('clock', { txd = ..., texture = ... }) draws it on a prop.",
      );
      await expect(lua.run(`Nexus.close('clock')`)).rejects.toThrow("Nexus.close: 'clock' is a world screen.");
      expect(await lua.drain()).toEqual([]);
    });
  });
});
