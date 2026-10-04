import { contract, s } from 'nexus/contract';

const model = s.string({ min: 1, max: 24, pattern: /^[a-z0-9_]+$/ });
const score = s.int({ min: 0, max: 100 });

const vehicle = s.object({
  model,
  label: s.string({ max: 40 }),
  class: s.enum(['compact', 'motorcycle', 'sports', 'super', 'suv']),
  price: s.int({ min: 0 }),
  speed: score,
  acceleration: score,
  handling: score,
  owned: s.boolean(),
});

export default contract({
  calls: {
    'garage:list': {
      output: s.object({ balance: s.int({ min: 0 }), vehicles: s.array(vehicle, { max: 64 }) }),
      rate: { limit: 10, per: 10 },
    },
    // The page sends the model and nothing else. The price is the server's to know.
    'garage:buy': {
      input: s.object({ model }),
      output: s.object({ balance: s.int({ min: 0 }) }),
      rate: { limit: 4, per: 10 },
      // A refusal for lack of money says how much is missing, so the page can show it.
      errors: {
        not_enough_money: s.object({ missing: s.int({ min: 1 }) }),
      },
    },
  },
  pushes: {
    'garage:balance': s.object({ balance: s.int({ min: 0 }) }),
  },
  client: {
    'garage:preview': s.object({ model }),
  },
  state: {
    hud: s.object({
      visible: s.boolean(),
      speed: s.int({ min: 0, max: 999 }),
      fuel: score,
      engine: score,
      street: s.string({ max: 64 }),
    }),
  },
});
