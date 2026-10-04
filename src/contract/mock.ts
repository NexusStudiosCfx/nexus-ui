import {
  isContract,
  type CallInput,
  type CallName,
  type CallOutput,
  type ClientData,
  type ClientName,
  type Contract,
  type ContractDefinition,
  type PushData,
  type PushName,
  type ScreenData,
  type ScreenName,
  type StateData,
  type StateName,
} from './contract';
import { ContractError } from './errors';

/** What a call handler returns to refuse a call. The UI sees a `NuiError` with this code. */
export interface Rejection {
  readonly nexusRejection: string;
  /** What the refusal carries, as the call declares it under `errors`. */
  readonly details?: unknown;
}

/**
 * Refuses a call from a mock handler, the way `Nexus.reject(code, details)` does on the server.
 *
 * @example
 * 'shop:buy': (input) => (input.amount > 3 ? reject('not_enough_stock', { left: 3 }) : { ok: true, balance: 120 })
 */
export function reject(code: string, details?: unknown): Rejection {
  if (typeof code !== 'string' || code === '' || code.length > 64) {
    throw new ContractError('reject(code): the code must be a string of 1 to 64 characters, for example "not_enough_money"');
  }
  return Object.freeze(details === undefined ? { nexusRejection: code } : { nexusRejection: code, details });
}

export function isRejection(value: unknown): value is Rejection {
  return typeof value === 'object' && value !== null && typeof (value as Rejection).nexusRejection === 'string';
}

/** What a mock handler can do besides answering: the same things client Lua can do to the UI. */
export interface MockContext<D extends ContractDefinition = ContractDefinition> {
  push<K extends PushName<D>>(name: K, data: PushData<D, K>): void;
  set<K extends StateName<D>>(name: K, patch: Partial<StateData<D, K>>): void;
  /** Removes keys from a state, as `Nexus.unset` does. */
  unset<K extends StateName<D>>(name: K, ...keys: (keyof StateData<D, K> & string)[]): void;
  open(screen: string, props?: Record<string, unknown>): void;
  close(screen?: string): void;
  /** Adds a button to the dev toolbar. Returns the function that removes it. */
  action(label: string, run: () => void): () => void;
}

export interface LocaleTable {
  readonly [key: string]: string | LocaleTable;
}

type Awaitable<T> = T | Promise<T>;

export interface MockDefinition<D extends ContractDefinition = ContractDefinition> {
  /**
   * The props each screen is opened with from the dev page. They are checked against the
   * `screens` section of the contract for the screens it lists.
   */
  screens?: { [K in ScreenName<D>]?: ScreenData<D, K> } & Record<string, Record<string, unknown>>;
  /** The strings behind `t()`, usually the resource's own locale file. */
  locale?: LocaleTable;
  /** The first value of each state object. */
  state?: { [K in StateName<D>]?: Partial<StateData<D, K>> };
  /** Stand-ins for the server handlers. A call without one is answered with `offline`. */
  calls?: {
    [K in CallName<D>]?: (input: CallInput<D, K>, context: MockContext<D>) => Awaitable<CallOutput<D, K> | Rejection>;
  };
  /** Stand-ins for the `Nexus.on` handlers of client Lua. */
  client?: { [K in ClientName<D>]?: (data: ClientData<D, K>, context: MockContext<D>) => void };
  /**
   * Runs once when the page loads. It is the place for what Lua does on its own account: a
   * loop that feeds a HUD, a push on a timer, a screen that is open from the start.
   */
  setup?: (context: MockContext<D>) => void;
}

export interface Mock<D extends ContractDefinition = ContractDefinition> {
  readonly contract: Contract<D>;
  readonly definition: MockDefinition<D>;
}

/**
 * Describes how the browser should stand in for the game while you work with `nexus dev`. Put it
 * in `web/mock.ts` as the default export. Handlers are typed by the contract, and what they
 * receive and return is validated exactly like the server would.
 *
 * @example
 * export default mock(contract, {
 *   screens: { shop: { item: 'water', price: 5, stock: 3, history: [] } },
 *   calls: { 'shop:buy': () => ({ ok: true, balance: 120 }) },
 * });
 */
export function mock<D extends ContractDefinition>(contract: Contract<D>, definition: MockDefinition<D> = {}): Mock<D> {
  if (!isContract(contract)) {
    throw new ContractError('mock(contract, definition): the first argument must be the default export of web/contract.ts');
  }
  const known: [keyof MockDefinition, Readonly<Record<string, unknown>>][] = [
    ['calls', contract.calls],
    ['client', contract.client],
    ['state', contract.state],
  ];
  for (const [section, names] of known) {
    for (const name of Object.keys(definition[section] ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(names, name)) {
        throw new ContractError(`mock: ${section}["${name}"] is not in the contract. Add it to web/contract.ts or remove it here.`);
      }
    }
  }
  return Object.freeze({ contract, definition });
}

export function isMock(value: unknown): value is Mock {
  return typeof value === 'object' && value !== null && isContract((value as Mock).contract);
}
