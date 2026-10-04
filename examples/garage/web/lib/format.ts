import type { NexusContract } from 'nexus';

/** A vehicle as `garage:list` returns it. The type comes from web/contract.ts, not from a copy. */
export type Vehicle = NexusContract['calls']['garage:list']['output']['vehicles'][number];

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function money(amount: number): string {
  return dollars.format(amount);
}
