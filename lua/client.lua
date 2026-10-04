-- The client half of the Nexus UI bridge. `nexus build` copies this file into the resource as
-- nexus/client.lua. It owns the pages of the resource: which screens are open, who has focus,
-- and every message between a page, client Lua and the server.
--
-- A resource has up to three pages: its own NUI page ('main'), and the same page loaded as an
-- app in a frame of LB Phone ('phone') and LB Tablet ('tablet'). A call is answered to the page
-- that made it. Pushes, state and the locale go to every page that is up.
--
-- It registers event handlers only. A thread exists only while a keep-input screen has focus,
-- and for a moment after a screen is closed from the page.

local resource = GetCurrentResourceName()
local contract = NexusContract
local screens = NexusScreens

if type(contract) ~= 'table' or type(screens) ~= 'table' then
    error("nexus/contract.lua and nexus/screens.lua must load before nexus/client.lua. Run 'nexus build': it prints the fxmanifest.lua lines that are missing.")
end

local CALL = resource .. ':nexus:call'
local RESULT = resource .. ':nexus:res'
local PUSH = resource .. ':nexus:push'
local STATE = resource .. ':nexus:state'

-- Camera, attack and aim on foot and in vehicles, melee and the weapon wheel: everything the
-- mouse would do to the game while a keep-input screen shows the cursor.
local MOUSE_CONTROLS = { 1, 2, 14, 15, 16, 17, 24, 25, 68, 69, 70, 91, 92, 106, 140, 141, 142, 257, 263, 264 }
local PAUSE_CONTROL = 200
local CALL_TIMEOUT = 10000

local LB = { phone = 'lb-phone', tablet = 'lb-tablet' }

-- The page of each surface: `ready` once it has said so and until LB closes it, `seen` once it
-- has ever been ready.
local pages = { main = {}, phone = {}, tablet = {} }
-- The screen that is the root of the app on each surface, from the <screen surface> tags.
local surfaceScreens = {}
for name, screen in pairs(screens) do
    if screen.surface then surfaceScreens[screen.surface] = name end
end

local props = {}
local stack = {}
local states = {}
-- The keys taken out of each state with Nexus.unset. A page that missed the message, such as
-- an app LB had put away, is told about them when it is brought up to date.
local unset = {}
local locale = nil
local listeners = { client = {}, open = {}, close = {} }
local windows = {}
local focused = nil
local guard = 0
local apps = {}
local calls = {}
local lastCall = 0

Nexus = {}

local function isDev()
    return GetConvarInt('nexus_dev', 0) == 1
end

local function log(message, ...)
    print(('[nexus] ' .. message):format(...))
end

-- LB forwards a message to the frame of the app. LB Phone posts the data as it is. LB Tablet
-- takes an event name and posts { action = event, data = data }. The page accepts both.
local function deliver(surface, message)
    message.__nexus = 1
    if surface == 'main' then
        SendNUIMessage(message)
        return
    end
    local app = apps[surface]
    if not app then return end
    -- LB may have stopped since the page said it was ready.
    pcall(function()
        if surface == 'phone' then
            exports['lb-phone']:SendCustomAppMessage(app.identifier, message)
        else
            exports['lb-tablet']:SendCustomAppMessage(app.identifier, 'nexus', message)
        end
    end)
end

local function send(surface, message)
    if pages[surface].ready then deliver(surface, message) end
end

local function broadcast(message)
    for surface, page in pairs(pages) do
        if page.ready then deliver(surface, message) end
    end
end

-- An empty Lua table is encoded as [], which the page would take for a list.
local function orNil(value)
    if value ~= nil and next(value) == nil then return nil end
    return value
end

local function emit(list, what, ...)
    if not list then return end
    for i = 1, #list do
        local ok, problem = xpcall(list[i], debug.traceback, ...)
        if not ok then log('%s raised an error: %s', what, problem) end
    end
end

