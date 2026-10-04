-- /worldtest puts a prop in front of you, draws the screen web/screens/Proof.nexus on it and
-- checks every link between that screen and Lua, printing PASS or FAIL for each to the F8
-- console. What Lua cannot see (the picture on the prop) it tells you to look at.
--
--   /worldtest                          the laptop below
--   /worldtest atm                      another preset
--   /worldtest <model> <txd> <texture>  any model: the texture dictionary of a prop is the name
--                                       of its model, and the texture is the one its screen shows
--   /worldtest use                      operate the screen with the mouse and the keyboard
--   /worldtest use <height> <distance>  the same, saying how high the middle of the screen is
--                                       above the prop's origin and how far back the camera is
--   /worldtest use <height> <distance> <width> <tall> [<y>]
--                                       and how wide and tall the screen is, in metres, and how
--                                       far along the prop's Y axis it sits: the game's cursor
--                                       then points at the screen itself
--   /worldtest turn                     turn the prop a quarter, if its screen faces away
--   /worldtest end                      destroy the display and remove the prop

local resource = GetCurrentResourceName()

-- Props of the base game whose screen is a texture of its own. Both are used this way by
-- published resources. If one shows nothing on your game build, try another model.
local PRESETS = {
    laptop = { model = 'prop_laptop_lester2', txd = 'prop_laptop_lester2', texture = 'script_rt_tvscreen' },
    atm = { model = 'prop_atm_01', txd = 'prop_atm_01', texture = 'prop_cashpoint_screen' },
}

local WAITING = { page = 'wait', post = 'wait', message = 'wait', pointer = 'wait', click = 'wait', wheel = 'wait', text = 'wait', key = 'wait' }

-- The run in progress: its prop, its display and what the page has reported.
local test = nil

local function say(step, verdict, text)
    print(('[worldtest] %s %s  %s'):format(step, verdict, text))
end

local function waitFor(condition, ms)
    local stopAt = GetGameTimer() + ms
    while not condition() do
        if GetGameTimer() > stopAt then return false end
        Wait(50)
    end
    return true
end

local function finish()
    if not test then return end
    if test.display then test.display:destroy() end
    if DoesEntityExist(test.prop) then DeleteEntity(test.prop) end
    test = nil
end

Nexus.on('worldtest:hello', function(data)
    if test then test.hello = data end
end)

Nexus.on('worldtest:pong', function(data)
    if test and data.nonce == test.nonce then test.pong = true end
end)

Nexus.on('worldtest:saw', function(data)
    if test then test.saw[data.what] = data.detail end
end)

-- Injects one kind of input and reports whether the page saw it. A run that was ended or
-- started again in the meantime says nothing more.
local function input(mine, what, act)
    if test ~= mine then return end
    act(mine.display)
    local seen = waitFor(function() return mine.saw[what] ~= nil end, 2000)
    if test ~= mine then return end
    Nexus.set('proof', { [what] = seen and 'pass' or 'fail' })
    if seen then
        say('5', 'PASS', ('%s reached the page (%s)'):format(what, mine.saw[what]))
    else
        say('5', 'FAIL', ('%s did not reach the page'):format(what))
    end
end

local function click(display, point)
    display:pointer(point.x, point.y)
    display:press('left')
    display:release('left')
end

local function run(target)
    finish()
    Nexus.set('proof', WAITING)

    local model = GetHashKey(target.model)
    if not IsModelInCdimage(model) then
        return say('1', 'FAIL', ("the game has no model '%s'"):format(target.model))
    end
    RequestModel(model)
    if not waitFor(function() return HasModelLoaded(model) end, 5000) then
        return say('1', 'FAIL', ("the model '%s' did not load"):format(target.model))
    end

    -- The prop appears in front of you, turned to face you. Nobody else sees it. Something small,
    -- like a laptop, hangs at eye height. Something that stands on the floor is put on the ground.
    local ped = PlayerPedId()
    local low, high = GetModelDimensions(model)
    local tall = high.z - low.z > 1.0
    local at = GetOffsetFromEntityInWorldCoords(ped, 0.0, tall and 1.6 or 1.0, tall and 0.0 or 0.4)
    local prop = CreateObject(model, at.x, at.y, at.z, false, false, false)
    SetEntityHeading(prop, GetEntityHeading(ped) + 180.0)
    if tall then
        PlaceObjectOnGroundProperly(prop)
    end
    FreezeEntityPosition(prop, true)
    SetModelAsNoLongerNeeded(model)
    test = { prop = prop, saw = {} }
    local mine = test

    -- A texture can only be replaced while its model is loaded, which it is now.
    local display, problem = Nexus.world('proof', { txd = target.txd, texture = target.texture, props = target })
    if not display then
        return say('1', 'FAIL', ('Nexus.world made no display: %s'):format(problem))
    end
    mine.display = display
    say('1', 'PASS', 'a browser was created. Step 2 says whether its page loaded.')

    local heard = waitFor(function() return test ~= mine or mine.hello end, 6000)
    if test ~= mine then return end
    if not heard then
        say('2', 'FAIL', 'the page said nothing within 6 seconds. Look at the prop. If it shows the test page, the page loaded and its request to the NUI callback did not arrive. If it shows its own screen, the page did not load or the texture was not replaced.')
        return
    end
    Nexus.set('proof', { page = 'pass', post = 'pass' })
    say('2', 'PASS', ('the page reached client Lua through the NUI callback, from %s'):format(mine.hello.address))

    mine.nonce = GetGameTimer() % 100000
    Nexus.push('worldtest:ping', { nonce = mine.nonce })
    local answered = waitFor(function() return mine.pong end, 3000)
    if test ~= mine then return end
    if answered and mine.hello.opened then
        say('3', 'PASS', 'SendDuiMessage reached the page: it was opened with its props and answered a push')
    elseif answered then
        say('3', 'FAIL', 'the page answered a push, but it had mounted without waiting for its props')
    else
        say('3', 'FAIL', 'the page did not answer a push: SendDuiMessage did not reach it')
    end
    Nexus.set('proof', { message = answered and mine.hello.opened and 'pass' or 'fail' })

    local hello = mine.hello
    input(mine, 'pointer', function(shown) shown:pointer(hello.field.x, hello.field.y) end)
    click(display, hello.field)
    input(mine, 'text', function(shown) shown:type('nexus') end)
    input(mine, 'key', function(shown) shown:key('Backspace') end)
    input(mine, 'click', function(shown) click(shown, hello.button) end)
    input(mine, 'wheel', function(shown)
        shown:pointer(hello.list.x, hello.list.y)
        shown:scroll(3)
    end)
    if test ~= mine then return end

    say('4', 'LOOK', 'Lua cannot see the picture. The prop in front of you should show the test page with these results. Take a screenshot.')
    say('6', 'LOOK', ("run /worldtest end: the prop should be gone, and any other %s in view should show its own screen again. Then run /worldtest once more and 'ensure %s' while it is up: the same should hold."):format(target.model, resource))
