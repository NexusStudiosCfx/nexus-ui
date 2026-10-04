import { ContractError } from './errors';
import { isSchema, nodeOf, type Infer, type Schema } from './schema';

/** At most `limit` calls in any window of `per` seconds, counted per player and per call. */
export interface Rate {
  readonly limit: number;
  readonly per: number;
}

export interface CallDefinition {
  /** What the UI sends. Leave it out for a call that takes nothing. */
  input?: Schema;
  /** What the handler returns. Leave it out for a call that returns nothing. */
  output?: Schema;
  /** Default: 30 calls per 10 seconds. */
  rate?: Rate;
  /**
   * What a refusal may carry, by code: `Nexus.reject('not_enough_money', { missing = 40 })`.
   * A code that is not listed here can still be returned, without details.
   */
  errors?: Record<string, Schema>;
}

export interface ContractDefinition {
  /** UI to server, request and response. */
  calls?: Record<string, CallDefinition>;
  /** Server or client Lua to UI. */
  pushes?: Record<string, Schema>;
  /** UI to client Lua, fire and forget. */
  client?: Record<string, Schema>;
  /** Named objects that Lua patches and the UI reads reactively. */
  state?: Record<string, Schema>;
  /** The props of screens, by screen name. A screen that is not listed takes whatever it is given. */
  screens?: Record<string, Schema>;
}

export const DEFAULT_RATE: Rate = Object.freeze({ limit: 30, per: 10 });

export interface Call {
  readonly input: Schema | null;
  readonly output: Schema | null;
  readonly rate: Rate;
  readonly errors: Readonly<Record<string, Schema>>;
}

declare const DEFINITION: unique symbol;

/** A checked contract with every default filled in. `D` keeps the definition for type inference. */
export interface Contract<D extends ContractDefinition = ContractDefinition> {
  readonly calls: Readonly<Record<string, Call>>;
  readonly pushes: Readonly<Record<string, Schema>>;
  readonly client: Readonly<Record<string, Schema>>;
  readonly state: Readonly<Record<string, Schema>>;
  readonly screens: Readonly<Record<string, Schema>>;
  readonly [DEFINITION]?: D;
}

type Section<D, K extends keyof ContractDefinition> = D extends { readonly [P in K]: infer T } ? T : {};

export type CallName<D> = keyof Section<D, 'calls'> & string;
export type PushName<D> = keyof Section<D, 'pushes'> & string;
export type ClientName<D> = keyof Section<D, 'client'> & string;
export type StateName<D> = keyof Section<D, 'state'> & string;
export type ScreenName<D> = keyof Section<D, 'screens'> & string;

export type CallInput<D, K extends CallName<D>> = Section<D, 'calls'>[K] extends { input: infer S } ? Infer<S> : void;
export type CallOutput<D, K extends CallName<D>> = Section<D, 'calls'>[K] extends { output: infer S } ? Infer<S> : void;
export type PushData<D, K extends PushName<D>> = Infer<Section<D, 'pushes'>[K]>;
export type ClientData<D, K extends ClientName<D>> = Infer<Section<D, 'client'>[K]>;
export type StateData<D, K extends StateName<D>> = Infer<Section<D, 'state'>[K]>;
export type ScreenData<D, K extends ScreenName<D>> = Infer<Section<D, 'screens'>[K]>;

/** The refusals a call declares, as `{ code, details }` pairs. */
export type CallError<D, K extends CallName<D>> = Section<D, 'calls'>[K] extends { errors: infer E }
  ? { [C in keyof E & string]: { code: C; details: Infer<E[C]> } }[keyof E & string]
  : never;

const SECTIONS = ['calls', 'pushes', 'client', 'state', 'screens'] as const;
const NAME = /^[A-Za-z0-9_:.\-/]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkName(section: string, name: string): void {
  if (!NAME.test(name)) {
    throw new ContractError(
      `${section} "${name}": a name is 1 to 64 characters from letters, digits and _ : . - /`,
    );
  }
}

function schemaAt(where: string, value: unknown): Schema {
  if (!isSchema(value)) {
    throw new ContractError(`${where} must be a schema built with s, for example s.object({ ... })`);
  }
  return value;
}

function entries(definition: ContractDefinition, section: (typeof SECTIONS)[number]): [string, unknown][] {
  const value = definition[section];
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    throw new ContractError(`${section} must be an object that maps names to definitions`);
  }
  return Object.entries(value);
}

