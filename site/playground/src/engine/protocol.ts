/**
 * What the page and the preview frame say to each other. The frame runs code the visitor typed,
 * so everything it sends is treated as text to display, never as markup or code.
 */

/** Marks a message as one of these, among whatever else is posted to either window. */
export const CHANNEL = 'nexus-sandbox';

/** The address the frame gives each module it runs, which is how a stack trace names a file. */
export const MODULE_URL = 'nexus-sandbox:///';

/** Lines of the wrapper the frame puts before the code of a module. */
export const MODULE_LINE_OFFSET = 1;

export interface RunMessage {
  type: 'run';
  /** The body of each module, by file name. */
  modules: Record<string, string>;
  hasContract: boolean;
  hasMock: boolean;
  layer: 'screen' | 'hud';
  /** The UI typeface, so that the preview does not depend on what the visitor has installed. */
  font: ArrayBuffer | null;
}

export type ToFrame = RunMessage | { type: 'open' } | { type: 'action'; id: number };

export interface CrossedAnswer {
  ok: boolean;
  code?: string;
  message?: string;
  /** The data or the details of the answer, as JSON text. */
  data?: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export type FromFrame =
  | { type: 'loaded' }
  /** The modules ran and the screen is in the document. */
  | { type: 'mounted' }
  | { type: 'error'; name: string; message: string; stack: string }
  | { type: 'opened'; names: string[] }
  | { type: 'crossed'; kind: 'call' | 'push' | 'client' | 'state'; name: string; data: string; answer?: CrossedAnswer; ms?: number }
  | { type: 'console'; level: ConsoleLevel; text: string }
  | { type: 'action-added'; id: number; label: string }
  | { type: 'action-removed'; id: number };

export interface Envelope<Message> {
  channel: typeof CHANNEL;
  message: Message;
}

export function unwrap<Message>(data: unknown): Message | null {
  const envelope = data as Envelope<Message> | null;
  return typeof envelope === 'object' && envelope !== null && envelope.channel === CHANNEL && typeof envelope.message === 'object' && envelope.message !== null
    ? envelope.message
    : null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const KINDS = ['call', 'push', 'client', 'state'];
const LEVELS = ['log', 'info', 'warn', 'error'];

/**
 * Reads a message of the frame. The code in the frame can post whatever it likes, so every
 * field is brought to the type it is declared with, and a message of no known kind is dropped.
 */
export function fromFrame(data: unknown): FromFrame | null {
  const message = unwrap<Record<string, unknown>>(data);
  if (!message) return null;
  const { type, id } = message;
  if (type === 'loaded' || type === 'mounted') return { type };
  if (type === 'error') return { type, name: text(message.name), message: text(message.message), stack: text(message.stack) };
  if (type === 'opened') return { type, names: Array.isArray(message.names) ? message.names.map(text) : [] };
  if (type === 'console') return { type, level: (LEVELS.includes(text(message.level)) ? message.level : 'log') as ConsoleLevel, text: text(message.text) };
  if (type === 'action-added' && typeof id === 'number') return { type, id, label: text(message.label) };
  if (type === 'action-removed' && typeof id === 'number') return { type, id };
  if (type !== 'crossed' || !KINDS.includes(text(message.kind))) return null;
  const crossed: Extract<FromFrame, { type: 'crossed' }> = { type, kind: message.kind as 'call', name: text(message.name), data: text(message.data) };
  const answer = message.answer as Record<string, unknown> | null | undefined;
  if (typeof answer === 'object' && answer !== null) {
    crossed.answer = { ok: answer.ok === true, code: text(answer.code), message: text(answer.message), data: text(answer.data) };
    if (typeof message.ms === 'number') crossed.ms = message.ms;
  }
  return crossed;
}
