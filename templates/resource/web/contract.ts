import { contract, s } from 'nexus/contract';

export default contract({
  calls: {
    greet: {
      input: s.object({ name: s.string({ min: 1, max: 24 }) }),
      output: s.object({ message: s.string({ max: 200 }) }),
      rate: { limit: 5, per: 10 },
    },
  },
});
