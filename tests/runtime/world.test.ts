import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { builtScripts, CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

const ADDRESS = '?surface=world&screen=kiosk&display=3&resource=fixture_app';
const SIZE = { width: 800, height: 600 };

describe.skipIf(!CHROMIUM_103)('a display in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'world', query: ADDRESS, viewport: SIZE });
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const value = (selector: string): Promise<string> => fixture.page.inputValue(selector);
  const type = (typed: string): Promise<void> => fixture.lua({ t: 'type', text: typed });
  const key = (name: string): Promise<void> => fixture.lua({ t: 'key', key: name });
  const focused = (): Promise<string | null> => fixture.page.evaluate(() => document.querySelector('[data-nexus-focus]')?.id ?? null);
  /** Waits until what Lua sent has been handled: messages arrive in order, and the last is a push. */
  const settled = async (): Promise<void> => {
    const before = Number(await text('#kiosk-pushed'));
    await fixture.lua({ t: 'push', name: 'garage:changed', data: null });
    await fixture.page.waitForFunction((count) => document.querySelector('#kiosk-pushed')!.textContent === String(count + 1), before);
  };
  const click = (selector: string): Promise<void> => fixture.page.click(selector);

  test('says it is ready with its surface and its display, to the callback of the resource in its address', async () => {
    expect(await fixture.sent()).toEqual([{ t: 'ready', surface: 'world', display: '3' }]);
    expect(fixture.endpoints).toEqual(['https://fixture_app/nexus']);
    expect(await fixture.nodes()).toBe(0);
  });

  test('mounts its screen when Lua opens it, with its props from the first moment and at its size', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'locale', data: { 'app.title': 'Kiosk' } });
    await fixture.lua({ t: 'state', name: 'garage', data: { count: 4 } });
    await fixture.open('kiosk', { business: 'police' });
    expect([await text('#kiosk-title'), await text('#kiosk-props'), await text('#kiosk-state')]).toEqual(['Kiosk', 'police', '4']);
    expect(await text('#kiosk-env')).toBe('true|fixture_app');
    const box = await page.evaluate(() => {
      const rect = document.querySelector('[data-screen="kiosk"]')!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    });
    expect(box).toEqual([0, 0, 800, 600]);

    await fixture.open('kiosk', { business: 'ambulance' });
    expect(await text('#kiosk-props')).toBe('ambulance');
    expect(await page.locator('[data-screen="kiosk"]').count()).toBe(1);
  });

  test('draws its own cursor where the mouse was sent, and puts it away when the mouse is quiet', async () => {
    const { page } = fixture;
    const cursor = page.locator('[data-nexus-cursor]');
    expect(await cursor.isVisible()).toBe(false);
    await page.mouse.move(120, 80);
    await cursor.waitFor({ state: 'visible' });
    expect(await cursor.evaluate((node) => (node as HTMLElement).style.transform)).toBe('translate(120px, 80px)');
    // The tip of the arrow is at the pointer, and the arrow takes no click meant for the page.
    const tip = await cursor.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return [rect.left + 4, rect.top + 2, getComputedStyle(node).pointerEvents];
    });
    expect(tip).toEqual([120, 80, 'none']);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#kiosk-list')!).cursor)).toBe('none');
    await cursor.waitFor({ state: 'hidden', timeout: 5000 });
  });

  test('typed text goes into the field that was clicked, at its caret, and reaches what is bound to it', async () => {
    await click('#kiosk-name');
    await type('Ada');
    await settled();
    expect(await value('#kiosk-name')).toBe('Ada');
    expect(await text('#kiosk-values')).toBe('Ada|0|');
    expect(await focused()).toBe('kiosk-name');

    await key('ArrowLeft');
    await type('x');
    await key('Home');
    await type('>');
    await key('End');
    await type('!');
    await settled();
    expect(await value('#kiosk-name')).toBe('>Adxa!');
  });

  test('Backspace and Delete erase around the caret, and a field holds no more than its maxlength', async () => {
    await key('Backspace');
    await key('Home');
    await key('Delete');
    await settled();
    expect(await value('#kiosk-name')).toBe('Adxa');
    await key('End');
    await type('0123456789');
    await settled();
    expect(await value('#kiosk-name')).toBe('Adxa01234567');
    expect(await text('#kiosk-values')).toBe('Adxa01234567|0|');
  });

  test('Enter in a field submits its form, and a handler for the key hears it as well', async () => {
    await key('Enter');
    await settled();
    expect(await text('#kiosk-log')).toBe('enter,submit:Adxa01234567');
  });

  test('Tab moves to the next field, a number takes a decimal point, and Enter breaks a line in a textarea', async () => {
    await key('Tab');
    await type('12.5');
    await settled();
    expect(await focused()).toBe('kiosk-amount');
    expect(await text('#kiosk-values')).toBe('Adxa01234567|12.5|');

    await key('Tab');
    await type('one');
    await key('Enter');
    await type('two');
    await key('ArrowUp');
    await key('Home');
    await type('>');
    await settled();
    expect(await focused()).toBe('kiosk-notes');
    expect(await value('#kiosk-notes')).toBe('>one\ntwo');
  });
  test('a character is a hotkey when no field has the focus, and text when one has', async () => {
    const before = await text('#kiosk-log');
    await type('e');
    await settled();
    expect(await value('#kiosk-notes')).toBe('>eone\ntwo');
    expect(await text('#kiosk-log')).toBe(before);

    await click('#kiosk-title');
    expect(await focused()).toBe(null);
    await type('e');
    await key('Escape');
    await settled();
    expect(await text('#kiosk-log')).toBe(`${before},e,escape`);
  });

  test('Space presses what has the focus, and a key with a handler does nothing else', async () => {
    const { page } = fixture;
    await click('#kiosk-agree');
    expect(await page.isChecked('#kiosk-agree')).toBe(true);
    await type(' ');
    await settled();
    expect(await page.isChecked('#kiosk-agree')).toBe(false);

    await key('Tab');
    await key('Tab');
    expect(await focused()).toBe('kiosk-count');
    const before = await text('#kiosk-log');
    await type(' ');
    // Enter has a handler on this screen, so it does not also press the button.
    await key('Enter');
    await settled();
    expect(await text('#kiosk-log')).toBe(`${before},count,enter`);
  });

  test('a call is answered to the display, and a push reaches it', async () => {
    const { page } = fixture;
    await click('#kiosk-list');
    while (!(await fixture.sent()).some((message) => message.t === 'call')) await page.waitForTimeout(10);
    const call = (await fixture.sent()).find((message) => message.t === 'call') as Record<string, unknown>;
    expect(call).toMatchObject({ t: 'call', name: 'garage:list', data: { owner: 'me' }, surface: 'world', display: '3' });
    await fixture.lua({ t: 'res', id: call.id, ok: true, data: ['sultan'] });
    await page.waitForFunction(() => document.querySelector('#kiosk-result')!.textContent === '["sultan"]');

    const pushes = Number(await text('#kiosk-pushed'));
    await fixture.lua({ t: 'push', name: 'garage:changed', data: null });
    await page.waitForFunction((count) => document.querySelector('#kiosk-pushed')!.textContent === String(count + 1), pushes);
    expect(new Set(fixture.endpoints)).toEqual(new Set(['https://fixture_app/nexus']));
    expect(fixture.errors).toEqual([]);
  });

  test('a display that Lua never answers shows its screen without props, so that the problem can be seen', async () => {
    const silent = await openFixture({ mode: 'world', query: '?surface=world&screen=kiosk&display=4&resource=fixture_app', viewport: SIZE });
    expect(await silent.nodes()).toBe(0);
    await silent.page.waitForSelector('#kiosk', { timeout: 5000 });
    expect(await silent.page.textContent('#kiosk-props')).toBe('no business');
    expect(silent.errors).toEqual([]);
    await silent.close();
  });
});

