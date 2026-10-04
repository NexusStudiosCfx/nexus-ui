/**
 * The keyboard of a display. A browser drawn on a prop receives no key events: the game can only
 * inject the mouse into it. Text and keys therefore arrive as messages from Lua, and this module
 * does to the page what the keyboard would have done: a `keydown` that handlers can take, then
 * the edit, the click or the move of focus that the browser would have made of it.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;

const NOT_TEXT = /^(?:button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/;
const PRESSED_BY_ENTER = 'button,a[href],summary,input[type=button],input[type=submit],input[type=reset]';
const PRESSED_BY_SPACE = `${PRESSED_BY_ENTER},input[type=checkbox],input[type=radio]`;
const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]';

const MOVES: Record<string, [direction: string, granularity: string]> = {
  ArrowLeft: ['backward', 'character'],
  ArrowRight: ['forward', 'character'],
  ArrowUp: ['backward', 'line'],
  ArrowDown: ['forward', 'line'],
  Home: ['backward', 'lineboundary'],
  End: ['forward', 'lineboundary'],
};

function target(): HTMLElement {
  return (document.activeElement as HTMLElement | null) || document.body;
}

let marked: Element | null = null;

/**
 * Puts `data-nexus-focus` on the element that has the focus. The game never gives its focus to a
 * browser on a prop, and to a browser without it `:focus` matches nothing: a field that was
 * clicked takes what is typed and looks no different. A style for `[data-nexus-focus]` shows it.
 */
export function markFocus(): void {
  const element = document.activeElement;
  const next = element && element !== document.body ? element : null;
  if (next === marked) return;
  if (marked) marked.removeAttribute('data-nexus-focus');
  if (next) next.setAttribute('data-nexus-focus', '');
  marked = next;
}

function isField(element: Element): element is Field {
  return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !NOT_TEXT.test(element.type));
}

/** Dispatches a key event where the keyboard would have. False when a handler took the key. */
function fire(type: 'keydown' | 'keyup', key: string): boolean {
  return target().dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

/**
 * Replaces the selection of a field with `text`. An empty selection is first widened by `back`
 * characters before the caret and `forward` after it, which is how Backspace and Delete erase.
 * Only used where the browser's own editing refuses, so it knows text fields and nothing else.
 */
function splice(field: Field, text: string, back: number, forward: number): void {
  if (field.disabled || field.readOnly) return;
  const { value } = field;
  let start = field.selectionStart;
  let end = field.selectionEnd;
  const room = field.maxLength < 0 ? text.length : Math.max(0, field.maxLength - value.length + ((end ?? 0) - (start ?? 0)));
  const added = text.slice(0, room);
  if (start === null || end === null) {
    // A field without a caret, such as a number: edit the end of what it holds.
    field.value = value.slice(0, value.length - back) + added;
  } else {
    if (start === end) {
      start = Math.max(0, start - back);
      end = Math.min(value.length, end + forward);
    }
    if (start === end && !added) return;
    field.setRangeText(added, start, end, 'end');
  }
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: added || null, inputType: added ? 'insertText' : 'deleteContentBackward' }));
}

/** Edits what has the focus the way the browser does for a key, events and undo included. */
function edit(command: 'insertText' | 'delete' | 'forwardDelete', text = ''): void {
  if (document.execCommand(command, false, text)) return;
  const field = target();
  if (isField(field)) splice(field, text, +(command === 'delete'), +(command === 'forwardDelete'));
}

function editable(element: HTMLElement): boolean {
  return isField(element) || element.isContentEditable;
}

/** Moves the focus to the next element that takes it, in document order, and back to the first. */
function focusNext(): void {
  const items = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (item) => item.tabIndex >= 0 && !(item as HTMLButtonElement).disabled && item.getClientRects().length > 0,
  );
  const next = items[(items.indexOf(target()) + 1) % items.length];
  if (!next) return;
  next.focus();
  if (isField(next)) next.select();
}

/** Types text: each character is a key that a handler may take, and otherwise goes into the focused field. */
export function type(text: string): void {
  for (const character of text) {
    if (fire('keydown', character)) {
      const element = target();
      if (character === ' ' && !editable(element) && element.matches(PRESSED_BY_SPACE)) element.click();
      else edit('insertText', character);
    }
    fire('keyup', character);
  }
  markFocus();
}

/** Presses a key that is not a character: Backspace, Delete, Enter, Tab, Escape, the arrows, Home, End. */
export function press(key: string): void {
  if (fire('keydown', key)) {
    const element = target();
    const move = MOVES[key];
    if (key === 'Backspace') edit('delete');
    else if (key === 'Delete') edit('forwardDelete');
    else if (key === 'Tab') focusNext();
    else if (move && editable(element)) getSelection()?.modify('move', move[0], move[1]);
    else if (key === 'Enter') {
      if (element instanceof HTMLInputElement && isField(element)) element.form?.requestSubmit();
      else if (editable(element)) edit('insertText', '\n');
      else if (element.matches(PRESSED_BY_ENTER)) element.click();
    }
  }
  fire('keyup', key);
  markFocus();
}
