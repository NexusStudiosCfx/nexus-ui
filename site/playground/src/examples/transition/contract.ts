import { contract, s } from 'nexus/contract';

export default contract({
  // Lua to page, with nothing coming back: Nexus.push('notify', { ... }).
  pushes: {
    notify: s.object({
      id: s.int({ min: 1 }),
      kind: s.enum(['info', 'success', 'warning']),
      text: s.string({ max: 80 }),
    }),
  },
});
