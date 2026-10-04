-- The client half of the Nexus UI bridge. `nexus build` copies this file into the resource as
-- nexus/client.lua. It owns the pages of the resource: which screens are open, who has focus,
-- and every message between a page, client Lua and the server.
--
-- A resource has up to three pages: its own NUI page ('main'), and the same page loaded as an
-- app in a frame of LB Phone ('phone') and LB Tablet ('tablet'). A call is answered to the page
-- that made it. Pushes, state and the locale go to every page that is up.
--
-- A world screen adds pages of a fourth kind: a display is the same page in an off-screen browser
-- of its own (a DUI), whose picture replaces a texture of the game, usually the screen of a prop.
-- The game can inject the mouse into such a browser and nothing else, so text and keys reach it
-- as messages, and while a player operates a display the page of the resource holds the input
-- focus and forwards what it receives.
--
-- It registers event handlers only. A thread exists only while a keep-input screen has focus,
-- for a moment after a screen is closed from the page, and while a display is operated.

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

-- How many displays a resource may have at once unless the convar nexus_world_limit says
-- otherwise. Each is a browser, and a browser costs memory and a share of every frame.
local WORLD_LIMIT = 4
-- What one line of the wheel is to a browser: a notch is three lines and 120 units.
local WHEEL_LINE = 40
local CAMERA_EASE = 400
-- How long the page of the resource has to say that it forwards input before a player who
-- would otherwise be left without a way out is let go.
local OPERATE_TIMEOUT = 2000
local MOUSE_BUTTONS = { left = true, middle = true, right = true }
local KEYS = {
    Backspace = true, Delete = true, Enter = true, Tab = true, Escape = true, Home = true, End = true,
    ArrowLeft = true, ArrowRight = true, ArrowUp = true, ArrowDown = true,
}

-- The page of each surface: `ready` once it has said so and until LB closes it, `seen` once it
-- has ever been ready.
local pages = { main = {}, phone = {}, tablet = {} }
-- The screen that is the root of the app on each surface, from the <screen surface> tags.
local surfaceScreens = {}
for name, screen in pairs(screens) do
    if screen.surface and screen.surface ~= 'world' then surfaceScreens[screen.surface] = name end
end
-- The displays that exist, by id. A display is its own page: `ready` once it has said so.
local displays = {}
local lastDisplay = 0
-- The dictionary that holds the pictures of the displays, made with the first of them.
local runtimeTxd = nil
-- The display the player is using, with what has to be undone when they stop.
local operating = nil
local stopOperating

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
    if type(surface) == 'table' then
        SendDuiMessage(surface.dui, json.encode(message))
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

-- A page is named by its surface, except a display, which is its own page.
local function pageOf(surface)
    return type(surface) == 'table' and surface or pages[surface]
end

local function send(surface, message)
    if pageOf(surface).ready then deliver(surface, message) end
end

local function broadcast(message)
    for surface, page in pairs(pages) do
        if page.ready then deliver(surface, message) end
    end
    for _, display in pairs(displays) do
        if display.ready then deliver(display, message) end
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

-- A surface screen is open for as long as LB shows its app, and a world screen for as long as
-- a display of it exists. Lua cannot open or close either as a screen of the page.
local function refuseSurface(name, signature)
    local surface = screens[name].surface
    if surface == 'world' then
        error(("%s: '%s' is a world screen. Nexus.world('%s', { txd = ..., texture = ... }) draws it on a prop."):format(signature, name, name), 3)
    elseif surface then
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
    -- A screen that takes the focus is what the player uses from now on, not the display.
    if name and operating then stopOperating() end
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

-- With nexus_dev on, props that do not match the contract are an error at the line that gave them.
local function checkProps(name, data, signature)
    local validator = contract.screens[name]
    if not validator or not isDev() then return end
    local ok, reason = validator(data or {})
    if not ok then
        error(('%s: the props do not match the contract: %s'):format(signature, reason), 3)
    end
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
    checkProps(name, data, ("Nexus.open('%s')"):format(name))
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

--- Whether a screen is open. For the app on a surface: whether LB is showing it. For a world
--- screen: whether a display of it exists.
function Nexus.isOpen(name)
    requireScreen(name, 'Nexus.isOpen')
    local surface = screens[name].surface
    if surface == 'world' then
        for _, display in pairs(displays) do
            if display.screen == name then return true end
        end
        return false
    end
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

local Display = {}
Display.__index = Display

