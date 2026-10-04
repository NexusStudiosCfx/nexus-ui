import type { Contract } from './contract';
import { generateLua } from './lua';
import { generateTypes } from './types';

export { contract, isContract, DEFAULT_RATE } from './contract';
export type {
  Call,
  CallDefinition,
  CallError,
  CallInput,
  CallName,
  CallOutput,
  ClientData,
  ClientName,
  Contract,
  ContractDefinition,
  PushData,
  PushName,
  Rate,
  ScreenData,
  ScreenName,
  StateData,
  StateName,
} from './contract';
export { ContractError } from './errors';
export { generateLua, type LuaOptions } from './lua';
export { isMock, isRejection, mock, reject } from './mock';
export type { LocaleTable, Mock, MockContext, MockDefinition, Rejection } from './mock';
export { LIMITS, patchOf, s } from './schema';
export type { Infer, InferObject, NullableSchema, OptionalSchema, ArrayOptions, JsonOptions, RangeOptions, Schema, SizeOptions, StringOptions } from './schema';
export { generateTypes, type TypesOptions } from './types';
export { validate, type Validation } from './validate';

export interface GenerateOptions {
  /** The contract file as it should be named in the generated headers. Default: `web/contract.ts`. */
  source?: string;
  /** The module whose `NexusContract` interface the types fill in. Default: `nexus`. */
  module?: string;
}

export interface Generated {
  /** A declaration file that types `nui` for this contract. */
  types: string;
  /** The content of `nexus/contract.lua`: validators and rate limits for both Lua runtimes. */
  lua: string;
}

/**
 * Generates everything that is derived from a contract. The Vite plugin writes `types` next to
 * the contract while you work; `nexus build` writes `lua` into the resource.
 *
 * @example
 * const { types, lua } = generate(contract);
 */
export function generate(contract: Contract, options: GenerateOptions = {}): Generated {
  return {
    types: generateTypes(contract, options),
    lua: generateLua(contract, options),
  };
}
