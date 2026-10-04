-- Stand-ins for the FiveM globals the bridge runtimes use, and the `Sim` table the tests drive
-- them with. Everything the runtimes do to the outside world is recorded as one JSON line in
-- Sim.log, in order, so a test can assert on exactly what a player or a server would see.

Sim = {
    now = 1000,
    convars = {},
    log = {},
    handlers = {},
    nui = {},
    threads = {},
    disabled = {},
    commands = {},
    files = {},
    resources = {},
    exports = {},
}

local function record(kind, fields)
    local parts = { '"kind":' .. json.encode(kind) }
    for key, value in pairs(fields) do
        parts[#parts + 1] = json.encode(key) .. ':' .. value
    end
    Sim.log[#Sim.log + 1] = '{' .. table.concat(parts, ',') .. '}'
end

local function encodeAll(...)
    local out = {}
    for i = 1, select('#', ...) do
        out[i] = json.encode((select(i, ...)))
    end
    return '[' .. table.concat(out, ',') .. ']'
end

-- Runs a thread until it waits or ends. A thread that waits for a time goes back on the list.
-- One that awaits a promise is kept by the promise, which resumes it.
local function step(thread, ...)
    local ok, wait = coroutine.resume(thread.co, ...)
    if not ok then
        record('error', { text = json.encode(tostring(wait)) })
    elseif coroutine.status(thread.co) ~= 'dead' and wait ~= 'await' then
        thread.wake = Sim.now + (wait or 0)
        Sim.threads[#Sim.threads + 1] = thread
    end
end

local function start(fn, ...)
    step({ co = coroutine.create(fn) }, ...)
end

function GetCurrentResourceName()
    return 'demo'
end

function GetGameTimer()
    return Sim.now
end

function GetConvarInt(name, default)
    return Sim.convars[name] or default
end

function GetConvar(name, default)
    return Sim.convars[name] or default
end

function GetResourceState(name)
    return Sim.resources[name] or 'missing'
end

function AddEventHandler(name, handler)
    local list = Sim.handlers[name]
    if not list then
        list = {}
        Sim.handlers[name] = list
    end
    list[#list + 1] = handler
end

function RegisterNetEvent(name, handler)
    if handler then AddEventHandler(name, handler) end
end

function TriggerClientEvent(name, target, ...)
    record('clientEvent', { name = json.encode(name), target = json.encode(target), args = encodeAll(...) })
end

function TriggerServerEvent(name, ...)
    record('serverEvent', { name = json.encode(name), args = encodeAll(...) })
end

function RegisterNUICallback(name, handler)
    Sim.nui[name] = handler
end

function SendNUIMessage(message)
    record('nui', { message = json.encode(message) })
end

function SetNuiFocus(focus, cursor)
    record('focus', { focus = json.encode(focus), cursor = json.encode(cursor) })
end

function SetNuiFocusKeepInput(keep)
    record('keepInput', { keep = json.encode(keep) })
end

function DisableControlAction(_, control)
    Sim.disabled[tostring(control)] = (Sim.disabled[tostring(control)] or 0) + 1
end

-- FiveM starts a new thread on the next tick, not inside CreateThread.
function CreateThread(fn)
    Sim.threads[#Sim.threads + 1] = { co = coroutine.create(fn), wake = Sim.now }
end

function SetTimeout(ms, fn)
    Sim.threads[#Sim.threads + 1] = { co = coroutine.create(fn), wake = Sim.now + ms, timer = true }
end

function Wait(ms)
    coroutine.yield(ms)
end

promise = {}

function promise.new()
    local self = {}
    function self:resolve(value)
        self.value = value
        self.done = true
        if self.thread then
            local thread = self.thread
            self.thread = nil
            step(thread)
        end
    end
    return self
end

Citizen = {}

function Citizen.Await(waiting)
    if not waiting.done then
        waiting.thread = { co = coroutine.running() }
        coroutine.yield('await')
    end
    return waiting.value
end

-- `exports.resource:Name(...)`, with the error FiveM raises for an export that does not exist.
exports = setmetatable({}, {
    __index = function(_, resource)
        return setmetatable({}, {
            __index = function(_, name)
                local found = Sim.exports[resource] and Sim.exports[resource][name]
                if not found then
                    error(('No such export %s in resource %s'):format(name, resource))
                end
                return function(_, ...)
                    return found(...)
                end
            end,
        })
    end,
})

function print(...)
    local parts = {}
    for i = 1, select('#', ...) do
        parts[i] = tostring((select(i, ...)))
    end
    record('print', { text = json.encode(table.concat(parts, ' ')) })
end

-- What the Lua of a resource built on the bridge typically touches besides the bridge itself.

function RegisterCommand(name, handler)
    Sim.commands[name] = handler
end

function LoadResourceFile(_, path)
    return Sim.files[path]
end

function PlayerId()
    return 0
end

function GetPlayerName()
    return 'Tester'
end

-- Fires an event the way FiveM does: every handler in its own coroutine, with the global
-- `source` set for the moment the handler starts.
function Sim.trigger(name, from, argsJson, count)
    local values = json.decode(argsJson)
    local list = Sim.handlers[name] or {}
    for i = 1, #list do
        source = from
        start(list[i], table.unpack(values, 1, count))
    end
    source = nil
end

function Sim.post(name, bodyJson)
    local handler = Sim.nui[name]
    if not handler then error('no NUI callback named ' .. name) end
    start(handler, json.decode(bodyJson), function(result)
        record('nuiResponse', { body = json.encode(result) })
    end)
end

function Sim.command(name, from, ...)
    local handler = Sim.commands[name]
    if not handler then error('no command named ' .. name) end
    start(handler, from, { ... }, name)
end

-- Runs a chunk of test code the way a resource thread would run it, so that it may wait.
function Sim.run(fn)
    start(fn)
end

-- One frame: time moves on by `ms` and every thread that is due runs until its next Wait.
function Sim.tick(ms)
    Sim.now = Sim.now + ms
    local due = Sim.threads
    Sim.threads = {}
    for i = 1, #due do
        local thread = due[i]
        if thread.wake > Sim.now then
            Sim.threads[#Sim.threads + 1] = thread
        else
            step(thread)
        end
    end
end

-- How many threads are alive, not counting timers that only wait to fire once.
function Sim.threadCount()
    local count = 0
    for i = 1, #Sim.threads do
        if not Sim.threads[i].timer then count = count + 1 end
    end
    return count
end

function Sim.drain()
    local out = '[' .. table.concat(Sim.log, ',') .. ']'
    Sim.log = {}
    return out
end

function Sim.takeDisabled()
    local out = json.encode(Sim.disabled)
    Sim.disabled = {}
    return out
end

-- A stand-in for LB Phone or LB Tablet with the exports the bridge uses, behaving as the real
-- ones are documented to: the phone forwards the data it is given, the tablet takes an event
-- name and data, and both refuse an identifier that is already taken.
function Sim.startLB(resource)
    local registered = {}
    Sim.resources[resource] = 'started'
    Sim.exports[resource] = {
        AddCustomApp = function(app)
            if registered[app.identifier] then return false, 'APP_ALREADY_EXISTS' end
            registered[app.identifier] = app
            local shown = {}
            for key, value in pairs(app) do
                if type(value) ~= 'function' then shown[key] = value end
            end
            record('addApp', { resource = json.encode(resource), app = json.encode(shown) })
            return true
        end,
        RemoveCustomApp = function(identifier)
            if not registered[identifier] then return false, 'INVALID_APP' end
            registered[identifier] = nil
            record('removeApp', { resource = json.encode(resource), identifier = json.encode(identifier) })
            return true
        end,
        SendCustomAppMessage = function(identifier, ...)
            if not registered[identifier] then return false, 'INVALID_APP' end
            record('appMessage', { resource = json.encode(resource), identifier = json.encode(identifier), args = encodeAll(...) })
            return true
        end,
    }
    Sim.apps = Sim.apps or {}
    Sim.apps[resource] = registered
end

-- LB tells the resource that the player opened or closed its app.
function Sim.app(resource, identifier, callback)
    start(Sim.apps[resource][identifier][callback])
end
