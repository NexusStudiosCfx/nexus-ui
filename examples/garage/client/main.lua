local resource = GetCurrentResourceName()

local catalogue = {}
for _, vehicle in ipairs(Config.vehicles) do
    catalogue[vehicle.model] = true
end

local function loadLocale(name)
    local text = LoadResourceFile(resource, ('locales/%s.json'):format(name))
    if not text then
        print(("There is no locales/%s.json, falling back to English."):format(name))
        text = LoadResourceFile(resource, 'locales/en.json')
    end
    return json.decode(text)
end

local strings = loadLocale(Config.locale)
Nexus.locale(strings)

RegisterCommand('garage', function()
    if Nexus.isOpen('garage') then
        Nexus.close('garage')
    else
        Nexus.open('garage')
    end
end, false)

RegisterKeyMapping('garage', 'Open the demo garage', 'keyboard', 'F6')

-- The same garage as an app in LB Phone: web/screens/GarageApp.nexus, which has
-- <screen surface="phone" />. On a server without LB Phone this line does nothing.
Nexus.app('phone', {
    name = strings['app.name'],
    description = strings['app.description'],
    icon = 'web/dist/app-icon.svg',
    defaultApp = true,
})

-- /garagebuy sultan buys without any page: Nexus.call runs the same server handler, with the
-- same validation and rate limit, as the button in the garage does. This is how a target
-- option or an item would make the purchase.
RegisterCommand('garagebuy', function(_, args)
    local result, problem = Nexus.call('garage:buy', { model = args[1] or '' })
    if problem then
        print(('The purchase was refused: %s'):format(problem.message or problem.code))
    else
        print(('Bought. Balance: $%d'):format(result.balance))
    end
end, false)

-- The preview is a local vehicle in front of the player: nobody else sees it and it is gone
-- when the garage closes. Showing something is all the page may ask of the client. What the
-- player owns is the server's business, in server/main.lua.
local preview = nil
local previewRequest = 0

local function clearPreview()
    previewRequest = previewRequest + 1
    if preview and DoesEntityExist(preview) then
        DeleteEntity(preview)
    end
    preview = nil
end

Nexus.on('garage:preview', function(data)
    if not catalogue[data.model] then return end
    local model = GetHashKey(data.model)
    if not IsModelInCdimage(model) then return end

    clearPreview()
    local request = previewRequest
    RequestModel(model)
    local deadline = GetGameTimer() + 5000
    while not HasModelLoaded(model) do
        -- A newer preview, a closed garage or a model that never loads all end the wait.
        if request ~= previewRequest or GetGameTimer() > deadline then
            SetModelAsNoLongerNeeded(model)
            return
        end
        Wait(0)
    end
    if request ~= previewRequest or not Nexus.isOpen('garage') then
        SetModelAsNoLongerNeeded(model)
        return
    end

    local ped = PlayerPedId()
    local position = GetOffsetFromEntityInWorldCoords(ped, 0.0, 6.0, 0.0)
    preview = CreateVehicle(model, position.x, position.y, position.z, GetEntityHeading(ped) + 90.0, false, false)
    SetVehicleOnGroundProperly(preview)
    FreezeEntityPosition(preview, true)
    SetEntityCollision(preview, false, false)
    SetModelAsNoLongerNeeded(model)
end)

Nexus.onClose('garage', clearPreview)

-- The HUD is open for as long as the resource runs and decides for itself when to draw, from
-- the state set here. Nexus.set sends only the keys that changed, so a parked car costs no
-- messages at all.
CreateThread(function()
    Nexus.open('hud')
    while true do
        local vehicle = GetVehiclePedIsIn(PlayerPedId(), false)
        if vehicle ~= 0 then
            local position = GetEntityCoords(vehicle)
            local street = GetStreetNameAtCoord(position.x, position.y, position.z)
            Nexus.set('hud', {
                visible = true,
                speed = math.min(math.floor(GetEntitySpeed(vehicle) * 3.6 + 0.5), 999),
                fuel = math.floor(math.min(math.max(GetVehicleFuelLevel(vehicle), 0.0), 100.0) + 0.5),
                engine = math.floor(math.min(math.max(GetVehicleEngineHealth(vehicle), 0.0), 1000.0) / 10 + 0.5),
                street = GetStreetNameFromHashKey(street),
            })
            Wait(100)
        else
            Nexus.set('hud', { visible = false })
            Wait(500)
        end
    end
end)
