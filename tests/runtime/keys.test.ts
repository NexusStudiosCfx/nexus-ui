import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { builtScripts, CHROMIUM_103, openFixture, shutdown, type Fixture } from './harness';

interface Timers {
  every: number;
  after: string[];
}

describe.skipIf(!CHROMIUM_103)('keys, timers and sounds in Chromium 103', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await openFixture();
    await fixture.open('keys');
  }, 120000);

  afterAll(async () => {
    await fixture.close();
    await shutdown();
  });

  const text = (selector: string): Promise<string | null> => fixture.page.textContent(selector);
  const timers = (): Promise<Timers> => fixture.page.evaluate(() => (window as unknown as { timers: Timers }).timers);
  const closes = async (): Promise<unknown[]> => (await fixture.sent()).filter((message) => message.t === 'close');

  describe('onKey', () => {
    test('a key with a handler does not also click the focused button', async () => {
      const { page } = fixture;
      await page.focus('#target');
      await page.keyboard.press(' ');
      await page.keyboard.press('Enter');
      expect(await text('#log')).toBe('space,enter');
      expect(await text('#clicks')).toBe('0');
      // The mouse still clicks it, and a key without a handler still reaches it.
      await page.click('#target');
      expect(await text('#clicks')).toBe('1');
    });

    test('nor follow the focused link, nor scroll', async () => {
      const { page } = fixture;
      await page.focus('#link');
      await page.keyboard.press('Enter');
      expect(page.url()).not.toContain('#followed');
      await page.focus('#keys');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press(' ');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.querySelector('#keys')!.scrollTop)).toBe(0);
      expect(await text('#log')).toBe('space,enter,enter,down,space');
      // A key nobody handles still scrolls.
      await page.keyboard.press('PageDown');
      await page.waitForFunction(() => document.querySelector('#keys')!.scrollTop > 0);
      await page.evaluate(() => document.querySelector('#keys')!.scrollTo(0, 0));
    });

    test('while a field has focus it keeps its characters, and shares the other keys', async () => {
      const { page } = fixture;
      await page.focus('#field');
      await page.keyboard.type('s s');
      expect(await page.inputValue('#field')).toBe('s s');
      expect(await text('#log')).toBe('space,enter,enter,down,space');

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      expect(await text('#log')).toBe('space,enter,enter,down,space,down,enter');

      await page.focus('#area');
      await page.keyboard.type('a');
      await page.keyboard.press('Enter');
      await page.keyboard.type('b');
      // The handler ran, and the textarea still got its line break.
      expect(await page.inputValue('#area')).toBe('a\nb');
      expect(await text('#log')).toBe('space,enter,enter,down,space,down,enter,enter');
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    });

    test('with Ctrl held the handler runs and the default action is left alone', async () => {
      const { page } = fixture;
      const prevented = await page.evaluate(() => {
        const plain = new KeyboardEvent('keydown', { key: 's', cancelable: true, bubbles: true });
        const shortcut = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, bubbles: true });
        document.body.dispatchEvent(plain);
        document.body.dispatchEvent(shortcut);
        return [plain.defaultPrevented, shortcut.defaultPrevented];
      });
      expect(prevented).toEqual([true, false]);
      expect((await text('#log'))!.endsWith(',s,ctrl+s')).toBe(true);
    });
  });

  describe('after and every', () => {
    test('run while the screen is open, in its scope', async () => {
      const { page } = fixture;
      await page.waitForFunction(() => (window as unknown as { timers: Timers }).timers.after.includes('soon'));
      await page.click('#later');
      await page.waitForFunction(() => (window as unknown as { timers: Timers }).timers.after.includes('from a handler'));
      expect((await timers()).after).toEqual(['soon', 'from a handler']);
      await page.waitForFunction(() => Number(document.querySelector('#ticks')!.textContent) >= 3);
    });
  });

  describe('Escape', () => {
    test('closes only the screen in use, one at a time', async () => {
      const { page } = fixture;
      await fixture.open('dialog');
      await page.keyboard.press('Escape');
      expect(await closes()).toEqual([{ t: 'close', screen: 'dialog' }]);

      // Lua closes it, and the next Escape goes to the screen that is now on top.
      await fixture.lua({ t: 'close', screen: 'dialog' });
      await page.keyboard.press('Escape');
      expect(await closes()).toEqual([{ t: 'close', screen: 'dialog' }, { t: 'close', screen: 'keys' }]);
    });

    test('goes past an overlay that takes no focus, and stops at a screen that does not close', async () => {
      const { page } = fixture;
      await fixture.open('toast');
      await page.keyboard.press('Escape');
      expect((await closes()).pop()).toEqual({ t: 'close', screen: 'keys' });
      const before = (await closes()).length;

      await fixture.open('locked');
      await page.keyboard.press('Escape');
      expect(await closes()).toHaveLength(before);
      await fixture.lua({ t: 'close', screen: 'locked' });
      await fixture.lua({ t: 'close', screen: 'toast' });
    });
  });

  describe('closing', () => {
    test('stops the timers and the sounds the screen owns, and lets a kept sound finish', async () => {
      const { page } = fixture;
      // How long each sound was heard, in the order they ended. The file is one second long.
      await page.evaluate(() => {
        const heard: number[] = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          const began = performance.now();
          this.addEventListener('ended', () => heard.push(performance.now() - began));
          return start.apply(this, args);
        };
        (window as unknown as { heard: number[] }).heard = heard;
      });
      const heard = (): Promise<number[]> => page.evaluate(() => (window as unknown as { heard: number[] }).heard);

      await page.click('#owned');
      await page.click('#kept');
      await page.waitForTimeout(100);
      await fixture.lua({ t: 'close', screen: 'keys' });
      expect(await fixture.nodes()).toBe(0);

      const ticking = await timers();
      await page.waitForTimeout(120);
      expect(await timers()).toEqual(ticking);
      expect(ticking.after).not.toContain('cancelled');
      expect(ticking.after).not.toContain('never');

      // The owned sound was cut when the screen closed. The kept one played to its end.
      await page.waitForFunction(() => (window as unknown as { heard: number[] }).heard.length === 2, undefined, { timeout: 5000 });
      const [cut, kept] = await heard();
      expect(cut).toBeLessThan(600);
      expect(kept).toBeGreaterThan(900);
      expect(fixture.errors).toEqual([]);
    });
  });

  describe('the build', () => {
    test('has no trace of dev.action: not the call, not its label, not the function behind it', async () => {
      const scripts = await builtScripts();
      const names = Object.keys(scripts);
      const screen = names.find((name) => name.startsWith('Keys-')) as string;
      expect(scripts[screen]).toContain('dev helper: ');
      for (const name of names) {
        const code = scripts[name] as string;
        for (const gone of ['Only under nexus dev', 'a build must not contain this', 'Registered by a plain module', 'nor this', 'Never shown in a build', '.action(']) {
          expect(code.includes(gone), `${name} contains ${JSON.stringify(gone)}`).toBe(false);
        }
      }
    });
  });
});
