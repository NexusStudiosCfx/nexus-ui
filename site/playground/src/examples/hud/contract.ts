import { contract, s } from 'nexus/contract';

export default contract({
  // A named object: Lua patches it with Nexus.set, the page reads it with nui.state.
  state: {
    hud: s.object({
      speed: s.int({ min: 0, max: 400 }),
      fuel: s.int({ min: 0, max: 100 }),
      street: s.string({ max: 48 }),
    }),
  },
});
