-- The server half of the Nexus UI bridge. `nexus build` copies this file into the resource as
-- nexus/server.lua. It answers the calls declared in web/contract.ts and nothing else.

local resource = GetCurrentResourceName()
local contract = NexusContract

if type(contract) ~= 'table' then
    error("nexus/contract.lua must load before nexus/server.lua. Run 'nexus build': it prints the fxmanifest.lua lines that are missing.")
end

local CALL = resource .. ':nexus:call'
local RESULT = resource .. ':nexus:res'
local PUSH = resource .. ':nexus:push'
local STATE = resource .. ':nexus:state'

local handlers = {}
local windows = {}
local warned = {}
local Rejection = {}

Nexus = {}

local function isDev()
    return GetConvarInt('nexus_dev', 0) == 1
end

local function log(message, ...)
    print(('[nexus] ' .. message):format(...))
end

local function refuse(player, id, code, message, details)
    TriggerClientEvent(RESULT, player, id, false, code, message, details)
end

-- A sliding window per player and call. Slot `at` holds the newest accepted call, so the slot
-- after it holds the call made `limit` calls ago: while that one is younger than `per` seconds
-- the limit is used up. Refused calls are not recorded, so flooding does not extend the wait.
local function allow(player, name, call)
    local calls = windows[player]
    if not calls then
        calls = {}
        windows[player] = calls
    end
    local window = calls[name]
    if not window then
        window = { at = 0 }
        calls[name] = window
    end
    local now = GetGameTimer()
    local slot = window.at % call.limit + 1
    local oldest = window[slot]
    if oldest and now - oldest < call.per * 1000 then return false end
    window[slot] = now
    window.at = slot
    return true
end

local function requireTarget(target, signature)
    if type(target) ~= 'number' then
        error(('%s: source must be a player id, or -1 for everyone'):format(signature), 3)
    end
end

--- Registers the handler of a call. It receives the player's server id and the input, which
--- has already passed the contract. What it returns is the answer.
---
---     Nexus.handle('shop:buy', function(source, data)
---         return { ok = true, balance = 120 }
---     end)
function Nexus.handle(name, handler)
    if not contract.calls[name] then
        error(("Nexus.handle: '%s' is not a call in web/contract.ts"):format(tostring(name)), 2)
    end
    if type(handler) ~= 'function' then
        error(("Nexus.handle('%s', handler): handler must be a function"):format(name), 2)
    end
    if handlers[name] then
        error(("Nexus.handle: '%s' already has a handler"):format(name), 2)
    end
    handlers[name] = handler
end

--- Returned from a handler to refuse the call. The page gets a NuiError with this code, and
--- with `details` when the call declares them for the code under `errors`.
---
---     return Nexus.reject('not_enough_money', { missing = 40 })
function Nexus.reject(code, details)
    if type(code) ~= 'string' or code == '' or #code > 64 then
        error("Nexus.reject(code): code must be a string of 1 to 64 characters, for example 'not_enough_money'", 2)
    end
    return setmetatable({ code = code, details = details }, Rejection)
end

--- Sends a push to one player's UI, or to everyone with -1.
---
---     Nexus.push(source, 'shop:stock', { item = 'water', stock = 2 })
function Nexus.push(target, name, data)
    local validator = contract.pushes[name]
    if not validator then
        error(("Nexus.push: '%s' is not a push in web/contract.ts"):format(tostring(name)), 2)
    end
    requireTarget(target, 'Nexus.push(source, name, data)')
    if isDev() then
        local ok, reason = validator(data)
        if not ok then
            error(("Nexus.push('%s'): the data does not match the contract: %s"):format(name, reason), 2)
        end
    end
    TriggerClientEvent(PUSH, target, name, data)
end

--- Patches a state for one player, or for everyone with -1. The player's client applies it
--- exactly as its own Nexus.set would, so only what changed reaches the page.
---
---     Nexus.set(source, 'job', { name = 'police', grade = 2 })
function Nexus.set(target, name, patch)
    local validator = contract.state[name]
    if not validator then
        error(("Nexus.set: '%s' is not a state in web/contract.ts"):format(tostring(name)), 2)
    end
    requireTarget(target, 'Nexus.set(source, name, patch)')
    if type(patch) ~= 'table' then
        error(("Nexus.set(source, '%s', patch): patch must be a table"):format(name), 2)
    end
    if isDev() then
        local ok, reason = validator(patch)
        if not ok then
            error(("Nexus.set('%s'): the patch does not match the contract: %s"):format(name, reason), 2)
        end
    end
    TriggerClientEvent(STATE, target, name, patch)
end

--- Removes keys from a state for one player, or for everyone with -1.
---
---     Nexus.unset(source, 'job', 'grade')
function Nexus.unset(target, name, ...)
    if not contract.state[name] then
        error(("Nexus.unset: '%s' is not a state in web/contract.ts"):format(tostring(name)), 2)
    end
    requireTarget(target, 'Nexus.unset(source, name, ...)')
    TriggerClientEvent(STATE, target, name, nil, { ... })
end

-- What a refusal carries is checked like an answer is: in dev mode, against what the call
-- declares for that code.
local function checkDetails(name, call, rejection)
    if rejection.details == nil then return true end
    local validator = call.errors[rejection.code]
    if not validator then
        log("the handler of '%s' returned details with '%s', which the call does not declare under errors", name, rejection.code)
        return false
    end
    local fits, why = validator(rejection.details)
    if not fits then
        log("the handler of '%s' returned details with '%s' that do not match the contract: %s", name, rejection.code, why)
    end
    return fits
end

RegisterNetEvent(CALL, function(id, name, data)
    -- The only identity used is the one the server attached to the event. Nothing in the
    -- payload says who is calling.
    local player = source
    if type(player) ~= 'number' or player < 1 then return end
    if type(id) ~= 'number' or type(name) ~= 'string' then return end

    local call = contract.calls[name]
    if not call then return end

    if not allow(player, name, call) then
        return refuse(player, id, 'rate_limited')
    end

    local valid, reason = call.input(data)
    if not valid then
        if isDev() then
            log("call '%s' from player %d was refused: %s", name, player, reason)
        end
        return refuse(player, id, 'invalid', reason)
    end

    local handler = handlers[name]
    if not handler then
        if not warned[name] then
            warned[name] = true
            log("call '%s' has no handler. Add Nexus.handle('%s', function(source, data) ... end) to a server script.", name, name)
        end
        return refuse(player, id, 'rejected')
    end

    local ok, result = xpcall(handler, debug.traceback, player, data)
    if not ok then
        log("the handler of '%s' raised an error for player %d: %s", name, player, result)
        return refuse(player, id, 'rejected')
    end

    if getmetatable(result) == Rejection then
        if isDev() and not checkDetails(name, call, result) then
            return refuse(player, id, 'rejected')
        end
        return refuse(player, id, result.code, nil, result.details)
    end

    if isDev() then
        local fits, why = call.output(result)
        if not fits then
            log("the handler of '%s' returned something that does not match the contract: %s", name, why)
            return refuse(player, id, 'rejected')
        end
    end

    TriggerClientEvent(RESULT, player, id, true, result)
end)

AddEventHandler('playerDropped', function()
    windows[source] = nil
end)
