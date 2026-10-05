# Changelog

## 0.3.1

- **`Nexus.unset` reaches the page.** Lua sent the removed keys, and the page ignored them, so a
  key that was unset kept its last value in the page until something set it again. It reads as
  undefined again now, for a state unset on its own and for one unset next to changed keys. The
  same held under `nexus dev` for `unset` in a mock.

## 0.3.0

World screens: a screen drawn on a prop in the game world.

- **`<screen surface="world" size="1280x720" />`** makes a screen one that is drawn on a texture
  of the game, such as the screen of a monitor, by a browser of that size. A resource may have
  any number of them, from the same build as its page and its apps.
- **`Nexus.world(name, { txd, texture, props })`** in client Lua creates a display of it and
  returns it, or `nil` and `'unavailable'`, `'limit'` or `'taken'`. `display:set(props)`,
  `display:destroy()` and `display:alive()` manage it. A resource has four displays at a time
  unless the convar `nexus_world_limit` says otherwise, and all of them are destroyed when it
  stops.
- **Input.** `display:pointer`, `press`, `release`, `scroll`, `type` and `key` drive a display
  from Lua. The page draws its own cursor and turns typed text and keys into edits of the focused
  field and into `keydown` events for `onKey`. `Nexus.operate(display, { entity, camera, onExit })`
  hands the display to the player with a camera in front of it, and `Nexus.release()` takes it
  back.
- **The bridge reaches a display like any page.** A call is answered to the display that made
  it, and pushes, state and the locale go to every display.
- **`nexus dev`** has a button for each world screen and shows it in a frame of its size, with the
  keyboard sent the way a display receives it. The mock takes `worlds: { name: { props } }`.
  With `--game`, a display loads its page from the dev server.
- **`nexus check` and `nexus build`** report a world screen without a `size` or with focus
  attributes, a `Nexus.open` of one, and a `Nexus.world` of a screen that is not one.
- **`examples/world`** is a resource that proves the chain in game: `/worldtest` reports each
  step.
- What world screens need in the page is a file of its own, loaded by a display and by a page
  that forwards input. The runtime of a resource without them is the size it was.

World screens have been tested in Chromium 103 and in Lua, and not yet inside the game. The
[roadmap](docs/roadmap.md#world-screens) says what that leaves open, and lists their limits.

Nothing changes for a resource that has no world screen. To move one from 0.2.2, install
`@nexusstudios/ui@^0.3.0` and build again, which also brings the new `nexus/client.lua`.
- `Nexus.operate` takes `screen`: where the screen is on its entity. The game's cursor then
  points at the prop's screen itself and acts only while it is over it.

## 0.2.2

- **The package is on npm, as `@nexusstudios/ui`.** `npm create nexus-ui my_shop` starts a resource,
  and `npm install --save-dev @nexusstudios/ui` adds the package to one that exists.
- **A new resource depends on `@nexusstudios/ui` by version** (`^0.2.2`), not on the address of a
  release file. To move an existing resource over: remove `nexus-ui` from its `package.json`,
  run `npm install --save-dev @nexusstudios/ui`, and change `nexus-ui` to `@nexusstudios/ui` in
  `vite.config.ts` and in the two `paths` of `tsconfig.json`. Imports from `nexus` and
  `nexus/contract` stay as they are.
- The release file is still attached to every GitHub release, for work without the registry.

## 0.2.1

Fixes found by the first resources that built phone and tablet apps on 0.2.0.

- **A call inside an effect no longer loops.** `nui.call` read the counter behind `nui.pending`
  while changing it, so an effect that made a call ran again when the answer arrived, until the
  cycle guard stopped it. `untrack` around the call is no longer needed.
- **`nexus dev` with a phone app and a tablet app.** Showing one of them threw
  `Cannot read properties of null (reading 'style')` and left the frame without a size.
- **`nexus dev` stops with the task runner that started it.** It watched three processes above
  itself. With a shim and a shell in between, what was ended sat higher, and the server stayed on
  its port. It watches five now.
- **Docs:** how an app loads fresh data when LB Phone shows it again, the root font size LB gives
  an app (`rem` is larger in the tablet), that a call without `output` returns nothing, and the
  names of the app buttons in the dev bar.

To move a resource from 0.2.0, change the version in the address of `nexus-ui` in its
`package.json` (it appears twice) and run `npm install`.

## 0.2.0

The first public release.

- `.nexus` components compiled to direct DOM updates.
- A typed contract: calls, pushes, client messages, state and screen props, with the Lua
  validators and rate limits generated from it.
- Screens that Lua opens by name, with focus and Escape declared in the file.
- Apps for LB Phone and LB Tablet from the same build (`<screen surface>`, `Nexus.app`).
- The `nexus` command: `create`, `dev`, `build`, `check`.
