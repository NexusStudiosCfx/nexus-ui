/** Thrown when a schema or a contract is written in a way the bridge cannot enforce. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}