-- The page as FiveM serves it to a browser: the manifest's ui_page, which `nexus dev --game`
-- points at the dev server, with what tells the page it is a display.
local function displayUrl(name, id)
    local page = GetResourceMetadata(resource, 'ui_page', 0) or 'web/dist/index.html'
    if not page:find('^https?://') then
        page = ('https://cfx-nui-%s/%s'):format(resource, page)
    end
    return ('%s?surface=world&screen=%s&display=%d&resource=%s'):format(page, name, id, resource)
end

local function usable(display)
    return displays[display.id] == display and IsDuiAvailable(display.dui)
end

local function clamp(value)
    return math.min(1.0, math.max(0.0, value))
end

-- The mouse of a display, in the pixels of its browser. The page draws the cursor itself.
local function movePointer(display, x, y)
    SendDuiMouseMove(display.dui, math.floor(clamp(x) * (display.width - 1) + 0.5), math.floor(clamp(y) * (display.height - 1) + 0.5))
end

-- A browser counts the wheel upwards, and a display counts lines downwards.
local function turnWheel(display, lines)
    SendDuiMouseWheel(display.dui, math.floor(-math.max(-100, math.min(100, lines)) * WHEEL_LINE), 0)
end

--- Draws a world screen on a texture of the game, usually the screen of a prop, and returns
--- its display. `txd` is the texture dictionary, which for a prop is the name of its model,
--- and `texture` the texture in it to replace. The model has to be loaded: create the display
--- once the prop exists, and destroy it when the player has walked away.
---
--- Returns `nil, reason` when there can be no display: 'unavailable' when the game has no
--- browser to draw with, 'limit' when the resource has as many displays as the convar
--- nexus_world_limit allows (4 unless set), 'taken' when a display already draws on that
--- texture.
---
---     local display, problem = Nexus.world('clock', { txd = 'my_clock', texture = 'my_clock_face', props = { business = 'police' } })
function Nexus.world(name, options)
    requireScreen(name, 'Nexus.world')
    local screen = screens[name]
    if screen.surface ~= 'world' then
        error(("Nexus.world: '%s' is not a world screen. Add surface=\"world\" and a size to its <screen> tag, and build again."):format(name), 2)
    end
    if type(options) ~= 'table' or type(options.txd) ~= 'string' or type(options.texture) ~= 'string' then
        error(("Nexus.world('%s', options): options.txd and options.texture must name the texture to draw on"):format(name), 2)
    end
    local data = options.props
    if data ~= nil and type(data) ~= 'table' then
        error(("Nexus.world('%s', options): options.props must be a table"):format(name), 2)
    end
    checkProps(name, data, ("Nexus.world('%s')"):format(name))

    local count = 0
    for _, display in pairs(displays) do
        if display.txd == options.txd and display.texture == options.texture then return nil, 'taken' end
        count = count + 1
    end
    if count >= GetConvarInt('nexus_world_limit', WORLD_LIMIT) then return nil, 'limit' end
    if not CreateDui then return nil, 'unavailable' end

    local id = lastDisplay + 1
    local dui = CreateDui(displayUrl(name, id), screen.width, screen.height)
    if not dui or dui == 0 then return nil, 'unavailable' end
    lastDisplay = id

    -- The game never lets go of a runtime dictionary or of a texture in it. So there is one
    -- dictionary, whose name cannot meet the one from before a restart of this resource, and
    -- every display has a texture in it under a name of its own.
    if not runtimeTxd then
        runtimeTxd = { name = ('nexus_%s_%d'):format(resource, GetGameTimer()) }
        runtimeTxd.handle = CreateRuntimeTxd(runtimeTxd.name)
    end
    local picture = ('display_%d'):format(id)
    CreateRuntimeTextureFromDuiHandle(runtimeTxd.handle, picture, GetDuiHandle(dui))
    AddReplaceTexture(options.txd, options.texture, runtimeTxd.name, picture)

    local display = setmetatable({
        id = id,
        screen = name,
        dui = dui,
        txd = options.txd,
        texture = options.texture,
        width = screen.width,
        height = screen.height,
        props = data or {},
    }, Display)
    displays[id] = display
    emit(listeners.open[name], ("an onOpen handler of '%s'"):format(name), display.props)
    return display
end

--- Whether the display still exists.
function Display:alive()
    return displays[self.id] == self
end

--- Replaces the props of the screen on the display.
function Display:set(data)
    if data ~= nil and type(data) ~= 'table' then
        error('display:set(props): props must be a table', 2)
    end
    if not self:alive() then return end
    checkProps(self.screen, data, 'display:set(props)')
    self.props = data or {}
    send(self, { t = 'open', screen = self.screen, props = orNil(data) })
end

