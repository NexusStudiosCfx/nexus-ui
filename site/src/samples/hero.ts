/**
 * The project on the landing page's hero: a screen that asks the server for a purchase. The page
 * shows Main.nexus, and the sandbox runs all three files when it takes the picture's place.
 */
const screen = `
---
import { signal, nui, NuiError } from 'nexus';

const amount = signal(1);
const notice = signal('');

async function buy() {
  try {
    const input = { item: props.item, amount: amount.value };
    const result = await nui.call('shop:buy', input);
    notice.value = \`Balance: $\${result.balance}\`;
  } catch (error) {
    const refusal = error instanceof NuiError ? error.message : error;
    notice.value = \`Refused. \${refusal}\`;
  }
}
---

<screen focus="mouse keyboard" close="escape" />

<section class="shop" class:busy={nui.pending('shop:buy')}>
  <h1>{props.item}</h1>
  <input type="number" bind:value={amount}>
  <button on:click={buy}>Buy for \${props.price * amount.value}</button>
  {#if notice}
    <p>{notice}</p>
  {/if}
</section>

<style>
  .shop {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    gap: 12px;
    width: 260px;
    padding: 22px;
    transform: translate(-50%, -50%);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 20px;
    background: #111113;
    color: #f5f5f5;
    font: 500 15px/1.4 'Inter', system-ui, sans-serif;
  }

  .shop.busy { opacity: 0.6; }

  h1 { margin: 0; font-size: 22px; }

  input, button {
    height: 44px;
    border-radius: 12px;
    font: inherit;
  }

  input {
    padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: #1a1a1e;
    color: inherit;
  }

  button {
    border: 0;
    background: #c8ff3d;
    color: #0b1400;
    font-weight: 600;
    cursor: pointer;
  }

  p { margin: 0; color: #a1a1aa; font-size: 14px; }
</style>
`;

const contract = `
import { contract, s } from 'nexus/contract';

export default contract({
  calls: {
    'shop:buy': {
      input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
      output: s.object({ ok: s.boolean(), balance: s.int() }),
      rate: { limit: 5, per: 10 },
    },
  },
  screens: {
    main: s.object({ item: s.string({ max: 40 }), price: s.int({ min: 0 }) }),
  },
});
`;

const mock = `
import { mock, reject } from 'nexus/contract';
import contract from './contract';

const price = 5;
let balance = 120;

export default mock(contract, {
  // What Lua opens the screen with: Nexus.open('main', { item = 'Water', price = 5 }).
  screens: {
    main: { item: 'Water', price },
  },
  calls: {
    // Stands in for Nexus.handle('shop:buy', ...) on the server.
    'shop:buy': async ({ amount }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (price * amount > balance) return reject('not_enough_money');
      balance -= price * amount;
      return { ok: true, balance };
    },
  },
});
`;

const file = (text: string) => `${text.trim()}\n`;

export const shop = {
  'Main.nexus': file(screen),
  'contract.ts': file(contract),
  'mock.ts': file(mock),
};
