/** How long the cursor stays after the last thing the mouse did. */
const HIDE_AFTER = 3000;

const ARROW =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M4 2v17l4.4-4.1 3 6.6 2.7-1.2-3-6.5h6z' fill='%23fff' stroke='%23000' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E\")";

/**
 * Draws the cursor of a display. A browser that is drawn on a prop has none of its own, so the
 * page shows one where the mouse was last sent, and puts it away when the mouse has been quiet
 * for a few seconds. The element is `[data-nexus-cursor]`, for a page that wants its own look.
 */
export function drawCursor(): (shown: boolean) => void {
  const cursor = document.createElement('div');
  cursor.dataset.nexusCursor = '';
  // The tip of the arrow is 4 pixels in and 2 down, which is where the pointer is.
  cursor.style.cssText = `position:fixed;left:-4px;top:-2px;z-index:2147483647;width:24px;height:24px;pointer-events:none;display:none;background:${ARROW}`;

  // In a browser with a cursor of its own, as under `nexus dev`, there would be two.
  const style = document.createElement('style');
  style.textContent = '*{cursor:none!important}';
  document.head.append(style);
  document.documentElement.append(cursor);

  let timer = 0;
  const show = (event: MouseEvent): void => {
    cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
    cursor.style.display = '';
    clearTimeout(timer);
    timer = window.setTimeout(() => (cursor.style.display = 'none'), HIDE_AFTER);
  };
  for (const name of ['mousemove', 'mousedown', 'mouseup', 'wheel']) addEventListener(name, show as EventListener, true);

  // While the game's own cursor points at the prop's screen, a second one would only be in the way.
  return (shown) => {
    cursor.style.visibility = shown ? '' : 'hidden';
  };
}
