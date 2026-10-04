/** Samples for "how it works": a screen, its contract, and the Lua that answers and opens it. */

export const screen = `
---
import { signal, nui, t } from 'nexus';

interface Props {
  item: string;
  price: number;
}

const amount = signal(1);

async function buy() {
  const input = { item: props.item, amount: amount.value };
  const { balance } = await nui.call('shop:buy', input);
}
---

<screen focus="mouse keyboard" close="escape" size="1920x1080" />

<section class="shop" class:busy={nui.pending('shop:buy')}>
  <h1>{t('shop.title')}</h1>
  <input type="number" bind:value={amount} min="1">
  <button on:click={buy}>{t('shop.buy')}</button>
</section>

<style>
  .shop.busy { opacity: 0.6; }
</style>
`;

export const contract = `
import { contract, s } from 'nexus/contract';

export default contract({
  calls: {
    'shop:buy': {
      input: s.object({
        item: s.string({ max: 40 }),
        amount: s.int({ min: 1, max: 100 }),
      }),
      output: s.object({ ok: s.boolean(), balance: s.int() }),
      rate: { limit: 5, per: 10 },
    },
  },
});
`;

export const server = `
Nexus.handle('shop:buy', function(source, data)
    -- data is { item = string, amount = 1..100 } and nothing else.
    -- The contract saw to that.
    return { ok = true, balance = 120 }
end)
`;

export const client = `
RegisterCommand('shop', function()
    Nexus.open('shop', { item = 'water', price = 5 })
end, false)
`;

export const start = `
$ npm run build
ok web/dist (4 files)
ok nexus/contract.lua, nexus/screens.lua, nexus/client.lua, nexus/server.lua
ok fxmanifest.lua loads the bridge and ships web/dist
`;