describe.skipIf(!CHROMIUM_103)('the page of the resource while a display is operated, in Chromium 103', () => {
  let fixture: Fixture;
  let chunk: string;

  beforeAll(async () => {
    fixture = await openFixture({ mode: 'game' });
    const scripts = await builtScripts();
    chunk = Object.keys(scripts).find((name) => scripts[name]!.includes('nexusCursor')) as string;
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const loaded = (): Promise<string[]> => fixture.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name.split('/').pop() as string));
  const inputs = async (): Promise<Record<string, unknown>[]> => (await fixture.sent()).filter((message) => message.t === 'input');
  const waitFor = async (count: number): Promise<Record<string, unknown>[]> => {
    while ((await inputs()).length < count) await fixture.page.waitForTimeout(10);
    return inputs();
  };

  test('the code for world screens is a file of its own, which the page does not load until it is needed', async () => {
    expect(chunk).toBeTruthy();
    await fixture.open('keys');
    expect(await loaded()).not.toContain(chunk);
    const scripts = await builtScripts();
    const others = Object.keys(scripts).filter((name) => name !== chunk);
    for (const name of others) expect(scripts[name]).not.toContain('nexusCursor');
  });

  test('says that it forwards input once Lua asks for it, and draws no cursor of its own', async () => {
    await fixture.lua({ t: 'operate', on: true });
    expect(await waitFor(1)).toEqual([{ t: 'input', kind: 'ready' }]);
    expect(await loaded()).toContain(chunk);
    expect(await fixture.page.locator('[data-nexus-cursor]').count()).toBe(0);
  });

  test('forwards the mouse as a place from 0 to 1, with the buttons and the wheel', async () => {
    const { page } = fixture;
    await page.mouse.move(320, 180);
    // A move is sent with the next frame, unless a button comes first and brings it along.
    await waitFor(2);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.wheel(0, 100);
    const sent = (await waitFor(5)).slice(1);
    expect(sent).toEqual([
      { t: 'input', kind: 'pointer', x: 0.25, y: 0.25 },
      { t: 'input', kind: 'press', button: 'left', x: 0.25, y: 0.25 },
      { t: 'input', kind: 'release', button: 'left', x: 0.25, y: 0.25 },
      { t: 'input', kind: 'scroll', lines: 3 },
    ]);

    // What is forwarded is not also a click on a screen of the page.
    await page.click('#target');
    await waitFor(7);
    expect(await page.textContent('#clicks')).toBe('0');
  });

  test('forwards characters as text and the other keys by name, and keeps them from the screens of the page', async () => {
    const { page } = fixture;
    const before = await page.textContent('#log');
    const start = (await inputs()).length;
    await page.keyboard.press('s');
    await page.keyboard.press('Shift+A');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('F5');
    const sent = (await waitFor(start + 4)).slice(start);
    expect(sent).toEqual([
      { t: 'input', kind: 'type', text: 's' },
      { t: 'input', kind: 'type', text: 'A' },
      { t: 'input', kind: 'key', key: 'Enter' },
      { t: 'input', kind: 'key', key: 'Escape' },
    ]);
    expect(await page.textContent('#log')).toBe(before);
    expect((await fixture.sent()).filter((message) => message.t === 'close')).toEqual([]);
  });

  test('reports a walking key that is held, and not one that is tapped', async () => {
    const { page } = fixture;
    await page.keyboard.press('w');
    await page.waitForTimeout(700);
    expect((await inputs()).filter((message) => message.kind === 'leave')).toEqual([]);
    await page.keyboard.down('w');
    await page.waitForTimeout(700);
    await page.keyboard.up('w');
    expect((await inputs()).filter((message) => message.kind === 'leave')).toEqual([{ t: 'input', kind: 'leave' }]);
  });

  test('stops forwarding when Lua says so, and the screens of the page hear their keys again', async () => {
    const { page } = fixture;
    await fixture.lua({ t: 'operate', on: false });
    await page.waitForTimeout(50);
    const count = (await inputs()).length;
    const before = await page.textContent('#log');
    await page.mouse.move(10, 10);
    await page.keyboard.press('s');
    await page.waitForTimeout(50);
    expect((await inputs()).length).toBe(count);
    expect(await page.textContent('#log')).toBe(`${before ? `${before},` : ''}s`);
    expect(fixture.errors).toEqual([]);
  });
});
