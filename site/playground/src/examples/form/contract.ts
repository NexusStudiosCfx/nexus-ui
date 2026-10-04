import { contract, s } from 'nexus/contract';

export default contract({
  calls: {
    // The server never trusts the checks of the page: it validates the input
    // against this before the handler runs. Loosen a check in Main.nexus and the
    // call comes back `invalid`.
    'vehicle:register': {
      input: s.object({
        owner: s.string({ min: 3, max: 24 }),
        plate: s.string({ max: 8, pattern: /^[A-Z0-9 ]{2,8}$/ }),
        colour: s.enum(['black', 'white', 'lime']),
      }),
      output: s.object({ fee: s.int({ min: 0 }) }),
    },
  },
});