end

RegisterCommand('worldtest', function(_, args)
    local first = args[1]
    if first == 'end' then
        finish()
        say('6', 'LOOK', 'the display is destroyed and the prop removed')
    elseif first == 'turn' then
        if test then SetEntityHeading(test.prop, GetEntityHeading(test.prop) + 90.0) end
    elseif first == 'use' then
        if not test or not test.display then return say('use', 'FAIL', 'run /worldtest first') end
        -- A model does not say where its screen is, so this guesses, and the guess can be
        -- replaced with numbers (see the top of this file). A prop that stands on the floor is
        -- taken for a desk with a 16:9 monitor across most of its width at the top, facing along
        -- its Y axis: the camera stands straight in front of that, and the game's cursor is
        -- mapped onto it. A small prop is looked at around its middle from where you stand, and
        -- the whole window stands for its screen.
        local low, high = GetModelDimensions(GetEntityModel(test.prop))
        local tall = high.z - low.z > 1.0
        local wide, rise = tonumber(args[4]), tonumber(args[5])
        if tall and not wide then
            wide = (high.x - low.x) * 0.83
            rise = wide * 9 / 16
        end
        local height = tonumber(args[2]) or (tall and high.z - 0.02 - rise / 2 or 0.12)
        -- Far enough back that the whole screen is in view, which the mapping needs.
        local distance = tonumber(args[3]) or (tall and math.max(0.6, wide * 1.35) or 0.7)
        local depth = tonumber(args[6]) or (tall and (low.y + high.y) / 2 - 0.12 or 0.0)
        local area = wide and rise and { center = { x = 0.0, y = depth, z = height }, width = wide, height = rise } or nil

        local stand
        if area then
            stand = { x = 0.0, y = depth + distance, z = height }
        else
            local you = GetEntityCoords(PlayerPedId())
            local from = GetOffsetFromEntityGivenWorldCoords(test.prop, you.x, you.y, you.z)
            local length = math.max(0.01, math.sqrt(from.x * from.x + from.y * from.y))
            stand = { x = from.x / length * distance, y = from.y / length * distance, z = height + 0.08 }
        end
        local started = Nexus.operate(test.display, {
            entity = test.prop,
            camera = { offset = stand, target = { x = 0.0, y = area and depth or 0.0, z = height }, fov = 45.0 },
            screen = area,
            onExit = function() say('use', 'DONE', 'you let go of the screen') end,
        })
        if not started then
            return say('use', 'FAIL', 'Nexus.operate did not start')
        end
        say('use', 'PASS', 'the screen is yours: Escape lets go, and so does holding W, A, S or D')
        if area then
            say('use', 'LOOK', ('the cursor is mapped onto a screen %.2f by %.2f m, %.2f m up: there should be one cursor, and a click should land under it. If it is off, give the real numbers: /worldtest use <height> <distance> <width> <tall> <y>'):format(wide, rise, height))
        else
            say('use', 'LOOK', 'the whole window stands for the screen, so the display draws its own cursor and the game shows its own as well. Give the size of the screen to have one: /worldtest use <height> <distance> <width> <tall> <y>')
        end
    else
        local target = PRESETS[first or 'laptop']
        if not target and args[3] then target = { model = args[1], txd = args[2], texture = args[3] } end
        if not target then
            return say('1', 'FAIL', 'usage: /worldtest [laptop|atm], or /worldtest <model> <txd> <texture>')
        end
        CreateThread(function() run(target) end)
    end
end, false)

AddEventHandler('onResourceStop', function(stopped)
    if stopped == resource and test and DoesEntityExist(test.prop) then DeleteEntity(test.prop) end
end)
