import { mock, reject } from 'nexus/contract';
import contract from './contract';

const prices = { water: 5, bandage: 40, armour: 900 };

// The player's wallet as the server knows it.
const wallet = { balance: 120 };

export default mock(contract, {
  // What Lua opens the screen with: Nexus.open('main', { balance = ... }).
  screens: {
    main: wallet,
  },
  calls: {
    // Stands in for Nexus.handle('shop:buy', ...) on the server. The input has
    // passed the contract by the time it gets here, and the answer is checked too.
    'shop:buy': async ({ item }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const price = prices[item];
      const missing = price - wallet.balance;
      if (missing > 0) return reject('not_enough_money', { missing });
      wallet.balance -= price;
      return { balance: wallet.balance };
    },
  },
});