function rateAt(where: string, value: unknown): Rate {
  if (value === undefined) return DEFAULT_RATE;
  if (!isPlainObject(value)) {
    throw new ContractError(`${where}.rate must look like { limit: 5, per: 10 } (5 calls per 10 seconds)`);
  }
  const { limit, per } = value;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
    throw new ContractError(`${where}.rate.limit must be a whole number from 1 to 10000, got ${String(limit)}`);
  }
  if (typeof per !== 'number' || !Number.isFinite(per) || per <= 0) {
    throw new ContractError(`${where}.rate.per must be a number of seconds above 0, got ${String(per)}`);
  }
  return Object.freeze({ limit, per });
}

function errorsAt(where: string, value: unknown): Readonly<Record<string, Schema>> {
  const errors: Record<string, Schema> = Object.create(null);
  if (value === undefined) return Object.freeze(errors);
  if (!isPlainObject(value) || isSchema(value)) {
    throw new ContractError(`${where}.errors must map a code to the schema of its details, for example { not_enough_money: s.object({ missing: s.int() }) }`);
  }
  for (const [code, schema] of Object.entries(value)) {
    checkName(`${where}.errors`, code);
    errors[code] = schemaAt(`${where}.errors["${code}"]`, schema);
  }
  return Object.freeze(errors);
}

/**
 * Defines every message that crosses the bridge. Put it in `web/contract.ts` as the default
 * export: the types of `nui`, the Lua validators and the mock are all derived from it.
 *
 * @example
 * export default contract({
 *   calls: {
 *     'shop:buy': {
 *       input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
 *       output: s.object({ ok: s.boolean(), balance: s.int() }),
 *       rate: { limit: 5, per: 10 },
 *     },
 *   },
 * });
 */
export function contract<const D extends ContractDefinition>(definition: D): Contract<D> {
  if (!isPlainObject(definition)) {
    throw new ContractError('contract() takes one object with any of: calls, pushes, client, state, screens');
  }
  for (const key of Object.keys(definition)) {
    if (!(SECTIONS as readonly string[]).includes(key)) {
      throw new ContractError(`unknown section "${key}". A contract has calls, pushes, client, state and screens.`);
    }
  }

  const calls: Record<string, Call> = Object.create(null);
  for (const [name, value] of entries(definition, 'calls')) {
    checkName('calls', name);
    const where = `calls["${name}"]`;
    if (!isPlainObject(value) || isSchema(value)) {
      throw new ContractError(`${where} must be an object with any of: input, output, rate, errors`);
    }
    for (const key of Object.keys(value)) {
      if (key !== 'input' && key !== 'output' && key !== 'rate' && key !== 'errors') {
        throw new ContractError(`${where} has an unknown key "${key}". A call has input, output, rate and errors.`);
      }
    }
    calls[name] = Object.freeze({
      input: value.input === undefined ? null : schemaAt(`${where}.input`, value.input),
      output: value.output === undefined ? null : schemaAt(`${where}.output`, value.output),
      rate: rateAt(where, value.rate),
      errors: errorsAt(where, value.errors),
    });
  }

  const plain = (section: 'pushes' | 'client'): Record<string, Schema> => {
    const result: Record<string, Schema> = Object.create(null);
    for (const [name, value] of entries(definition, section)) {
      checkName(section, name);
      result[name] = schemaAt(`${section}["${name}"]`, value);
    }
    return result;
  };

  const objects = (section: 'state' | 'screens', why: string): Record<string, Schema> => {
    const result: Record<string, Schema> = Object.create(null);
    for (const [name, value] of entries(definition, section)) {
      checkName(section, name);
      const schema = schemaAt(`${section}["${name}"]`, value);
      if (nodeOf(schema).kind !== 'object') {
        throw new ContractError(`${section}["${name}"] must be an s.object, because ${why}`);
      }
      result[name] = schema;
    }
    return result;
  };

  return Object.freeze({
    calls: Object.freeze(calls),
    pushes: Object.freeze(plain('pushes')),
    client: Object.freeze(plain('client')),
    state: Object.freeze(objects('state', 'state is patched key by key')),
    screens: Object.freeze(objects('screens', 'the props of a screen are an object')),
  });
}

export function isContract(value: unknown): value is Contract {
  return isPlainObject(value) && SECTIONS.every((section) => isPlainObject(value[section]));
}
