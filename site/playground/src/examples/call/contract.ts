import { contract, s } from 'nexus/contract';

export default contract({
  calls: {
    // The page sends the item and nothing else: the price is the server's to know.
    'shop:buy': {
      input: s.object({ item: s.enum(['water', 'bandage', 'armour']) }),
      output: s.object({ balance: s.int({ min: 0 }) }),
      // What a refusal carries, by code. The page reads it from error.details.
      errors: {
        not_enough_money: s.object({ missing: s.int({ min: 1 }) }),
      },
      rate: { limit: 4, per: 5 },
    },
  },
  screens: {
    main: s.object({ balance: s.int({ min: 0 }) }),
  },
});
