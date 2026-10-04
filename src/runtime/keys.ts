import { currentScope, invoke, own, type Scope } from './scope';

type Handler = (event: KeyboardEvent) => void;

const bindings = new Set<[key: string, handler: Handler, scope: Scope | null]>();

function onKeyDown(event: KeyboardEvent): void {
  const pressed = event.key.toLowerCase();
  // The target can also be the document, which has neither of these members.
  const target = event.target as HTMLElement;
  const typing = target.isContentEditable || target.matches?.('input,textarea,select');
  // A hotkey on a letter must not fire while the player types that letter into a field.
  if (typing && pressed.length === 1) return;

  const taken = [...bindings].filter(([key]) => key === pressed);
  // The handler takes the key: without this, Space or Enter would also click the focused button.
  // A field keeps its keys, and so does the browser when Ctrl, Alt or Meta makes it a shortcut.
  if (taken.length && !typing && !event.ctrlKey && !event.altKey && !event.metaKey) event.preventDefault();
  for (const [, handler, scope] of taken) invoke(scope, handler, event);
}

/**
 * Calls `handler` when `key` is pressed while the component is mounted. `key` is a
 * `KeyboardEvent.key` value, in any case: `'Escape'`, `'Enter'`, `'e'`, `' '`.
 *
 * A key with a handler does nothing else: it does not also click the focused button or scroll.
 * While an input, textarea or select has focus, character keys do not reach handlers, and any
 * other key reaches both the handler and the field.
 *
 * @example
 * onKey('Enter', confirm);
 */
export function onKey(key: string, handler: Handler): () => void {
  const binding: [string, Handler, Scope | null] = [key.toLowerCase(), handler, currentScope()];
  if (!bindings.size) addEventListener('keydown', onKeyDown);
  bindings.add(binding);
  return own(() => {
    bindings.delete(binding);
    if (!bindings.size) removeEventListener('keydown', onKeyDown);
  });
}
