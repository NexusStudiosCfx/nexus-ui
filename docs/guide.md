# Guide: from `nexus create` to a working screen

This guide builds a small resource from nothing: a screen that opens in game, calls the server,
and shows the answer. It takes about fifteen minutes and touches every part of the framework.
The reference for each part is in [format.md](format.md) (components), [bridge.md](bridge.md)
(the contract and the Lua API) and [cli.md](cli.md) (the commands).

Contents:

1. [What you need](#1-what-you-need)
2. [Create a resource](#2-create-a-resource)
3. [Run it in a browser](#3-run-it-in-a-browser)
4. [Read the screen](#4-read-the-screen)
5. [Add a call, end to end](#5-add-a-call-end-to-end)
6. [Open and close screens from Lua](#6-open-and-close-screens-from-lua)
7. [A HUD fed by Lua](#7-a-hud-fed-by-lua)
8. [Strings and languages](#8-strings-and-languages)
9. [An app in LB Phone or LB Tablet](#9-an-app-in-lb-phone-or-lb-tablet)
10. [Build it and start it on a server](#10-build-it-and-start-it-on-a-server)
11. [Develop inside the game](#11-develop-inside-the-game)
12. [Check before you release](#12-check-before-you-release)
13. [Installing from a release file, or a clone](#13-installing-from-a-release-file-or-a-clone)
14. [When something goes wrong](#14-when-something-goes-wrong)

## 1. What you need

- Node.js 20 or newer.
- A FiveM server to test on. The Lua side needs nothing but `lua54 'yes'`: no framework and no
  library. It runs next to ESX, QBCore, Qbox or nothing at all.
- An editor. For VS Code, the folder `editor/vscode` of the repository is an extension that
  highlights `.nexus` files and adds snippets. Install it with the command
  "Developer: Install Extension from Location..." and pick that folder.

## 2. Create a resource

```
npx --package https://github.com/NexusStudiosCfx/nexus-ui/releases/download/v0.2.0/nexus-ui-0.2.0.tgz nexus create my_shop
cd my_shop
npm install
```

The package is released on GitHub, as a file attached to each
[release](https://github.com/NexusStudiosCfx/nexus-ui/releases). The first line runs `nexus create`
from that file, and the new resource depends on the same file, so `npm install` needs nothing
else. The package is not on the npm registry: do not install `nexus-ui` by name. To work from a
downloaded file or a clone instead, see
[Installing from a release file](#13-installing-from-a-release-file-or-a-clone).

The folder is a complete FiveM resource:

```
my_shop/
  fxmanifest.lua
  client/main.lua          registers /my_shop, which opens the screen
  server/main.lua          answers the one call
  locales/en.json          the strings
  web/
    contract.ts            the one call, declared
    mock.ts                stands in for the game in a browser
    screens/Main.nexus     the screen
```

## 3. Run it in a browser

```
npm run dev
```

Open the address it prints. The page is empty apart from a small bar at the bottom: nothing is
open yet, exactly as in game. Click `main` in the bar. The screen opens with the props that
`web/mock.ts` gives it, and its button calls the handler in the same file.

Change a word in `web/screens/Main.nexus` and save. The screen is mounted again in place, with
the props it had. Click `log` in the bar to see what crosses the bridge.

Everything on screen at this point runs without a game. That is the normal way to work on a UI:
in a browser, with the mock answering. The game is needed to test the Lua.

## 4. Read the screen

`web/screens/Main.nexus` has three parts.

```nexus
---
import { signal, nui, t, NuiError } from 'nexus';

interface Props {
  name: string;
}

const name = signal(props.name);
const reply = signal('');

async function send() {
  try {
    const result = await nui.call('greet', { name: name.value });
    reply.value = result.message;
  } catch (error) {
    reply.value = t('main.refused', error instanceof NuiError ? error.code : String(error));
  }
}
---

<screen focus="mouse keyboard" close="escape" size="1920x1080" />

<section class="panel">
  <h1>{t('main.title')}</h1>
  <input bind:value={name} maxlength="24">
  <button on:click={send} disabled={nui.pending('greet')}>{t('main.send')}</button>
  {#if reply}
    <p class="reply">{reply}</p>
  {/if}
</section>

<style>
  .panel { /* scoped to this component */ }
</style>
```

- The **script** between the `---` lines runs once, when the screen opens. `props` is what Lua
  passed to `Nexus.open`. A `signal` is a value the template follows: when `reply.value` changes,
  the one text node that shows it changes, and nothing else runs.
- The **`<screen>` tag** says how the screen behaves in game: it takes the mouse and the keyboard,
  Escape closes it, and it is designed at 1920x1080 and scaled to fit any resolution.
- The **template** is HTML with `{expressions}`, blocks such as `{#if}` and `{#each}`, and
  directives such as `on:click` and `bind:value`.
- The **style** applies to this component only.

## 5. Add a call, end to end

Say the screen should also show how many players are online. That is a question for the server,
so it is a call. A call is declared once and then used from three places.

**Declare it** in `web/contract.ts`:

```ts
export default contract({
  calls: {
    greet: { /* as before */ },
    online: {
      output: s.object({ players: s.int({ min: 0 }), slots: s.int({ min: 1 }) }),
      rate: { limit: 2, per: 5 },
    },
  },
});
```

It takes no input, so it has none. `rate` allows a player two of these calls in any five seconds.

**Answer it** in `server/main.lua`:

```lua
Nexus.handle('online', function(source)
    return { players = #GetPlayers(), slots = GetConvarInt('sv_maxclients', 48) }
end)
```

**Use it** in the script of `Main.nexus`:

```ts
const online = signal('');

nui.call('online').then((result) => {
  online.value = `${result.players} / ${result.slots}`;
});
```

and in its template: `<p>{online}</p>`.

Save, and the editor already knows that `result` has `players` and `slots`: the dev server
rewrote `web/nexus-contract.d.ts` when the contract changed. Write `result.player` and
`npm run check` reports it at that line of the `.nexus` file.

**Mock it** in `web/mock.ts`, so the browser has an answer too:

```ts
calls: {
  greet: (input) => ({ message: `Hello ${input.name}.` }),
  online: () => ({ players: 12, slots: 48 }),
},
```

The mock handler is typed by the contract as well. Return `{ players: '12' }` and it is a type
error in the editor, and at run time the mock refuses the answer just as the server would in dev
mode.

To refuse a call, return a rejection with a code of your choosing:

```lua
Nexus.handle('greet', function(source, data)
    if isMuted(source) then
        return Nexus.reject('muted')
    end
    return { message = 'Hello ' .. data.name }
end)
```

In the page the call then rejects with a `NuiError` whose `code` is `'muted'`.

A refusal can say more than its code. Declare what it carries under `errors`, and the handler
hands it over as the second argument of `Nexus.reject`:

```ts
buy: {
  input: s.object({ item: s.string({ max: 32 }) }),
  output: s.object({ balance: s.int() }),
  errors: { not_enough_money: s.object({ missing: s.int({ min: 1 }) }) },
},
```

```lua
return Nexus.reject('not_enough_money', { missing = price - balance })
```

The page reads it from `error.details`. In dev mode the server checks what the handler passes
against the schema, as it checks an answer. See [Refusals](bridge.md#refusals).

## 6. Open and close screens from Lua

Screens are opened by client Lua, with whatever props they need:

```lua
RegisterCommand('my_shop', function()
    Nexus.open('main', { name = GetPlayerName(PlayerId()) })
end, false)
```

The name is the file name with its first letter in lower case: `web/screens/VehicleShop.nexus`
is `vehicleShop`.

What a screen is opened with can be declared in the contract, next to the calls:

```ts
screens: {
  main: s.object({ name: s.string({ max: 64 }) }),
},
```

`props` in `Main.nexus` then has that type without an `interface Props`, `npm run check` reports
a screen that reads a prop the contract does not have, and in dev mode `Nexus.open` raises an
error when Lua passes something else. A screen the contract does not mention keeps its own
`interface Props`.

Nothing in Lua mentions focus. The `<screen>` tag declares it, and the client runtime gives and
releases it as screens open and close. Closing happens in one of three ways, and Lua does not
have to care which:

- the player presses Escape (when the tag says `close="escape"`);
- the page calls `nui.close()`;
- Lua calls `Nexus.close('main')`.

If something in the game has to follow the screen, a camera for example, tie it to the screen
instead of to the code that opens it:

```lua
Nexus.onOpen('main', function(props)
    startCamera()
end)

Nexus.onClose('main', function()
    stopCamera()
end)
```

`onClose` also runs when the resource stops while the screen is open.

For something the page asks of the client that is not a question of authority, such as showing a
preview, declare a `client` message in the contract, send it with `nui.client('preview', data)`
and handle it with `Nexus.on('preview', function(data) end)`.

## 7. A HUD fed by Lua

A HUD is a screen on the `hud` layer: it takes no focus and stays under the other screens. Its
data is a **state**: an object that Lua patches and the page reads.

```ts
// web/contract.ts
state: {
  hud: s.object({ speed: s.int({ min: 0 }), fuel: s.int({ min: 0, max: 100 }) }),
},
```

```nexus
---
import { nui } from 'nexus';

const hud = nui.state('hud');
---

<screen layer="hud" size="1920x1080" />

<div class="speed">{hud.speed}</div>
<div class="fuel" style:width="{hud.fuel}%"></div>
```

```lua
-- client/main.lua
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
```

`Nexus.set` compares with what it sent before and sends only the keys that changed, so this loop
costs no message while the car stands still. A table is compared by its content, so setting the
same list again sends nothing either. In the page, only the node that shows a changed key
updates.

`Nexus.unset('hud', 'fuel')` removes a key. The server can patch a state too, for one player or
for everyone, which saves an event of your own:

```lua
-- server/main.lua
Nexus.set(source, 'hud', { fuel = 100 })
Nexus.set(-1, 'hud', { fuel = 100 })
```

In the mock, a `setup` function plays the part of that loop. The garage example in
`examples/garage` does exactly this.

## 8. Strings and languages

Strings live in `locales/<language>.json`, as flat keys:

```json
{
  "main.title": "Hello from my_shop",
  "main.refused": "The server refused the call: %s"
}
```

Client Lua loads one file and hands it to the page:

```lua
local language = GetConvar('my_shop_locale', 'en')
Nexus.locale(json.decode(LoadResourceFile(GetCurrentResourceName(), ('locales/%s.json'):format(language))))
```

In a component, `t('main.title')` looks a string up and `t('main.refused', code)` fills its `%s`.
A missing key shows as the key itself. The mock imports the same file, so the browser shows the
same strings. Lua can read the table for its own messages, which keeps a translation in one
place.

Remember `files { 'locales/*.json' }` in `fxmanifest.lua`: the client can only load files the
manifest ships.

## 9. An app in LB Phone or LB Tablet

A screen can be an app in LB Phone or LB Tablet instead of a screen of its own. It is the same
kind of file, with a `surface` in its tag:

```nexus
---
import { nui, t } from 'nexus';

const hud = nui.state('hud');
---

<screen surface="phone" />

<main class="app">
  <h1>{t('app.title')}</h1>
  <p>{hud.fuel}%</p>
</main>

<style>
  .app { height: 100%; padding: 4rem 1.25rem 1.5rem; background: #09090b; color: #f5f5f5; }
</style>
```

Client Lua registers it once, at the top level of a script:

```lua
Nexus.app('phone', {
    name = 'My shop',
    description = 'Order from anywhere',
    icon = 'web/dist/app-icon.png',
    defaultApp = true,
})
```

That is all of it. The runtime adds the app when LB Phone is running, adds it again when LB
Phone restarts, and removes it when your resource stops. On a server without LB Phone the line
does nothing, so one resource serves both kinds of server. `'tablet'` and
`<screen surface="tablet" />` do the same for LB Tablet.

What changes for an app:

- LB opens and closes it, not Lua. `Nexus.open` refuses its name, and `focus`, `close`, `size`
  and `layer` have no meaning in its tag. `Nexus.onOpen` and `Nexus.onClose` still run.
- Calls, pushes, state and strings work as in any screen. A push and a state reach the app and
  the main page alike.
- It has no props. What it shows comes from calls and state.
- LB sets the font size of the frame to fit the device, so sizes in `rem` scale with the phone.
  Leave room at the top for the status bar.
- The icon is a file the resource ships. Put it in `web/public` and it is built to `web/dist`.

With an app in the project, the bar of `npm run dev` gains a `phone` or `tablet` button. It
shows the app in a frame of the device's size, next to the screens, fed by the same mock. The
reference is [Surfaces](bridge.md#surfaces).

## 10. Build it and start it on a server

```
npm run build
```

writes the page to `web/dist` and the Lua bridge to `nexus/`, and checks that `fxmanifest.lua`
loads both. If a line is missing, it prints the line.

Put the folder in your server's `resources` and add to `server.cfg`:

```
ensure my_shop
setr nexus_dev 1
```

The second line is for a development server only. It makes the bridge check what Lua sends
against the contract and say exactly what is wrong. See [Dev mode](bridge.md#dev-mode).

In game, `/my_shop` opens the screen. A server only needs `fxmanifest.lua`, your Lua, `locales`,
`nexus/` and `web/dist`. It does not need `node_modules` or the sources.

`nexus/` and `web/dist` are build output, and the `.gitignore` of a new resource leaves both out
of git. A release has to contain them all the same: a server owner who downloads the resource
has no Node.js to build it with. Run `npm run build` and pack the folder with those two inside,
or attach the built folder to the release instead of relying on the source archive.

## 11. Develop inside the game

To see changes in game without building each time:

```
npm run dev -- --game
```

This points the resource's `ui_page` at the dev server until you stop the command. Run `refresh`
and `ensure my_shop` once in the server console, and from then on saving a `.nexus` file updates
the screen in game. The page talks to the real Lua here, not to the mock.

A change to the contract or to a `<screen>` tag changes the Lua bridge. The terminal says so,
and `ensure my_shop` loads it.

## 12. Check before you release

```
npm run check
```

type-checks the scripts and the templates against the contract and reports CSS and JavaScript
that FiveM's browser, Chromium 103, cannot run. It exits with an error code when it finds
something, so it can run in CI. See [`nexus check`](cli.md#nexus-check).

## 13. Installing from a release file, or a clone

Every release on GitHub has the package attached as one file, `nexus-ui-<version>.tgz`, and a
resource made by `nexus create` depends on its address. To move a resource to a newer version,
change the version in that address in `package.json` (it appears twice) and run
`npm install`.

The file also works from disk, for a machine without access to GitHub or a build of your own.
Download it, then:

```
npx --package ./nexus-ui-0.2.0.tgz nexus create my_shop
cd my_shop
npm install --save-dev ../nexus-ui-0.2.0.tgz
```

The last line installs everything the resource needs and points its `nexus-ui` dependency at the
file, so keep the file where it is, or give the path of wherever you keep it.

From a clone, build that same file yourself:

```
git clone https://github.com/NexusStudiosCfx/nexus-ui
cd nexus-ui
npm install
npm run build
npm pack --pack-destination releases
```

and install `releases/nexus-ui-<version>.tgz` as above.

Install the packed file, not the folder of the clone. npm links a folder instead of copying it,
so `npm install ../nexus-ui` or `npm link` puts the whole repository, its examples and their
`node_modules` included, inside your resource, and a resource that lives in the clone ends up
containing itself. The packed file has only what the package ships.

`npm test` runs the test suite. The tests that drive a real Chromium 103 are skipped unless the
environment variable `NEXUS_CHROMIUM_103` holds the path of its executable.

The example resource is in `examples/garage`: a garage menu with a list, a search, a purchase
that the server validates and can refuse, a vehicle HUD, and the same garage as an app in LB
Phone. It depends on the released file like any other resource:

```
cd examples/garage
npm install
npm run build
```

To build it against the file you packed from the clone instead, install that over it:

```
npm install --no-save ../../releases/nexus-ui-0.2.0.tgz
```

## 14. When something goes wrong

**`nexus/contract.lua must load before nexus/server.lua`** in the server console. The manifest
loads the bridge in the wrong order. Run `npm run build`: it prints the lines to use.

**`Nexus.open: there is no screen 'shop'`.** The name is the file name in `web/screens` with a
lower-case first letter. After adding a screen, build again: Lua learns the screens from
`nexus/screens.lua`.

**A call fails with `rejected`.** The server console says why: the handler raised an error, the
call has no handler, or in dev mode the answer did not match the contract.

**A call fails with `invalid`.** `error.message` names the key and what was expected. The page
sent something the contract does not allow.

**The screen works in the browser but not in game.** Run `npm run check`. The usual cause is CSS
or JavaScript that Chromium 103 does not have. If the check is clean, open the developer tools of
the page in game (`nui_devtools` in the F8 console) and look at its console.

**`Cannot find module 'nexus'`** in the editor or in `nexus check`. `tsconfig.json` needs the two
`paths` entries that the template has, which map `nexus` and `nexus/contract` to the package.

**The cursor stays on screen after a resource restart.** The runtime releases focus when its
resource stops. If another resource took focus, that one has to release it.

**`npm install` stops with `ERESOLVE` after adding a linter.** A new resource pins TypeScript to
`~6.0.0` because typescript-eslint 8 accepts nothing newer. If you raised it, lower it again or
leave the linter out. `nexus check` works with either.

**The app is not in the phone.** The client console says why when LB refuses it, with the reason
LB gave. Otherwise check that `Nexus.app` runs at the top level of a client script, that the
resource was built after the `surface` was added, and that the player has the app installed if
it is not a `defaultApp`.