local function listen(kind, name, handler, signature)
    if type(handler) ~= 'function' then
        error(('%s: handler must be a function'):format(signature), 3)
    end
    local list = listeners[kind][name]
    if not list then
        list = {}
        listeners[kind][name] = list
    end
    list[#list + 1] = handler
end

local function requireScreen(name, signature)
    if not screens[name] then
        error(("%s: there is no screen '%s'. Screens are the .nexus files in web/screens."):format(signature, tostring(name)), 3)
    end
end

-- A surface screen is open for as long as LB shows its app. Lua cannot open or close it.
local function refuseSurface(name, signature)
    local surface = screens[name].surface
    if surface then
        error(("%s: '%s' is the %s app. LB opens and closes it, not Lua."):format(signature, name, surface), 3)
    end
end

local function same(a, b)
    if a == b then return true end
    if type(a) ~= 'table' or type(b) ~= 'table' then return false end
    for key, value in pairs(a) do
        if not same(value, b[key]) then return false end
    end
    for key in pairs(b) do
        if a[key] == nil then return false end
    end
    return true
end

-- What is remembered of a state must not change when the caller changes its own table later.
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}
    for key, item in pairs(value) do
        result[key] = copy(item)
    end
    return result
end

-- The most recently opened screen that asks for focus. Screens on the hud layer never do.
local function topScreen()
    for i = #stack, 1, -1 do
        local screen = screens[stack[i]]
        if screen.layer ~= 'hud' and (screen.mouse or screen.keyboard) then return stack[i] end
    end
    return nil
end

local function applyFocus()
    -- Focus is only given to a page that has answered: if the page did not load, taking
    -- focus would leave the player with a cursor and nothing to click.
    local name = pages.main.ready and topScreen() or nil
    if name == focused then return end
    focused = name
    guard = guard + 1

    local screen = name and screens[name]
    if not screen then
        SetNuiFocus(false, false)
        SetNuiFocusKeepInput(false)
        return
    end

    -- The page cannot receive the mouse without holding input focus, so focus is on for
    -- either kind and the second argument only decides whether the cursor is drawn.
    SetNuiFocus(true, screen.mouse)
    SetNuiFocusKeepInput(screen.keepInput)
    if not screen.keepInput then return end

    -- With keep-input the game still reads every key and the mouse. Moving the cursor would
    -- turn the camera, a click would fire, and Escape would open the pause menu on top of
    -- the screen it is meant to close.
    local mine = guard
    CreateThread(function()
        while guard == mine do
            if screen.mouse then
                for i = 1, #MOUSE_CONTROLS do
                    DisableControlAction(0, MOUSE_CONTROLS[i], true)
                end
            end
            if screen.escape then
                DisableControlAction(0, PAUSE_CONTROL, true)
            end
            Wait(0)
        end
    end)
end

-- Escape is usually still held down when the game gets its input back, and the game would
-- read it as a fresh press and open the pause menu.
local function holdPauseMenu()
    local stopAt = GetGameTimer() + 250
    CreateThread(function()
        while GetGameTimer() < stopAt do
            DisableControlAction(0, PAUSE_CONTROL, true)
            Wait(0)
        end
    end)
end

local function close(name)
    if props[name] == nil then return false end
    props[name] = nil
    for i = #stack, 1, -1 do
        if stack[i] == name then
            table.remove(stack, i)
            break
        end
    end
    send('main', { t = 'close', screen = name })
    applyFocus()
    emit(listeners.close[name], ("an onClose handler of '%s'"):format(name))
    return true
end

