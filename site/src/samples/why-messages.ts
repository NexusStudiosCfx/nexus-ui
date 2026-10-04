/** Samples for the first two cases of "why": a message with a typo, and a server event nobody validates. */

export const typoPage = `
// The page sends a message. Nothing checks its name or its shape.
fetch(\`https://\${GetParentResourceName()}/buyItem\`, {
  method: 'POST',
  body: JSON.stringify({ item: 'water', ammount: 2 }),
});
`;

export const typoLua = `
RegisterNUICallback('buyItem', function(data, cb)
    -- data.amount is nil, and nobody is told.
    TriggerServerEvent('shop:buy', data.item, data.amount)
    cb({})
end)
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

/** The output of `nexus check` for a screen that misspells a key of the input. */
export const typoCheck = `
$ npx nexus check
error web/screens/Shop.nexus:13:65: Object literal may only specify known properties, but 'ammount' does not exist in type '{ item: string; amount: number; }'. Did you mean to write 'amount'? (TS2561)

  11 |
  12 | async function buy() {
> 13 |   const result = await nui.call('shop:buy', { item: props.item, ammount: amount.value });
     |                                                                 ^
  14 |   balance.value = result.balance;
  15 | }

error nexus check found 1 error.
`;

export const eventServer = `
RegisterNetEvent('shop:buy', function(item, amount)
    local player = source
    -- Is item a string? Is amount a whole number above zero?
    -- How often may one player send this? Every event has to
    -- answer that by hand, and many do not.
    local price = Prices[item] * amount
    if GetMoney(player) >= price then
        RemoveMoney(player, price)
        GiveItem(player, item, amount)
    end
end)
`;

export const eventAttack = `
-- Any client can trigger the event with any value.
TriggerServerEvent('shop:buy', 'water', -1000)
`;

/** What the build writes to nexus/contract.lua for the call above, as it is. */
export const validator = `
['shop:buy'] = {
    limit = 5,
    per = 10,
    input = function(v)
        if not isTable(v) or v[1] ~= nil then return false, 'expected an object' end
        for k0 in pairs(v) do
            if not keys[1][k0] then return false, unknownKey('', k0) end
        end
        do
            local v1 = v.item
            if type(v1) ~= 'string' then return false, 'item: expected a string' end
            local n1 = utf8len(v1)
            if not n1 then return false, 'item: expected well-formed text' end
            if n1 > 40 then return false, 'item: expected at most 40 characters' end
        end
        do
            local v1 = v.amount
            if not isInt(v1) then return false, 'amount: expected an integer' end
            if v1 < 1 then return false, 'amount: expected at least 1' end
            if v1 > 100 then return false, 'amount: expected at most 100' end
        end
        return true
    end,
`;

export const handler = `
Nexus.handle('shop:buy', function(source, data)
    -- data has passed the contract: a table with item and amount, and nothing else.
    local price = prices[data.item]
    if not price then
        return Nexus.reject('unknown_item')
    end
    if not removeMoney(source, price * data.amount) then
        return Nexus.reject('not_enough_money')
    end
    return { ok = true, balance = getMoney(source) }
end)
`;

/** What the bridge log of `nexus dev` shows for these calls, in the order they were sent. */
export const refusals = [
  { data: '{"item":"water","amount":2}', ok: true, result: 'ok {"ok":true,"balance":110} (1 ms)' },
  { data: '{"item":"water","amount":-1000}', ok: false, result: 'invalid: amount: expected at least 1 (0 ms)' },
  { data: '{"item":"water","amount":2,"price":0}', ok: false, result: 'invalid: unknown key "price" (0 ms)' },
  { data: '{"item":"water","amount":"2"}', ok: false, result: 'invalid: amount: expected an integer (0 ms)' },
  { data: '{"item":"water","amount":1}', ok: true, result: 'ok {"ok":true,"balance":115} (0 ms)' },
  { data: '{"item":"water","amount":1}', ok: false, result: 'rate_limited (0 ms)' },
];
