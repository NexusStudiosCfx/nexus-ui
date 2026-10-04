import { contract, s } from 'nexus/contract';

const verdict = s.enum(['wait', 'pass', 'fail']);
// A place on the screen, from 0 to 1 across and down, as display:pointer takes it.
const point = s.object({ x: s.number({ min: 0, max: 1 }), y: s.number({ min: 0, max: 1 }) });

export default contract({
  calls: {
    // The whole chain in one question: display, client Lua, server and back.
    'worldtest:time': { output: s.object({ time: s.string({ max: 20 }) }) },
  },
  pushes: {
    // Lua asks, and the page answers with `worldtest:pong`: proof that a message reached it.
    'worldtest:ping': s.object({ nonce: s.int({ min: 0 }) }),
  },
  client: {
    // The page says it runs, where it was loaded from, whether Lua had opened it, and where
    // the things are that the test aims the pointer at.
    'worldtest:hello': s.object({ address: s.string({ max: 300 }), opened: s.boolean(), field: point, button: point, list: point }),
    'worldtest:pong': s.object({ nonce: s.int({ min: 0 }) }),
    // What the page saw of the input that Lua injected.
    'worldtest:saw': s.object({ what: s.enum(['pointer', 'click', 'wheel', 'text', 'key']), detail: s.string({ max: 80 }) }),
  },
  state: {
    // What /worldtest has found so far, so that a screenshot of the prop holds the result.
    proof: s.object({
      page: verdict,
      post: verdict,
      message: verdict,
      pointer: verdict,
      click: verdict,
      wheel: verdict,
      text: verdict,
      key: verdict,
    }),
  },
  screens: {
    proof: s.object({ model: s.string({ max: 60 }), txd: s.string({ max: 60 }), texture: s.string({ max: 60 }) }),
  },
});
