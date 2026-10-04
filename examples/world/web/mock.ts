import { mock } from 'nexus/contract';
import contract from './contract';

// What stands in for the game under `nexus dev`. The button `proof` in the bar shows the screen
// in a frame of its size, where the mouse and the keyboard reach it the way they do on a prop.
export default mock(contract, {
  // The props Nexus.world gives the screen in client/main.lua.
  worlds: {
    proof: { props: { model: 'prop_laptop_lester2', txd: 'prop_laptop_lester2', texture: 'script_rt_tvscreen' } },
  },
  state: {
    proof: { page: 'pass', post: 'pass', message: 'pass', pointer: 'wait', click: 'wait', wheel: 'wait', text: 'wait', key: 'wait' },
  },
  calls: {
    'worldtest:time': () => ({ time: new Date().toTimeString().slice(0, 8) }),
  },
  client: {
    'worldtest:hello': (data) => console.info('the page says hello from', data.address),
    'worldtest:saw': (data) => console.info('the page saw', data.what, data.detail),
  },
});