--- Puts the original texture back and frees the browser. The onClose handlers of the screen run.
function Display:destroy()
    if not self:alive() then return end
    if operating and operating.display == self then stopOperating() end
    displays[self.id] = nil
    self.ready = false
    RemoveReplaceTexture(self.txd, self.texture)
    DestroyDui(self.dui)
    emit(listeners.close[self.screen], ("an onClose handler of '%s'"):format(self.screen))
end

--- Moves the pointer. `x` and `y` run from 0 to 1 across and down the screen.
function Display:pointer(x, y)
    if type(x) ~= 'number' or type(y) ~= 'number' then
        error('display:pointer(x, y): x and y must be numbers from 0 to 1', 2)
    end
    if usable(self) then movePointer(self, x, y) end
end

local function button(name, signature)
    if not MOUSE_BUTTONS[name] then
        error(("%s: the button is 'left', 'right' or 'middle', got '%s'"):format(signature, tostring(name)), 3)
    end
    return name
end

--- Presses a mouse button where the pointer is: 'left', 'right' or 'middle'.
function Display:press(name)
    button(name, 'display:press(button)')
    if usable(self) then SendDuiMouseDown(self.dui, name) end
end

--- Releases a mouse button. A press and a release in the same place are a click.
function Display:release(name)
    button(name, 'display:release(button)')
    if usable(self) then SendDuiMouseUp(self.dui, name) end
end

--- Turns the wheel by a number of lines. Positive is down.
function Display:scroll(lines)
    if type(lines) ~= 'number' then
        error('display:scroll(lines): lines must be a number', 2)
    end
    if usable(self) then turnWheel(self, lines) end
end

--- Types text: it goes in at the caret of the field that has the focus on the display.
function Display:type(text)
    if type(text) ~= 'string' then
        error('display:type(text): text must be a string', 2)
    end
    if self:alive() then send(self, { t = 'type', text = text }) end
end

--- Presses a key that is not a character: Backspace, Delete, Enter, Tab, Escape, ArrowLeft,
--- ArrowRight, ArrowUp, ArrowDown, Home or End.
function Display:key(key)
    if not KEYS[key] then
        error(("display:key(key): '%s' is not a key a display takes. See the list above Display:key in nexus/client.lua."):format(tostring(key)), 2)
    end
    if self:alive() then send(self, { t = 'key', key = key }) end
end

-- The input focus goes to the page of the resource, which forwards what it receives. It is
-- only taken once that page has said it does, so that a page whose code did not load cannot
-- leave the player with a cursor and no way out.
local function cross(a, b)
    return a.x * b.y - a.y * b.x
end

-- Where a point of the window lies on a four-cornered area of it: across and down, 0 to 1 when
-- the point is on the area. `a` is the top left corner, then top right, bottom right and bottom
-- left. The area is the screen of a prop as the camera sees it, which is only a rectangle when
-- the camera faces it squarely.
local function within(p, a, b, c, d)
    local e = { x = b.x - a.x, y = b.y - a.y }
    local f = { x = d.x - a.x, y = d.y - a.y }
    local g = { x = a.x - b.x + c.x - d.x, y = a.y - b.y + c.y - d.y }
    local h = { x = p.x - a.x, y = p.y - a.y }
    local k2, k1, k0 = cross(g, f), cross(e, f) + cross(h, g), cross(h, e)

    local function across(v)
        local wide = e.x + g.x * v
        if math.abs(wide) > 1e-7 then return (h.x - f.x * v) / wide end
        local high = e.y + g.y * v
        if math.abs(high) > 1e-7 then return (h.y - f.y * v) / high end
    end

    if math.abs(k2) < 1e-7 then
        if math.abs(k1) < 1e-9 then return nil end
        local v = -k0 / k1
        return across(v), v
    end
    local root = k1 * k1 - 4.0 * k0 * k2
    if root < 0.0 then return nil end
    root = math.sqrt(root)
    local v = (-k1 - root) / (2.0 * k2)
    local u = across(v)
    if not u or u < 0.0 or u > 1.0 or v < 0.0 or v > 1.0 then
        v = (-k1 + root) / (2.0 * k2)
        u = across(v)
    end
    return u, v
end

-- The corners of the operated screen in the window, from where the screen is on its entity.
-- Which side is left depends on which way the screen faces, so the picture decides.
local function screenCorners(session)
    local area = session.screen
    local function corner(side, rise)
        local at = GetOffsetFromEntityInWorldCoords(session.entity, area.center.x + side * area.width / 2, area.center.y, area.center.z + rise * area.height / 2)
        local visible, x, y = GetScreenCoordFromWorldCoord(at.x, at.y, at.z)
        return visible and { x = x, y = y } or nil
    end
    local topLeft, topRight, bottomRight, bottomLeft = corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)
    if not (topLeft and topRight and bottomRight and bottomLeft) then return nil end
    if topLeft.x > topRight.x then
        topLeft, topRight, bottomRight, bottomLeft = topRight, topLeft, bottomLeft, bottomRight
    end
    return topLeft, topRight, bottomRight, bottomLeft
