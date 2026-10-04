local balances = {}
local garages = {}

local catalogue = {}
for _, vehicle in ipairs(Config.vehicles) do
    catalogue[vehicle.model] = vehicle
end

local function balanceOf(player)
    return balances[player] or Config.startingBalance
end

local function garageOf(player)
    local garage = garages[player]
    if not garage then
        garage = {}
        garages[player] = garage
    end
    return garage
end

Nexus.handle('garage:list', function(source)
    local garage = garageOf(source)
    local vehicles = {}
    for index, vehicle in ipairs(Config.vehicles) do
        vehicles[index] = {
            model = vehicle.model,
            label = vehicle.label,
            class = vehicle.class,
            price = vehicle.price,
            speed = vehicle.speed,
            acceleration = vehicle.acceleration,
            handling = vehicle.handling,
            owned = garage[vehicle.model] == true,
        }
    end
    return { balance = balanceOf(source), vehicles = vehicles }
end)

-- The contract guarantees that data.model is a short lowercase string. Whether that model is
-- for sale, whether this player already has it and whether they can pay is decided here, from
-- what the server knows. The page only ever sends the model.
Nexus.handle('garage:buy', function(source, data)
    local vehicle = catalogue[data.model]
    if not vehicle then
        return Nexus.reject('unknown_vehicle')
    end

    local garage = garageOf(source)
    if garage[vehicle.model] then
        return Nexus.reject('already_owned')
    end

    local balance = balanceOf(source)
    if balance < vehicle.price then
        return Nexus.reject('not_enough_money', { missing = vehicle.price - balance })
    end

    balances[source] = balance - vehicle.price
    garage[vehicle.model] = true
    return { balance = balances[source] }
end)

AddEventHandler('playerDropped', function()
    balances[source] = nil
    garages[source] = nil
end)

-- garagedemo_give <player id> <amount>, from the server console. It shows a push: the balance
-- on the player's screen changes without the page asking for it.
RegisterCommand('garagedemo_give', function(source, args)
    if source ~= 0 then return end

    local player, amount = tonumber(args[1]), tonumber(args[2])
    if not player or not amount or amount < 1 or amount ~= math.floor(amount) then
        print('Usage: garagedemo_give <player id> <amount>')
        return
    end
    if not GetPlayerName(player) then
        print(('Player %d is not connected.'):format(player))
        return
    end

    balances[player] = balanceOf(player) + amount
    Nexus.push(player, 'garage:balance', { balance = balances[player] })
    print(('Player %d now has $%d.'):format(player, balances[player]))
end, true)
