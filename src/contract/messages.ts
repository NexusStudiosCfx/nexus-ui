import { LIMITS } from './schema';

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * The wording of every validation failure. The TypeScript validator and the generated Lua both
 * take their text from here, so a rejected value reads the same in the browser and in game.
 */
export const messages = {
  string: 'expected a string',
  malformed: 'expected well-formed text',
  int: 'expected an integer',
  number: 'expected a number',
  boolean: 'expected true or false',
  array: 'expected an array',
  object: 'expected an object',
  keys: `expected text keys of at most ${LIMITS.keyMax} characters`,
  none: 'expected no value',
  union: 'expected a value that matches one of the allowed shapes',
  json: (maxBytes: number, maxDepth: number) => `expected JSON data of at most ${plural(maxBytes, 'byte')}, nested at most ${maxDepth} deep`,
  unknownKey: 'unknown key',
  atLeast: (min: number) => `expected at least ${min}`,
  atMost: (max: number) => `expected at most ${max}`,
  minChars: (min: number) => `expected at least ${plural(min, 'character')}`,
  maxChars: (max: number) => `expected at most ${plural(max, 'character')}`,
  minItems: (min: number) => `expected at least ${plural(min, 'item')}`,
  maxItems: (max: number) => `expected at most ${plural(max, 'item')}`,
  maxEntries: (max: number) => `expected at most ${max} ${max === 1 ? 'entry' : 'entries'}`,
  pattern: (source: string) => `expected text matching ${source}`,
  oneOf: (values: readonly string[]) => `expected one of ${values.map((value) => JSON.stringify(value)).join(', ')}`,
  literal: (value: string | number | boolean) => `expected ${JSON.stringify(value)}`,
} as const;

/** An unknown key is named in the message only while it is short enough to be worth reading. */
export const UNKNOWN_KEY_MAX_BYTES = 40;