end

-- Where the mouse is on the operated display. Without `screen`, the window is the display.
-- With it, the mouse is on the display only while it is over the prop's screen.
local function onDisplay(session, x, y)
    if not session.screen then return x, y end
    local a, b, c, d = screenCorners(session)
    if not a then
        -- The game only says where a point is in the window while the point is in view.
        if not session.warned then
            session.warned = true
            log('the screen of the operated display is not wholly in view, so the mouse cannot be put on it: move the camera back until all four corners show')
        end
        return nil
    end
    local u, v = within({ x = x, y = y }, a, b, c, d)
    -- The very edge of the screen still counts: the arithmetic lands a hair to either side of it.
    if not u or u < -0.001 or u > 1.001 or v < -0.001 or v > 1.001 then return nil end
    return u, v
end

local function operateLoop(session)
    CreateThread(function()
        while operating == session do
            HideHudAndRadarThisFrame()
            DisableAllControlActions(0)
            -- The camera stands about where the player does, so their own character would be in
            -- its way. It is hidden from them alone: everyone else still sees them at the prop.
            if session.camera then SetEntityLocallyInvisible(PlayerPedId()) end
            if not session.focus and GetGameTimer() > session.deadline then
                log('the page did not start forwarding input, so the display is let go')
                stopOperating()
            end
            Wait(0)
        end
    end)
end

stopOperating = function()
    local session = operating
    if not session then return false end
    operating = nil
    send('main', { t = 'operate', on = false })
    if session.screen and usable(session.display) then
        send(session.display, { t = 'cursor', on = true })
    end
    if session.focus then
        SetNuiFocus(false, false)
    end
    if session.camera then
        RenderScriptCams(false, true, CAMERA_EASE, true, false)
        DestroyCam(session.camera, false)
    end
    emit({ session.onExit }, 'the onExit handler of Nexus.operate')
    return true
end

local function faceScreen(entity, camera)
    local offset = camera.offset or { x = 0.0, y = -0.8, z = 0.0 }
    -- Unless it is told where to look, the camera looks straight ahead along the entity's
    -- forward axis, which is head on to a screen that faces the camera's side of the prop.
    local target = camera.target or { x = offset.x, y = 0.0, z = offset.z }
    local from = GetOffsetFromEntityInWorldCoords(entity, offset.x, offset.y, offset.z)
    local to = GetOffsetFromEntityInWorldCoords(entity, target.x, target.y, target.z)
    local handle = CreateCam('DEFAULT_SCRIPTED_CAMERA', true)
    SetCamCoord(handle, from.x, from.y, from.z)
    PointCamAtCoord(handle, to.x, to.y, to.z)
    SetCamFov(handle, camera.fov or 40.0)
    RenderScriptCams(true, true, CAMERA_EASE, true, false)
    return handle
end

--- Lets the player use a display: the mouse moves its pointer, the buttons and the wheel work
--- on it, and what is typed goes to it. The HUD is hidden and the game's controls are off for
--- as long as it lasts. Escape ends it, and so does holding a walking key (W, A, S or D) for a
--- moment, or Nexus.release().
---
--- With `entity`, a camera moves to face it: `camera.offset` is where the camera stands and
--- `camera.target` what it looks at, both relative to the entity, and `camera.fov` its field of
--- view. `onExit` runs when it ends, however it ends.
---
--- With `screen`, the game's cursor points at the prop's screen itself: `screen.center` is the
--- middle of the screen relative to the entity, `screen.width` and `screen.height` its size in
--- metres, for a screen that stands upright across the entity's X axis. The mouse then acts
--- only while it is over the screen, wherever the camera stands, and the display draws no
--- cursor of its own. Without `screen`, the whole window stands for the display.
---
--- One display is operated at a time. Returns false when the display is gone, when the page of
--- the resource has not loaded, or when a screen has the focus.
---
---     Nexus.operate(display, { entity = prop, camera = { offset = vec3(0.0, -0.75, 0.42), fov = 38.0 }, onExit = function() end })
function Nexus.operate(display, options)
    if getmetatable(display) ~= Display then
        error('Nexus.operate(display, options): display must be what Nexus.world returned', 2)
    end
    options = options or {}
    if type(options) ~= 'table' or (options.onExit ~= nil and type(options.onExit) ~= 'function') then
        error('Nexus.operate(display, options): options.onExit must be a function', 2)
    end
    local area = options.screen
    if area ~= nil then
        local sized = type(area) == 'table' and options.entity and area.center and type(area.width) == 'number' and type(area.height) == 'number'
        if not sized or area.width <= 0 or area.height <= 0 then
            error('Nexus.operate(display, options): options.screen needs options.entity, a center, and a width and a height above 0', 2)
        end
    end
    if not display:alive() or not pages.main.ready or topScreen() then return false end
    stopOperating()

    local session = { display = display, onExit = options.onExit, deadline = GetGameTimer() + OPERATE_TIMEOUT, entity = options.entity, screen = area }
    if options.entity then
        session.camera = faceScreen(options.entity, options.camera or {})
    end
    operating = session
    send('main', { t = 'operate', on = true })
    operateLoop(session)
    return true