--- Opens a screen with these props, or updates the props of a screen that is already open.
---
---     Nexus.open('shop', { item = 'water', price = 5 })
function Nexus.open(name, data)
    requireScreen(name, 'Nexus.open')
    refuseSurface(name, 'Nexus.open')
    if data ~= nil and type(data) ~= 'table' then
        error(("Nexus.open('%s', props): props must be a table"):format(name), 2)
    end
    local validator = contract.screens[name]
    if validator and isDev() then
        local ok, reason = validator(data or {})
        if not ok then
            error(("Nexus.open('%s'): the props do not match the contract: %s"):format(name, reason), 2)
        end
    end
    local isNew = props[name] == nil
    props[name] = data or {}
    if isNew then stack[#stack + 1] = name end
    send('main', { t = 'open', screen = name, props = orNil(data) })
    applyFocus()
    if isNew then
        emit(listeners.open[name], ("an onOpen handler of '%s'"):format(name), props[name])
    end
end

--- Closes a screen. Without a name it closes the screen that has focus. Returns whether
--- anything was closed.
function Nexus.close(name)
    if name == nil then
        name = topScreen()
        if not name then return false end
    else
        requireScreen(name, 'Nexus.close')
        refuseSurface(name, 'Nexus.close')
    end
    return close(name)
end

--- Whether a screen is open. For the app on a surface: whether LB is showing it.
function Nexus.isOpen(name)
    requireScreen(name, 'Nexus.isOpen')
    local surface = screens[name].surface
    if surface then return pages[surface].ready == true end
    return props[name] ~= nil
end

--- Sends a push to the pages from client Lua.
---
---     Nexus.push('shop:stock', { item = 'water', stock = 2 })
function Nexus.push(name, data)
    local validator = contract.pushes[name]
    if not validator then
        error(("Nexus.push: '%s' is not a push in web/contract.ts"):format(tostring(name)), 2)
    end
    if isDev() then
        local ok, reason = validator(data)
        if not ok then
            error(("Nexus.push('%s'): the data does not match the contract: %s"):format(name, reason), 2)
        end
    end
    broadcast({ t = 'push', name = name, data = data })
end

local function patchState(name, patch, removed)
    local current = states[name]
    if not current then
        current = {}
        states[name] = current
    end
    local absent = unset[name]
    if not absent then
        absent = {}
        unset[name] = absent
    end
    local changed, gone = nil, nil
    for key, value in pairs(patch or {}) do
        if not same(current[key], value) then
            current[key] = copy(value)
            absent[key] = nil
            changed = changed or {}
            changed[key] = value
        end
    end
    for i = 1, #(removed or {}) do
        local key = removed[i]
        if current[key] ~= nil then
            current[key] = nil
            absent[key] = true
            gone = gone or {}
            gone[#gone + 1] = key
        end
    end
    if changed or gone then
        broadcast({ t = 'state', name = name, data = changed, removed = gone })
    end
end

--- Patches a state object. Only the keys whose value changed are sent to the pages, tables
--- compared by content, so calling this often with the same values costs nothing.
---
---     Nexus.set('hud', { health = 87 })
function Nexus.set(name, patch)
    local validator = contract.state[name]
    if not validator then
        error(("Nexus.set: '%s' is not a state in web/contract.ts"):format(tostring(name)), 2)
    end
    if type(patch) ~= 'table' then
        error(("Nexus.set('%s', patch): patch must be a table"):format(name), 2)
    end
    if isDev() then
        local ok, reason = validator(patch)
        if not ok then
            error(("Nexus.set('%s'): the patch does not match the contract: %s"):format(name, reason), 2)
        end
    end
    patchState(name, patch)
end

--- Removes keys from a state object. In the page they read as undefined again.
---
---     Nexus.unset('death', 'stage', 'timer')
function Nexus.unset(name, ...)
    if not contract.state[name] then
        error(("Nexus.unset: '%s' is not a state in web/contract.ts"):format(tostring(name)), 2)
    end
    patchState(name, nil, { ... })
end

--- Gives the pages their strings. Call it again to switch language.
function Nexus.locale(strings)
    if type(strings) ~= 'table' then
        error('Nexus.locale(strings): strings must be a table', 2)
    end
    locale = strings
    broadcast({ t = 'locale', data = strings })
end

--- Handles a message a page sends with nui.client(name, data).
function Nexus.on(name, handler)
    if not contract.client[name] then
        error(("Nexus.on: '%s' is not a client message in web/contract.ts"):format(tostring(name)), 2)
    end
    listen('client', name, handler, ("Nexus.on('%s', handler)"):format(name))
end

--- Runs when the screen opens, with its props, whoever opened it. For the app on a surface
--- it runs when LB opens the app.
function Nexus.onOpen(name, handler)
    requireScreen(name, 'Nexus.onOpen')
    listen('open', name, handler, ("Nexus.onOpen('%s', handler)"):format(name))
end

--- Runs when the screen closes, whether Lua closed it, the page did, LB did, or the resource
--- stopped.
function Nexus.onClose(name, handler)
    requireScreen(name, 'Nexus.onClose')
    listen('close', name, handler, ("Nexus.onClose('%s', handler)"):format(name))
end

-- The same window the server keeps. Checking here as well answers a spammed button at once
-- and keeps those calls off the network. The server never relies on it.
local function allow(name, call)
    local window = windows[name]
    if not window then
        window = { at = 0 }
        windows[name] = window
    end
    local now = GetGameTimer()
    local slot = window.at % call.limit + 1
    local oldest = window[slot]
    if oldest and now - oldest < call.per * 1000 then return false end
    window[slot] = now
    window.at = slot
    return true
end

-- Sends a call to the server unless it can be refused here. `finish(ok, result, message,
-- details)` runs exactly once: with the answer, a refusal, or after the timeout.
local function request(name, data, finish)
    local call = contract.calls[name]
    if not allow(name, call) then
        return finish(false, 'rate_limited')
    end
    local ok, reason = call.input(data)
    if not ok then
        return finish(false, 'invalid', reason)
    end
    -- The server answers by this id. A page chooses its own ids, and two pages may choose
    -- the same one, so theirs never leave the client.
    lastCall = lastCall + 1
    local id = lastCall
    calls[id] = finish
    TriggerServerEvent(CALL, id, name, data)
    SetTimeout(CALL_TIMEOUT, function()
        if calls[id] then
            calls[id] = nil
            finish(false, 'timeout')
        end
    end)
end

--- Makes a contract call from client Lua: the same validation, rate limit and server handler
--- as nui.call. Use it for what does not start in a page, such as a target option or an item.
---
--- With a callback it returns at once and the callback gets `result, problem`. Without one
--- it waits, so it must run in a thread or an event handler, and returns the same two values.
--- `problem` is nil on success, otherwise `{ code = string, message = string?, details = any }`.
---
---     local result, problem = Nexus.call('garage:buy', { model = 'sultan' })
---     if problem then print(problem.code) end
function Nexus.call(name, data, callback)
    if not contract.calls[name] then
        error(("Nexus.call: '%s' is not a call in web/contract.ts"):format(tostring(name)), 2)
    end
    if callback ~= nil and type(callback) ~= 'function' then
        error(("Nexus.call('%s', data, callback): callback must be a function"):format(name), 2)
    end
    local waiting = not callback and promise.new() or nil
    request(name, data, function(ok, result, message, details)
        local problem = nil
        if not ok then
            problem = { code = result, message = message, details = details }
            result = nil
        end
        if waiting then
            waiting:resolve({ result, problem })
        else
            emit({ callback }, ("the callback of Nexus.call('%s')"):format(name), result, problem)
        end
    end)
    if waiting then
        local outcome = Citizen.Await(waiting)
        return outcome[1], outcome[2]
    end
end

local function onCall(surface, message)
    local id, name = message.id, message.name
    if type(id) ~= 'number' then return end
    local function answer(ok, result, text, details)
        if ok then
            send(surface, { t = 'res', id = id, ok = true, data = result })
        else
            send(surface, { t = 'res', id = id, ok = false, code = result, message = text, details = details })
        end
    end
    if type(name) ~= 'string' or not contract.calls[name] then
        return answer(false, 'invalid', ("'%s' is not a call in web/contract.ts"):format(tostring(name)))
    end
    request(name, message.data, answer)
end

local function onClient(message)
    local name = message.name
    local validator = type(name) == 'string' and contract.client[name]
    if not validator then
        if isDev() then log("the page sent '%s', which is not a client message in web/contract.ts", tostring(name)) end
        return
    end
    local ok, reason = validator(message.data)
    if not ok then
        if isDev() then log("the page sent '%s' with data that does not match the contract: %s", name, reason) end
        return
    end
    emit(listeners.client[name], ("a handler of '%s'"):format(name), message.data)
end

-- Brings a page up to date: the locale and every state, as they are now.
local function sync(surface)
    if locale then
        deliver(surface, { t = 'locale', data = locale })
    end
    for name, value in pairs(states) do
        local gone = {}
        for key in pairs(unset[name]) do gone[#gone + 1] = key end
        table.sort(gone)
        if next(value) ~= nil or #gone > 0 then
            deliver(surface, { t = 'state', name = name, data = orNil(value), removed = orNil(gone) })
        end
    end
end

local function onReady(surface)
    local page = pages[surface]
    page.ready = true
    page.seen = true
    sync(surface)
    if surface ~= 'main' then return end
    for i = 1, #stack do
        deliver('main', { t = 'open', screen = stack[i], props = orNil(props[stack[i]]) })
    end
    applyFocus()
end

RegisterNUICallback('nexus', function(message, respond)
    -- Results travel back as messages, so the request itself is answered at once.
    respond({})
    if type(message) ~= 'table' then return end
    local surface = message.surface or 'main'
    -- An app that Lua never registered has no way to be answered.
    if not pages[surface] or (surface ~= 'main' and not apps[surface]) then return end

    local kind = message.t
    if kind == 'call' then
        onCall(surface, message)
    elseif kind == 'client' then
        onClient(message)
    elseif kind == 'ready' then
        onReady(surface)
    elseif kind == 'close' and surface == 'main' then
        local name = message.screen
        if name == nil then name = topScreen() end
        if type(name) == 'string' and close(name) then
            holdPauseMenu()
        end
    end
end)

RegisterNetEvent(RESULT, function(id, ok, result, message, details)
    local finish = calls[id]
    if not finish then return end
    calls[id] = nil
    finish(ok, result, message, details)
end)

RegisterNetEvent(PUSH, function(name, data)
    broadcast({ t = 'push', name = name, data = data })
end)

RegisterNetEvent(STATE, function(name, patch, removed)
    if contract.state[name] then patchState(name, patch, removed) end
end)

-- LB reports when it shows and hides an app. A phone keeps the frame of an app it has put in
-- the background, so an app that comes back may not load again and say `ready`: it is
-- brought up to date here instead. If the frame is new, this goes nowhere and `ready` follows.
local function appOpened(surface)
    local page = pages[surface]
    if page.seen then
        page.ready = true
        sync(surface)
    end
    emit(listeners.open[surfaceScreens[surface]], ("an onOpen handler of '%s'"):format(surfaceScreens[surface]), {})
end

local function appClosed(surface)
    pages[surface].ready = false
    emit(listeners.close[surfaceScreens[surface]], ("an onClose handler of '%s'"):format(surfaceScreens[surface]))
end

local function register(surface, attempt)
    local app = apps[surface]
    local lb = LB[surface]
    if not app or GetResourceState(lb) ~= 'started' then return end

    local options = copy(app.options)
    options.identifier = app.identifier
    options.onOpen = function() appOpened(surface) end
    options.onClose = function() appClosed(surface) end
    local page = ('web/dist/index.html?surface=%s&resource=%s'):format(surface, resource)
    if surface == 'phone' then
        -- LB Phone wants the path of the page with the resource in front, and an icon URL.
        options.ui = resource .. '/' .. page
        if options.icon then options.icon = ('https://cfx-nui-%s/%s'):format(resource, options.icon) end
        if options.fixBlur == nil then options.fixBlur = true end
    else
        -- LB Tablet wants both relative to the resource that registers the app.
        options.ui = page
        if options.icon then options.icon = '/' .. options.icon end
    end

    local called, added, reason = pcall(function()
        -- An app left over from before a restart of this resource holds callbacks that no
        -- longer exist.
        exports[lb]:RemoveCustomApp(app.identifier)
        return exports[lb]:AddCustomApp(options)
    end)
    if called and added then return end
    -- Right after LB starts, its exports may not be there yet.
    if not called and attempt < 5 then
        SetTimeout(1000, function() register(surface, attempt + 1) end)
        return
    end
    log("%s did not add the app '%s': %s", lb, app.identifier, tostring(reason or added))
end

--- Makes the screen with `<screen surface="phone">` or `surface="tablet"` an app in LB Phone
--- or LB Tablet. It is registered when LB runs, again when LB restarts, and removed when this
--- resource stops. Without LB on the server nothing happens.
---
--- `icon` is a file the resource ships, as a path from its root. Any other field is passed
--- to LB's AddCustomApp as it is.
---
---     Nexus.app('phone', { name = 'Garage', description = 'Your vehicles', icon = 'web/dist/icon.png', defaultApp = true })
function Nexus.app(surface, options)
    if not LB[surface] then
        error(("Nexus.app: the surface is 'phone' or 'tablet', got '%s'"):format(tostring(surface)), 2)
    end
    if not surfaceScreens[surface] then
        error(('Nexus.app: no screen declares <screen surface="%s" />. Add one in web/screens and build again.'):format(surface), 2)
    end
    if type(options) ~= 'table' or type(options.name) ~= 'string' then
        error(("Nexus.app('%s', options): options.name must be the name of the app"):format(surface), 2)
    end
    apps[surface] = { options = options, identifier = options.identifier or resource }
    register(surface, 1)
end

AddEventHandler('onClientResourceStart', function(started)
    for surface, lb in pairs(LB) do
        if started == lb then
            pages[surface] = {}
            register(surface, 1)
        end
    end
end)

AddEventHandler('onResourceStop', function(stopped)
    if stopped ~= resource then return end
    for i = #stack, 1, -1 do
        emit(listeners.close[stack[i]], ("an onClose handler of '%s'"):format(stack[i]))
    end
    for surface, app in pairs(apps) do
        if pages[surface].ready then appClosed(surface) end
        pcall(function() exports[LB[surface]]:RemoveCustomApp(app.identifier) end)
    end
    -- Focus outlives the page of a stopped resource, which would leave the player with a
    -- cursor that nothing can dismiss.
    if focused then
        SetNuiFocus(false, false)
        SetNuiFocusKeepInput(false)
    end
end)
