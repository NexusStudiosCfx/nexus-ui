/**
 * What a page needs for world screens. It is a module of its own, which the entry module of a
 * project with a world screen imports on demand, so that the page of a resource carries none of
 * it until it is used.
 *
 * It has two halves, for two pages:
 *
 * - The page inside a display, loaded as
 *   `index.html?surface=world&screen=<name>&display=<id>&resource=<name>`. It is an off-screen
 *   browser whose picture is a texture on a prop. It has no cursor and no keyboard, so this
 *   module draws the first and turns the `type` and `key` messages of Lua into the second.
 * - The page of the resource while a player operates a display. It holds the game's input
 *   focus, and forwards the mouse and the keyboard to Lua as `input` messages.
 */

import { capture, type Input } from './world/capture';
import { drawCursor } from './world/cursor';
import { markFocus, press, type } from './world/edit';

export { keyMessage, type Input } from './world/capture';

/** How long a display waits for Lua to open its screen before it shows the screen without props. */
const OPEN_WITHIN = 2000;

type Post = (message: Record<string, unknown>) => Promise<unknown>;

let release: (() => void) | undefined;
let showCursor: ((shown: boolean) => void) | undefined;

/**
 * Starts the page of a display. Lua opens the screen with its props once the page has said it is
 * ready, as it opens any screen. `mount` shows the screen without props, and does nothing when
 * it is already open: it is the fallback for a page that Lua never answered, so that what went
 * wrong is on the screen instead of behind a blank one.
 */
export function display(mount: () => void): void {
  showCursor = drawCursor();
  // A click moves the focus while the browser handles it, after this listener.
  addEventListener('mousedown', () => setTimeout(markFocus), true);
  setTimeout(mount, OPEN_WITHIN);
}

/** Handles the messages of Lua that only concern world screens. */
export function receive(message: { t?: string; text?: unknown; key?: unknown; on?: unknown }, post: Post): void {
  const { t } = message;
  if (t === 'type') type(String(message.text ?? ''));
  else if (t === 'key') press(String(message.key));
  else if (t === 'cursor') showCursor?.(Boolean(message.on));
  else if (t === 'operate') {
    if (release) release();
    release = undefined;
    if (message.on) {
      const send = (input: Input): void => void post({ t: 'input', ...input }).catch(() => {});
      release = capture(send);
      // Lua gives this page the input focus only once it knows that the page forwards it.
      send({ kind: 'ready' });
    }
  }
}