end

--- Ends what Nexus.operate started. Returns whether a display was being operated.
function Nexus.release()
    return stopOperating()
end

-- What the page of the resource forwards while a display is operated. It is the player's own
-- mouse and keyboard, and still not trusted to be well formed.
local function onInput(message)
    local session = operating
    if not session then return end
    local kind = message.kind
    if kind == 'ready' then
        if not session.focus then
            session.focus = true
            SetNuiFocus(true, true)
            SetNuiFocusKeepInput(false)
            -- The game's cursor is on the screen itself, so the display need not draw one.
            if session.screen then send(session.display, { t = 'cursor', on = false }) end
        end
        return
    end
    local display = session.display
    if not session.focus or not usable(display) then return end

    if kind == 'leave' or (kind == 'key' and message.key == 'Escape') then
        stopOperating()
        -- Escape is still down when the game gets its input back.
        if kind == 'key' then holdPauseMenu() end
    elseif kind == 'type' then
        if type(message.text) == 'string' and #message.text <= 4096 then
            send(display, { t = 'type', text = message.text })
        end
    elseif kind == 'key' then
        if KEYS[message.key] then send(display, { t = 'key', key = message.key }) end
    elseif kind == 'scroll' then
        if type(message.lines) == 'number' then turnWheel(display, message.lines) end
    elseif kind == 'pointer' or kind == 'press' or kind == 'release' then
        if type(message.x) ~= 'number' or type(message.y) ~= 'number' then return end
        local x, y = onDisplay(session, message.x, message.y)
        if x then movePointer(display, x, y) end
        if kind == 'pointer' or not MOUSE_BUTTONS[message.button] then return end
        if kind == 'press' then
            -- A press beside the screen presses nothing on it.
            if x then SendDuiMouseDown(display.dui, message.button) end
        else
            -- A release always arrives, so a drag that left the screen still ends.
            SendDuiMouseUp(display.dui, message.button)
        end
    end
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
    local page = pageOf(surface)
    page.ready = true
    page.seen = true
    sync(surface)
    if page ~= pages.main then
        -- A display shows one screen, which nobody else opens.
        if page == surface then
            deliver(surface, { t = 'open', screen = surface.screen, props = orNil(surface.props) })
        end
        return
    end
    for i = 1, #stack do
        deliver('main', { t = 'open', screen = stack[i], props = orNil(props[stack[i]]) })
    end
    -- A page that loaded again while a display is operated has to forward input again.
    if operating then deliver('main', { t = 'operate', on = true }) end
    applyFocus()
end

RegisterNUICallback('nexus', function(message, respond)
    -- Results travel back as messages, so the request itself is answered at once.
    respond({})
    if type(message) ~= 'table' then return end
    local surface = message.surface or 'main'
    if surface == 'world' then
        -- A display says which one it is with the id from its address, which is text there.
        surface = displays[tonumber(message.display)]
        if not surface then return end
    -- An app that Lua never registered has no way to be answered.
    elseif not pages[surface] or (surface ~= 'main' and not apps[surface]) then
        return
    end

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
    elseif kind == 'input' and surface == 'main' then
        onInput(message)
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
    -- A replaced texture and its browser outlive the resource that made them.
    stopOperating()
    local left = {}
    for _, display in pairs(displays) do left[#left + 1] = display end
    for i = 1, #left do left[i]:destroy() end
    -- Focus outlives the page of a stopped resource, which would leave the player with a
    -- cursor that nothing can dismiss.
    if focused then
        SetNuiFocus(false, false)
        SetNuiFocusKeepInput(false)
    end
end)
