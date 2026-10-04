import { mock } from 'nexus/contract';
import locale from '../locales/en.json';
import contract from './contract';

// What stands in for the game under `nexus dev`: the props each screen opens with, and handlers
// that answer calls the way server/main.lua does.
export default mock(contract, {
  locale,
  screens: {
    main: { name: 'Player' },
  },
  calls: {
    greet: (input) => ({ message: `Hello ${input.name}. This answer comes from web/mock.ts.` }),
  },
});
