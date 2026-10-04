import { isContract, isMock } from '../../contract';
import { keyMessage } from '../../runtime/world/capture';
import { createHost, type Host, type HostOptions, type Surface } from './core';
import { createToolbar, rememberedFrames, type FrameId } from './toolbar';

export type { HostOptions, HostScreen } from './core';

declare global {
  interface Window {
    /** Set by the mock host in the top window, for the pages inside its frames. */
    __NEXUS_DEV_HOST__?: Host;
  }
}

const OPEN_KEY = 'nexus-dev:open';

/**
 * Installs the mock host in a browser: `window.__NEXUS_HOST__`, which the page's bridge talks to
 * instead of the game, the dev toolbar, a phone and a tablet frame for the apps, and a frame for
 * each world screen.
 *
 * Inside the game it does nothing, so a page served by `nexus dev --game` talks to real Lua. The
 * game puts `invokeNative` in every page it loads, a display and the frame of an app included.
 */
export function installHost(given: HostOptions): void {
  if (typeof window.GetParentResourceName === 'function' || 'invokeNative' in window) return;

  // The page inside a frame is this same page. It gets no host of its own: it talks to the one
  // in the window that holds the frame, as its surface.
  const query = new URLSearchParams(location.search);
  const surface = query.get('surface');
  if (surface === 'phone' || surface === 'tablet' || surface === 'world') {
    const outer = window.parent !== window ? window.parent.__NEXUS_DEV_HOST__ : undefined;
    const page: Exclude<Surface, 'main'> = surface === 'world' ? `world:${query.get('screen')}` : surface;
    if (!outer) {
      const what = surface === 'world' ? 'a world screen' : `the ${surface} app`;
      console.error(`[nexus] this address is ${what}. Open it from its button in the bar of the dev page.`);
      return;
    }
    window.__NEXUS_HOST__ = outer.frame(page);
    if (surface === 'world') forwardKeyboard((message) => outer.send(page, message));
    return;
  }

  if (!isContract(given.contract)) {
    console.error('[nexus] web/contract.ts has no contract as its default export. End the file with: export default contract({ ... });');
    return;
  }
  let options = given;
  if (given.mock !== null && !isMock(given.mock)) {
    console.error('[nexus] web/mock.ts has no mock as its default export. End the file with: export default mock(contract, { ... });');
    options = { ...given, mock: null };
  }

  const plain = options.screens.filter((screen) => !screen.surface).map((screen) => screen.name);
  const apps = options.screens.flatMap((screen) => (screen.surface && screen.surface !== 'world' ? [screen.surface] : []));
  const worlds = options.screens.flatMap((screen) => (screen.surface === 'world' && screen.size ? [{ name: screen.name, ...screen.size }] : []));
  const frames: FrameId[] = [...apps, ...worlds.map((world): FrameId => `world:${world.name}`)];

  // Read before the host exists: a mock that opens a screen in its setup overwrites the list.
  let restored: unknown;
  try {
    restored = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? '[]');
  } catch {
    restored = [];
  }

  const toolbar = createToolbar({
    resource: options.resource,
    screens: plain,
    apps,
    worlds,
    hasMock: options.mock !== null,
    toggle: (name) => (host.isOpen(name) ? host.close(name) : host.open(name)),
    frameChanged(frame, shown) {
      if (!shown) host.closeFrame(frame);
    },
  });

  const host: Host = createHost(options, {
    opened(names) {
      toolbar.setOpen(names);
      try {
        sessionStorage.setItem(OPEN_KEY, JSON.stringify(names));
      } catch {
        // Storage can be unavailable (private mode): the open screens are then not restored on reload.
      }
    },
    crossed: toolbar.log,
    action: toolbar.addAction,
  });
  window.__NEXUS_HOST__ = host.bridge;
  window.__NEXUS_DEV_HOST__ = host;

  // What was open before a full reload comes back, so a change that cannot be hot-swapped
  // does not cost the place you were working on.
  for (const name of Array.isArray(restored) ? restored : []) {
    if (plain.includes(name as string) && !host.isOpen(name as string)) host.open(name as string);
  }
  for (const frame of rememberedFrames()) {
    if (frames.includes(frame)) toolbar.showFrame(frame);
  }
}

/**
 * The keyboard of a world screen in its frame. In game a display has none: the page of the
 * resource forwards the keys to Lua, and Lua sends the display `type` and `key` messages. Here
 * the frame has the browser's keyboard, so the keys are taken from it and sent the same way,
 * and what is typed goes down the path it takes in game. Escape ends operating there, and is
 * not sent here either.
 */
function forwardKeyboard(send: (message: Record<string, unknown>) => void): void {
  const forward = (event: KeyboardEvent): void => {
    // The page makes key events of its own out of the messages. Those are for its handlers.
    if (!event.isTrusted) return;
    event.stopPropagation();
    const message = event.type === 'keydown' ? keyMessage(event) : null;
    if (!message) return;
    event.preventDefault();
    if (message.kind === 'type') send({ t: 'type', text: message.text });
    else if (message.key !== 'Escape') send({ t: 'key', key: message.key });
  };
  addEventListener('keydown', forward, true);
  addEventListener('keyup', forward, true);
  addEventListener(
    'paste',
    (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text').replace(/\r/g, '');
      if (text) send({ t: 'type', text });
    },
    true,
  );
}
