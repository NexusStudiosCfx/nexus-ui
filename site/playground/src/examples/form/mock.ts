import { mock } from 'nexus/contract';
import contract from './contract';

export default mock(contract, {
  calls: {
    'vehicle:register': ({ colour }) => ({ fee: colour === 'lime' ? 450 : 300 }),
  },
});
