/**
 * The page of the resource while a player operates a display. The game gives its input focus to
 * that page, not to the browser on the prop, so the page passes on what it receives: Lua gets
 * the mouse and the keyboard as `input` messages and hands them to the display.
 */

export type Input =
  | { kind: 'pointer'; x: number; y: number }
  | { kind: 'press' | 'release'; button: string; x: number; y: number }
  | { kind: 'scroll'; lines: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'leave' | 'ready' };

type Send = (input: Input) => void;

const KEYS = /^(?:Backspace|Delete|Enter|Tab|Escape|Arrow(?:Left|Right|Up|Down)|Home|End)$/;
const WALKING = /^Key[WASD]$/;
const BUTTONS = ['left', 'middle', 'right'];
/** How long a walking key is held before it means the player wants to walk away. */
const LEAVE_AFTER = 600;
/** One notch of a wheel is three lines, which a browser reports as 100 pixels. */
const PIXELS_PER_LINE = 100 / 3;
const MAX_PASTE = 1024;

/**
 * What a key press means to a display: text to type, a key to press, or nothing. A key held with
 * Ctrl, Alt or Meta is a shortcut and is left alone. AltGr reports both Ctrl and Alt, and types.
 */
export function keyMessage(event: KeyboardEvent): Extract<Input, { kind: 'type' | 'key' }> | null {
  if (event.metaKey || event.ctrlKey !== event.altKey) return null;
  if (event.key.length === 1) return { kind: 'type', text: event.key };
  return KEYS.test(event.key) ? { kind: 'key', key: event.key } : null;
}

/**
 * Forwards the mouse and the keyboard of this page until the returned function is called. What
 * is forwarded stops here: the screens of the page are not what the player is using, so none of
 * it clicks a button of theirs or runs a key handler of theirs.
 */
export function capture(send: Send): () => void {
  let frame = 0;
  let leave = 0;
  let x = 0;
  let y = 0;

  const flush = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const at = (event: MouseEvent): void => {
    x = event.clientX / innerWidth;
    y = event.clientY / innerHeight;
  };

  const handlers: Record<string, (event: never) => void> = {
    // A mouse reports far more often than a frame is drawn. One position per frame is enough.
    mousemove(event: MouseEvent) {
      at(event);
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        send({ kind: 'pointer', x, y });
      });
    },
    mousedown(event: MouseEvent) {
      event.preventDefault();
      at(event);
      flush();
      send({ kind: 'press', button: BUTTONS[event.button] || 'left', x, y });
    },
    mouseup(event: MouseEvent) {
      at(event);
      flush();
      send({ kind: 'release', button: BUTTONS[event.button] || 'left', x, y });
    },
    wheel(event: WheelEvent) {
      const lines = Math.round(event.deltaY / (event.deltaMode ? 1 : PIXELS_PER_LINE));
      if (lines) send({ kind: 'scroll', lines });
    },
    keydown(event: KeyboardEvent) {
      if (WALKING.test(event.code)) leave ||= window.setTimeout(() => send({ kind: 'leave' }), LEAVE_AFTER);
      const message = keyMessage(event);
      if (!message) return;
      event.preventDefault();
      send(message);
    },
    keyup(event: KeyboardEvent) {
      if (WALKING.test(event.code)) {
        clearTimeout(leave);
        leave = 0;
      }
    },
    paste(event: ClipboardEvent) {
      event.preventDefault();
      const text = event.clipboardData?.getData('text').replace(/\r/g, '').slice(0, MAX_PASTE);
      if (text) send({ kind: 'type', text });
    },
    contextmenu(event: MouseEvent) {
      event.preventDefault();
    },
  };

  const names = [...Object.keys(handlers), 'click', 'dblclick', 'auxclick'];
  const listener = (event: Event): void => {
    event.stopPropagation();
    handlers[event.type]?.(event as never);
  };
  for (const name of names) addEventListener(name, listener, true);
  // The cursor the player follows is the one the display draws.
  const root = document.documentElement;
  const cursor = root.style.cursor;
  root.style.cursor = 'none';
  return () => {
    for (const name of names) removeEventListener(name, listener, true);
    root.style.cursor = cursor;
    flush();
    clearTimeout(leave);
  };
}
