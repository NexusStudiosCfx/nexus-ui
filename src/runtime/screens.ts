import { signal } from '@preact/signals-core';
import { attach } from './blocks';
import { onKey } from './keys';
import { currentScope, setFallbackScope, type Scope } from './scope';
import { patch, readonly, store } from './store';

type Props = Record<string, unknown>;

/** What a compiled screen file exports. */
export interface ScreenModule {
  default: (props: Props) => Node;
  /** The `<screen>` declaration. Only what the page itself acts on is read here. */
  screen?: {
    focus?: { mouse: boolean; keyboard: boolean };
    close?: 'escape' | 'none';
    size?: { width: number; height: number } | null;
    layer?: 'screen' | 'hud';
    cursor?: string | null;
  };
}

export type ScreenLoader = () => Promise<ScreenModule>;

interface OpenScreen {
  props: Props;
  element?: HTMLElement;
  size?: { width: number; height: number } | null;
  /** The screen takes the mouse or the keyboard, so it can be the one the player is using. */
  focus?: boolean;
  scope?: Scope | null;
  close?: () => void;
}

const loaders: Record<string, ScreenLoader> = {};
const open = new Map<string, OpenScreen>();
// The screen the player is using: the last one opened that takes focus. Lua picks the same one.
let focused: OpenScreen | undefined;

/** How many screens are open. */
export const openScreens = /* @__PURE__ */ signal(0);

/**
 * The factor by which the screen with a design size (`<screen size="1920x1080">`) is scaled to
 * fit the window. With several sized screens open it is the factor of the one opened last.
 *
 * @example
 * const x = (event.clientX - rect.left) / scale.value;
 */
export const scale = /* @__PURE__ */ signal(1);

/** Asks for a screen to be closed. The bridge replaces it, so that Lua decides and releases focus. */
export const requests = { close: closeScreen };

export function defineScreens(screens: Record<string, ScreenLoader>): void {
  Object.assign(loaders, screens);
}

function fit(): void {
  let factor = 1;
  for (const { element, size } of open.values()) {
    if (element && size) {
      factor = Math.min(innerWidth / size.width, innerHeight / size.height);
      element.style.transform = `translate(-50%, -50%) scale(${factor})`;
      element.style.setProperty('--nexus-scale', `${factor}`);
    }
  }
  scale.value = factor;
}

/** Updates what depends on the set of open screens: the count, who has focus, the owner of stray calls, the resize listener. */
function refresh(): void {
  const entries = [...open.values()];
  openScreens.value = entries.length;
  focused = undefined;
  for (const entry of entries) if (entry.focus) focused = entry;
  // The screen in use, not the hud under it, is where code that lost its owner most likely came from.
  setFallbackScope((focused || entries[0] || {}).scope || null);
  removeEventListener('resize', fit);
  if (entries.some((entry) => entry.size)) addEventListener('resize', fit);
  fit();
}

function show(name: string, entry: OpenScreen, module: ScreenModule): void {
  const { focus, close, size, layer, cursor } = module.screen || {};
  const element = document.createElement('div');
  element.dataset.screen = name;
  const hud = layer === 'hud';
  entry.element = element;
  entry.size = size;
  entry.focus = !hud && (!focus || focus.mouse || focus.keyboard);
  // Screens stack in the order they open, with every hud below every other screen. A sized
  // screen is a box of its design size, centred and scaled as a whole.
  element.style.cssText = `position:fixed;z-index:${+!hud};cursor:${cursor || ''};${size ? `left:50%;top:50%;width:${size.width}px;height:${size.height}px` : 'inset:0'}`;
  document.body.append(element);

  entry.close = attach(
    () => {
      entry.scope = currentScope();
      // Escape closes one screen: the one in use. A screen under it stays until it is on top.
      if (close !== 'none') onKey('Escape', () => focused === entry && requests.close(name));
      return module.default(readonly(entry.props));
    },
    element,
    () => element.remove(),
  );
  refresh();
}

/** Opens a screen, loading its code the first time. Opening an open screen replaces its props. */
export function openScreen(name: string, props: Props = {}): void {
  const current = open.get(name);
  if (current) return patch(current.props, props);

  const load = loaders[name];
  const entry: OpenScreen = { props: store({ ...props }) };
  open.set(name, entry);
  (load ? load() : Promise.reject(new Error(`[nexus] web/screens has no screen "${name}"`)))
    .then((module) => {
      // It may have been closed, or closed and opened again, while its code was loading.
      if (open.get(name) === entry) show(name, entry, module);
    })
    .catch((error) => {
      // Lua gave this screen the focus when it opened it. A screen that cannot be shown has to
      // give it back, or the player is left with a cursor and nothing to click.
      if (open.get(name) === entry) {
        closeScreen(name);
        if (entry.element) entry.element.remove();
        requests.close(name);
      }
      throw error;
    });
}

/** Closes a screen: stops everything it owns, then removes its nodes once they have animated out. */
export function closeScreen(name: string): void {
  const entry = open.get(name);
  if (!entry) return;
  open.delete(name);
  refresh();
  if (entry.close) entry.close();
}

/**
 * Swaps in a new version of a screen's code and, when it is open, mounts it again with the same
 * props. Only hot reload calls it, so a build carries none of it.
 */
export function reloadScreen(name: string, module: ScreenModule): void {
  if (globalThis.__NEXUS_DEV__) {
    loaders[name] = async () => module;
    const entry = open.get(name);
    if (entry) {
      closeScreen(name);
      openScreen(name, { ...entry.props });
    }
  }
}
