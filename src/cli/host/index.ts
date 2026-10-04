import { isContract, isMock } from '../../contract';
import { createHost, type Host, type HostOptions } from './core';
import { createToolbar, rememberedFrames, type AppSurface } from './toolbar';

export type { HostOptions, HostScreen } from './core';

declare global {
  interface Window {
    /** Set by the mock host in the top window, for the pages inside its app frames. */
    __NEXUS_DEV_FRAMES__?: Host['frame'];
  }
}

const OPEN_KEY = 'nexus-dev:open';

/**
 * Installs the mock host in a browser: `window.__NEXUS_HOST__`, which the page's bridge talks to
 * instead of the game, the dev toolbar, and a phone and a tablet frame for the apps.
 *
 * Inside the game it does nothing, so a page served by `nexus dev --game` talks to real Lua.
 */
export function installHost(given: HostOptions): void {
  if (typeof window.GetParentResourceName === 'function') return;

  // The page inside an app frame is this same page. It gets no host of its own: it talks to
  // the one in the window that holds the frame, as its surface.
  const surface = new URLSearchParams(location.search).get('surface');
  if (surface === 'phone' || surface === 'tablet') {
    const frames = window.parent !== window ? window.parent.__NEXUS_DEV_FRAMES__ : undefined;
    if (frames) window.__NEXUS_HOST__ = frames(surface);
    else console.error(`[nexus] this address is the ${surface} app. Open it from the "${surface} app" button of the dev page.`);
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
  const apps = options.screens.flatMap((screen) => (screen.surface ? [screen.surface] : []));

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
    hasMock: options.mock !== null,
    toggle: (name) => (host.isOpen(name) ? host.close(name) : host.open(name)),
    frameChanged(app: AppSurface, shown) {
      if (!shown) host.closeFrame(app);
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
  window.__NEXUS_DEV_FRAMES__ = host.frame;

  // What was open before a full reload comes back, so a change that cannot be hot-swapped
  // does not cost the place you were working on.
  for (const name of Array.isArray(restored) ? restored : []) {
    if (plain.includes(name as string) && !host.isOpen(name as string)) host.open(name as string);
  }
  for (const app of rememberedFrames()) {
    if (apps.includes(app)) toolbar.showFrame(app);
  }
}
