import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contract, generateLua } from '../../src/contract';
import { CLIENT_LUA, Lua, type LogEntry } from '../support/lua';

const CONTRACT = generateLua(contract({}));

const SCREENS = `
NexusScreens = {
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
    hud = { layer = 'hud', mouse = false, keyboard = false, keepInput = false, escape = false },
    clock = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'world', width = 1280, height = 720 },
    terminal = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'world', width = 800, height = 600 },
}
`;

type Of<Kind extends LogEntry['kind']> = Extract<LogEntry, { kind: Kind }>;

function of<Kind extends LogEntry['kind']>(log: LogEntry[], kind: Kind): Of<Kind>[] {
  return log.filter((entry): entry is Of<Kind> => entry.kind === kind);
}

/** What was done to the browsers of the displays: `[dui, 'move', x, y]`, or `[dui, message]` for a message. */
function toDisplays(log: LogEntry[]): unknown[][] {
  return log.flatMap((entry) =>
    entry.kind === 'duiMouse' ? [[entry.dui, entry.event, ...entry.args]] : entry.kind === 'duiMessage' ? [[entry.dui, entry.message]] : [],
  );
}

const CLOCK = 101;

describe('the input of a display in lua/client.lua', () => {
  let lua: Lua;

  beforeEach(async () => {
    lua = await Lua.create({ fivem: true });
    await lua.run(CONTRACT);
    await lua.run(SCREENS);
    await lua.run(CLIENT_LUA);
    await lua.post({ t: 'ready' });
    await lua.run(`clock = Nexus.world('clock', { txd = 'prop_clock', texture = 'clock_face' })`);
    await lua.post({ t: 'ready', surface: 'world', display: '1' });
    await lua.drain();
  });

  afterEach(() => lua.close());

  const input = async (message: Record<string, unknown>): Promise<LogEntry[]> => {
    await lua.post({ t: 'input', ...message });
    return (await lua.drain()).filter((entry) => entry.kind !== 'nuiResponse');
  };

  /** The focus calls in order: `[hasFocus, hasCursor]` for SetNuiFocus, `keep true` for SetNuiFocusKeepInput. */
  const focus = (log: LogEntry[]): unknown[] =>
    log.flatMap((entry): unknown[] => (entry.kind === 'focus' ? [[entry.focus, entry.cursor]] : entry.kind === 'keepInput' ? [`keep ${entry.keep}`] : []));

  describe('from Lua', () => {
    it('moves the pointer in the pixels of the browser, from 0 to 1 across and down', async () => {
      await lua.run('clock:pointer(0, 0) clock:pointer(0.5, 0.5) clock:pointer(1, 1) clock:pointer(-3, 7)');
      expect(toDisplays(await lua.drain())).toEqual([
        [CLOCK, 'move', 0, 0],
        [CLOCK, 'move', 640, 360],
        [CLOCK, 'move', 1279, 719],
        [CLOCK, 'move', 0, 719],
      ]);
    });

    it('presses and releases a button, and turns the wheel downwards for a positive number of lines', async () => {
      await lua.run(`clock:press('left') clock:release('left') clock:press('right') clock:scroll(3) clock:scroll(-1)`);
      expect(toDisplays(await lua.drain())).toEqual([
        [CLOCK, 'down', 'left'],
        [CLOCK, 'up', 'left'],
        [CLOCK, 'down', 'right'],
        [CLOCK, 'wheel', -120, 0],
        [CLOCK, 'wheel', 40, 0],
      ]);
    });

    it('sends text and keys as messages, since a browser on a prop has no keyboard', async () => {
      await lua.run(`clock:type('Hi') clock:key('Backspace')`);
      expect(toDisplays(await lua.drain())).toEqual([
        [CLOCK, { __nexus: 1, t: 'type', text: 'Hi' }],
        [CLOCK, { __nexus: 1, t: 'key', key: 'Backspace' }],
      ]);
    });

    it('says what was wrong with an argument, at the line that passed it', async () => {
      await expect(lua.run(`clock:pointer('a', 0)`)).rejects.toThrow('display:pointer(x, y): x and y must be numbers from 0 to 1');
      await expect(lua.run(`clock:press('back')`)).rejects.toThrow("display:press(button): the button is 'left', 'right' or 'middle', got 'back'");
      await expect(lua.run(`clock:release()`)).rejects.toThrow('display:release(button)');
      await expect(lua.run(`clock:scroll('down')`)).rejects.toThrow('display:scroll(lines): lines must be a number');
      await expect(lua.run(`clock:type(5)`)).rejects.toThrow('display:type(text): text must be a string');
      await expect(lua.run(`clock:key('F5')`)).rejects.toThrow("display:key(key): 'F5' is not a key a display takes");
      expect(await lua.drain()).toEqual([]);
    });
  });

  describe('Nexus.operate', () => {
    const operate = `return Nexus.operate(clock, { onExit = function() print('left the clock') end })`;

    it('asks the page of the resource to forward input, and takes the focus once the page says it does', async () => {
      expect(await lua.run(operate)).toBe(true);
      const started = await lua.drain();
      expect(of(started, 'nui').map((entry) => entry.message)).toEqual([{ __nexus: 1, t: 'operate', on: true }]);
      expect(focus(started)).toEqual([]);

      expect(focus(await input({ kind: 'ready' }))).toEqual([[true, true], 'keep false']);
      expect(focus(await input({ kind: 'ready' }))).toEqual([]);
    });

    it('runs one thread while it lasts, which hides the HUD and turns the controls off, and none after', async () => {
      expect(await lua.threads()).toBe(0);
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.tick(16, 10);
      expect(await lua.threads()).toBe(1);
      expect((await lua.disabledControls()).all).toBe(10);
      expect(await lua.run('return Sim.hidden')).toBe(10);

      expect(await lua.run('return Nexus.release()')).toBe(true);
      await lua.tick(16, 2);
      expect(await lua.threads()).toBe(0);
      expect(await lua.run('return Nexus.release()')).toBe(false);
    });

    it('passes the mouse, the wheel, text and keys of the page on to the display', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      const log = [
        ...(await input({ kind: 'pointer', x: 0.25, y: 0.5 })),
        ...(await input({ kind: 'press', button: 'left', x: 0.5, y: 0.5 })),
        ...(await input({ kind: 'release', button: 'left', x: 0.5, y: 0.5 })),
        ...(await input({ kind: 'scroll', lines: 3 })),
        ...(await input({ kind: 'type', text: 'a' })),
        ...(await input({ kind: 'key', key: 'Enter' })),
      ];
      expect(toDisplays(log)).toEqual([
        [CLOCK, 'move', 320, 360],
        [CLOCK, 'move', 640, 360],
        [CLOCK, 'down', 'left'],
        [CLOCK, 'move', 640, 360],
        [CLOCK, 'up', 'left'],
        [CLOCK, 'wheel', -120, 0],
        [CLOCK, { __nexus: 1, t: 'type', text: 'a' }],
        [CLOCK, { __nexus: 1, t: 'key', key: 'Enter' }],
      ]);
    });

    it('drops input that is not well formed, and all input before the page has the focus', async () => {
      await lua.run(operate);
      await lua.drain();
      expect(await input({ kind: 'type', text: 'early' })).toEqual([]);
      await input({ kind: 'ready' });
      for (const message of [
        { kind: 'pointer', x: 'left', y: 0 },
        { kind: 'press', button: 'back', x: 0.5 },
        { kind: 'scroll', lines: 'many' },
        { kind: 'type', text: { a: 1 } },
        { kind: 'key', key: 'F5' },
        { kind: 'launch' },
        {},
      ]) {
        expect(toDisplays(await input(message))).toEqual([]);
      }
      expect(toDisplays(await input({ kind: 'press', button: 'back', x: 0.5, y: 0.5 }))).toEqual([[CLOCK, 'move', 640, 360]]);
      expect(toDisplays(await input({ kind: 'scroll', lines: 100000 }))).toEqual([[CLOCK, 'wheel', -4000, 0]]);
    });
    it('ends on Escape: the focus goes back, the page stops forwarding, onExit runs and the pause menu stays shut', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      const log = await input({ kind: 'key', key: 'Escape' });
      expect(toDisplays(log)).toEqual([]);
      expect(of(log, 'nui').map((entry) => entry.message)).toEqual([{ __nexus: 1, t: 'operate', on: false }]);
      expect(focus(log)).toEqual([[false, false]]);
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['left the clock']);

      await lua.disabledControls();
      await lua.tick(16, 3);
      expect((await lua.disabledControls())['200']).toBeGreaterThan(0);
      await lua.tick(300);
      expect(await lua.threads()).toBe(0);
      expect(await input({ kind: 'type', text: 'late' })).toEqual([]);
    });

    it('ends when the page reports a walking key held, and from Lua', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      expect(of(await input({ kind: 'leave' }), 'print').map((entry) => entry.text)).toEqual(['left the clock']);

      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.drain();
      await lua.run('Nexus.release()');
      const log = await lua.drain();
      expect(focus(log)).toEqual([[false, false]]);
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['left the clock']);
    });

    it('lets the player go when the page never says that it forwards input', async () => {
      await lua.run(operate);
      await lua.drain();
      await lua.tick(500, 5);
      const log = await lua.drain();
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['[nexus] the page did not start forwarding input, so the display is let go', 'left the clock']);
      expect(focus(log)).toEqual([]);
      await lua.tick(16, 2);
      expect(await lua.threads()).toBe(0);
    });

    it('moves a camera to face the entity, and gives the view back when it ends', async () => {
      await lua.run(`Nexus.operate(clock, { entity = 100, camera = { offset = { x = 0.5, y = -0.75, z = 0.25 }, fov = 38.0 } })`);
      expect(of(await lua.drain(), 'camera').map((entry) => [entry.call, ...entry.args])).toEqual([
        ['create', 'DEFAULT_SCRIPTED_CAMERA'],
        ['coord', 100.5, 99.25, 100.25],
        ['point', 100.5, 100, 100.25],
        ['fov', 38],
        ['render', true, true, 400],
      ]);
      await lua.run('Nexus.release()');
      expect(of(await lua.drain(), 'camera').map((entry) => [entry.call, ...entry.args])).toEqual([
        ['render', false, true, 400],
        ['destroy', 7],
      ]);

      await lua.run(`Nexus.operate(clock, { entity = 100, camera = { offset = { x = 0, y = -1, z = 0 }, target = { x = 0, y = 0, z = 0.5 } } })`);
      expect(of(await lua.drain(), 'camera').find((entry) => entry.call === 'point')!.args).toEqual([100, 100, 100.5]);
    });

    it('with a screen, the mouse acts where the game cursor is on the prop, and nowhere else', async () => {
      // In the view of the tests a screen 0.4 by 0.2 around the entity covers the window from
      // 0.3 to 0.7 across and from 0.4 to 0.6 down.
      await lua.run(`Nexus.operate(clock, { entity = 100, screen = { center = { x = 0, y = 0, z = 0 }, width = 0.4, height = 0.2 } })`);
      await lua.drain();
      expect(toDisplays(await input({ kind: 'ready' }))).toEqual([[CLOCK, { __nexus: 1, t: 'cursor', on: false }]]);

      expect(toDisplays(await input({ kind: 'pointer', x: 0.5, y: 0.5 }))).toEqual([[CLOCK, 'move', 640, 360]]);
      expect(toDisplays(await input({ kind: 'pointer', x: 0.3, y: 0.4 }))).toEqual([[CLOCK, 'move', 0, 0]]);
      expect(toDisplays(await input({ kind: 'pointer', x: 0.7, y: 0.6 }))).toEqual([[CLOCK, 'move', 1279, 719]]);
      expect(toDisplays(await input({ kind: 'press', button: 'left', x: 0.6, y: 0.45 }))).toEqual([
        [CLOCK, 'move', 959, 180],
        [CLOCK, 'down', 'left'],
      ]);

      // Beside the screen nothing moves and nothing is pressed, but a release still ends a drag.
      expect(toDisplays(await input({ kind: 'pointer', x: 0.1, y: 0.5 }))).toEqual([]);
      expect(toDisplays(await input({ kind: 'press', button: 'left', x: 0.9, y: 0.9 }))).toEqual([]);
      expect(toDisplays(await input({ kind: 'release', button: 'left', x: 0.9, y: 0.9 }))).toEqual([[CLOCK, 'up', 'left']]);

      await lua.run('Nexus.release()');
      expect(toDisplays(await lua.drain())).toEqual([[CLOCK, { __nexus: 1, t: 'cursor', on: true }]]);
    });

    it('refuses a screen without an entity or a size', async () => {
      await expect(lua.run(`Nexus.operate(clock, { screen = { center = { x = 0, y = 0, z = 0 }, width = 0.4, height = 0.2 } })`)).rejects.toThrow(/options\.screen needs options\.entity/);
      await expect(lua.run(`Nexus.operate(clock, { entity = 100, screen = { center = { x = 0, y = 0, z = 0 }, width = 0, height = 0.2 } })`)).rejects.toThrow(/options\.screen needs/);
    });

    it('operates one display at a time: the first is let go when a second starts', async () => {
      await lua.run(`terminal = Nexus.world('terminal', { txd = 'prop_terminal', texture = 'screen' })`);
      await lua.post({ t: 'ready', surface: 'world', display: '2' });
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.run('Nexus.operate(terminal)');
      await input({ kind: 'ready' });
      await lua.drain();
      expect(toDisplays(await input({ kind: 'pointer', x: 0.5, y: 0.5 }))).toEqual([[102, 'move', 400, 300]]);
      await lua.tick(16, 3);
      expect(await lua.threads()).toBe(1);
    });

    it('gives way to a screen that takes the focus, and does not start under one', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.run(`Nexus.open('hud')`);
      expect(of(await lua.drain(), 'print')).toEqual([]);

      await lua.run(`Nexus.open('shop')`);
      const log = await lua.drain();
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['left the clock']);
      expect(focus(log)).toEqual([[false, false], [true, true], 'keep false']);
      expect(await lua.run(operate)).toBe(false);

      await lua.run(`Nexus.close('shop')`);
      expect(await lua.run(operate)).toBe(true);
    });

    it('does not start for a display that is gone, before the page has loaded, or for what is not a display', async () => {
      await expect(lua.run('Nexus.operate({})')).rejects.toThrow('Nexus.operate(display, options): display must be what Nexus.world returned');
      await expect(lua.run('Nexus.operate(clock, { onExit = 5 })')).rejects.toThrow('options.onExit must be a function');
      await lua.run('clock:destroy()');
      expect(await lua.run(operate)).toBe(false);

      const fresh = await Lua.create({ fivem: true });
      await fresh.run(CONTRACT);
      await fresh.run(SCREENS);
      await fresh.run(CLIENT_LUA);
      await fresh.run(`clock = Nexus.world('clock', { txd = 'prop_clock', texture = 'clock_face' })`);
      expect(await fresh.run('return Nexus.operate(clock)')).toBe(false);
      fresh.close();
    });

    it('ends when its display is destroyed and when the resource stops', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.run('clock:destroy()');
      const log = await lua.drain();
      expect(focus(log)).toEqual([[false, false]]);
      expect(of(log, 'print').map((entry) => entry.text)).toEqual(['left the clock']);

      await lua.run(`clock = Nexus.world('clock', { txd = 'prop_clock', texture = 'clock_face' })`);
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.trigger('onResourceStop', '', 'demo');
      const stopped = await lua.drain();
      expect(focus(stopped)).toEqual([[false, false]]);
      expect(of(stopped, 'destroyDui')).toHaveLength(1);
      expect(of(stopped, 'error')).toEqual([]);
    });

    it('tells a page that loaded again to forward input again', async () => {
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.post({ t: 'ready' });
      expect(of(await lua.drain(), 'nui').map((entry) => entry.message)).toEqual([{ __nexus: 1, t: 'operate', on: true }]);
    });

    it('takes no input from the page while nothing is operated, or from a display', async () => {
      expect(await input({ kind: 'ready' })).toEqual([]);
      expect(await input({ kind: 'type', text: 'a' })).toEqual([]);
      await lua.run(operate);
      await input({ kind: 'ready' });
      await lua.post({ t: 'input', kind: 'key', key: 'Escape', surface: 'world', display: '1' });
      expect(of(await lua.drain(), 'print')).toEqual([]);
    });
  });
});
