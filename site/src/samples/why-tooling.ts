/** Samples for cases 5 to 7 of "why": Chromium 103, a phone app, and working without the game. */

export const modernCss = `
.card {
  background: color-mix(in srgb, #c8ff3d 12%, transparent);
}

/* Chromium 103 does not know :has() and drops the rule. */
.list:has(.selected) {
  gap: 12px;
}
`;

export const modernJs = `
// Works in the browser you develop in. Throws in game.
const sorted = items.toSorted((a, b) => a.price - b.price);
`;

/** The same screen once it follows what the check said. */
export const fixed = `
---
import { computed, signal } from 'nexus';

const selected = signal('');
const sorted = computed(() =>
  [...props.items].sort((a, b) => a.price - b.price),
);
---

<ul class="list" class:picked={selected.value !== ''}>
  ...
</ul>

<style>
  .card {
    background: rgb(200 255 61 / 12%);
  }

  .list.picked {
    gap: 12px;
  }
</style>
`;

export const fixedCheck = `
$ npx nexus check
ok 1 component checked, no errors.
`;

/** The output of \`nexus check\` for a screen that uses the three features above. */
export const compatCheck = `
$ npx nexus check
error web/screens/Shop.nexus:14:42: This array method needs Chromium 110. FiveM runs Chromium 103. (unsupported-api)

  12 |
  13 | const selected = signal('');
> 14 | const sorted = computed(() => props.items.toSorted((a: Item, b: Item) => a.price - b.price));
     |                                          ^^^^^^^^^^
  15 | ---
  16 |

Copy the array first: \`[...list].sort()\`, \`[...list].reverse()\`, \`list.slice()\` then \`splice\`.

error web/screens/Shop.nexus:27:17: \`color-mix()\` needs Chromium 111. FiveM runs Chromium 103. (unsupported-css)

  25 | <style>
  26 |   .card {
> 27 |     background: color-mix(in srgb, #c8ff3d 12%, transparent);
     |                 ^^^^^^^^^^
  28 |   }
  29 |

Write the colour as \`rgb()\`, \`hsl()\` or hex. For transparency, \`rgb(255 0 0 / 50%)\` works.

error web/screens/Shop.nexus:30:8: \`:has()\` needs Chromium 105. FiveM runs Chromium 103. (unsupported-css)

  28 |   }
  29 |
> 30 |   .list:has(.selected) {
     |        ^^^^^
  31 |     gap: 12px;
  32 |   }

Set a class with \`class:name={condition}\` and style that class.

error nexus check found 3 errors.
`;

export const phoneLua = `
-- A second page, built on its own, registered by hand.
local resource = GetCurrentResourceName()

local function addApp()
    exports['lb-phone']:RemoveCustomApp('my_shop')
    exports['lb-phone']:AddCustomApp({
        identifier = 'my_shop',
        name = 'Shop',
        ui = resource .. '/phone/index.html',
        icon = 'https://cfx-nui-' .. resource .. '/phone/icon.png',
    })
end

if GetResourceState('lb-phone') == 'started' then addApp() end

-- LB Phone restarted: the app is gone until it is added again.
AddEventHandler('onClientResourceStart', function(started)
    if started == 'lb-phone' then addApp() end
end)

AddEventHandler('onResourceStop', function(stopped)
    if stopped == resource then
        exports['lb-phone']:RemoveCustomApp('my_shop')
    end
end)

-- And a second way to reach the page, next to SendNUIMessage.
exports['lb-phone']:SendCustomAppMessage('my_shop', {
    action = 'stock',
})
`;

export const phoneScreen = `
---
import { nui, t } from 'nexus';

const hud = nui.state('hud');
---

<screen surface="phone" />

<main class="app">
  <h1>{t('app.title')}</h1>
  <p>{hud.fuel}%</p>
</main>
`;

export const phoneApp = `
Nexus.app('phone', {
    name = 'My shop',
    description = 'Order from anywhere',
    icon = 'web/dist/app-icon.png',
    defaultApp = true,
})
`;

export const gameLoop = `
# change one colour in the page, then:
npm run build
ensure my_shop      # in the server console
/shop               # in game: open the menu again
# look at it, switch back to the editor, repeat
`;

export const devLoop = `
$ npm run dev
ok my_shop is running at http://localhost:5173/
   Open it in a browser. The bar at the bottom opens the screens with the props from web/mock.ts.
   Press Ctrl+C to stop.
`;
