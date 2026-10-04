/** Samples for cases 3 and 4 of "why": focus and Escape, and what a closed UI costs. */

export const focusLua = `
local open = false

RegisterCommand('shop', function()
    open = true
    SetNuiFocus(true, true)
    SendNUIMessage({ action = 'open', item = 'water', price = 5 })
end, false)

RegisterNUICallback('close', function(_, cb)
    open = false
    SetNuiFocus(false, false)
    cb({})
end)

-- Without this, a restart while the shop is open
-- leaves the player with a cursor nothing dismisses.
AddEventHandler('onResourceStop', function(resource)
    if resource == GetCurrentResourceName() and open then
        SetNuiFocus(false, false)
    end
end)
`;

export const focusPage = `
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  fetch(\`https://\${GetParentResourceName()}/close\`, { method: 'POST' });
});
`;

export const screenTag = `
<screen focus="mouse keyboard" close="escape" size="1920x1080" />

<section class="shop">
  ...
</section>
`;

export const screenLua = `
RegisterCommand('shop', function()
    Nexus.open('shop', { item = 'water', price = 5 })
end, false)
`;

/** What the build writes to nexus/screens.lua for the tag above, as it is. */
export const screensLua = `
NexusScreens = {
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
}
`;

export const idleLua = `
-- Ten times a second, every value, changed or not.
CreateThread(function()
    while true do
        SendNUIMessage({
            action = 'hud',
            speed = speed,
            fuel = fuel,
            engine = engine,
            street = street,
        })
        Wait(100)
    end
end)
`;

export const idlePage = `
// Mounted when the resource starts and hidden with CSS.
// The framework and every component stay loaded and keep
// listening, whether or not a menu is ever opened.
createRoot(document.getElementById('root')).render(<App />);
`;

export const setLua = `
CreateThread(function()
    Nexus.open('hud')
    while true do
        local vehicle = GetVehiclePedIsIn(PlayerPedId(), false)
        if vehicle ~= 0 then
            Nexus.set('hud', {
                speed = math.floor(GetEntitySpeed(vehicle) * 3.6),
                fuel = math.floor(math.min(GetVehicleFuelLevel(vehicle), 100.0)),
            })
        end
        Wait(100)
    end
end)
`;

export const hudScreen = `
---
import { nui } from 'nexus';

const hud = nui.state('hud');
---

<screen layer="hud" size="1920x1080" />

<div class="speed">{hud.speed}</div>
<div class="fuel" style:width="{hud.fuel}%"></div>
`;

/** State updates as the bridge log of the garage example shows them: the changed keys only. */
export const stateLog = [
  { kind: 'state' as const, name: 'hud', data: '{"speed":24}', count: '15 updates' },
  { kind: 'state' as const, name: 'hud', data: '{"speed":30}', count: '4 updates' },
  { kind: 'state' as const, name: 'hud', data: '{"speed":43}', count: '8 updates' },
  { kind: 'state' as const, name: 'hud', data: '{"fuel":52}', count: '356 updates' },
];
