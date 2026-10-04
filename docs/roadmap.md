# Roadmap

This is version 0.3. The list below is what it does not do. Nothing here is half done in the
code: a feature is either in and documented, or it is on this page.

## Editor

- **No language server.** The VS Code extension highlights `.nexus` files and has snippets. It
  does not complete, show types on hover or underline errors. `nexus check` reports type errors
  in the terminal with their position in the `.nexus` file.
- **A script block that starts after blank lines is not highlighted.** The compiler accepts
  blank lines before the first `---`. The grammar expects it on the first line.
- Only VS Code. The grammar is a TextMate grammar, which other editors can load, but no other
  editor is packaged.

## `nexus check`

- **Slot content is not checked against the component that receives it**, and a `bind:` is not
  checked to point at a signal. Scripts, template expressions and the props passed to a
  component are checked.
- **A component used with a spread** (`<Row {...item} />`) has each attribute checked on its
  own, not the full set against `Props`.
- **DOM APIs newer than Chromium 103 are only caught from a fixed list.** JavaScript built-ins
  are caught from TypeScript's own knowledge of what exists. There is no such source for the
  DOM, so a new DOM method that is not on the list passes.
- No watch mode.

## The contract

- **No tuples and no recursive schemas.** A list has one item schema, and a schema cannot
  contain itself. `s.json` takes data of unknown shape, within a size and a depth.
- **No minimum for records**, only a maximum. Arrays have both.
- **`nui.state` is typed as if every key were set.** A key reads as `undefined` until Lua sets
  it, which the type does not say.
- **The details of a refusal are not typed on `NuiError`.** `error.details` is `unknown`, and the
  declared type is read from the generated `NexusContract`. See [Refusals](bridge.md#refusals).
- **Patterns are a subset of regular expressions**: no groups, alternatives, negated classes or
  characters outside ASCII. See [Patterns](bridge.md#patterns).
- **The server keeps no copy of a state.** A state set for everyone does not reach a player who
  joins later: set it again for that player when they join.
- **The props of a screen are checked in dev mode only**, in the page, and a mismatch is logged,
  not refused.
- **No limit across calls.** The rate limit is per player and per call. There is no budget for
  a player's calls in total.
- No binary payloads. Everything crosses as JSON.

## The bridge

- **A call cannot be cancelled** from the page. It ends with an answer or with the timeout.
- **No streaming answers.** A call has one answer. Progress is a push.
- **An empty Lua table reaches the page as `[]`**, also where the contract says object. See
  [Where JSON and Lua differ](bridge.md#where-json-and-lua-differ).
- No helpers for ESX, QBCore or Qbox. The runtimes are standalone, and a handler calls the
  framework itself.

## Apps in LB Phone and LB Tablet

- **One screen per surface.** A resource has at most one phone app and one tablet app.
- **An app has no props.** LB opens it and passes nothing along. It gets its data with a call
  or a state.
- **A tablet app starts again each time it is opened**, because LB Tablet removes the frame of
  an app that is not in front.
- **No notifications, no badge and no other LB feature.** `Nexus.app` registers the app and
  carries the bridge. What else LB offers is reached through LB's own exports.
- **The page of an app is not told when LB shows it again.** `Nexus.onOpen` runs in Lua, and a
  state set there is how the page hears of it. See [Surfaces](bridge.md#surfaces).
- **A resource that only has apps still has a page of its own.** `ui_page` is required, so
  FiveM keeps the main page loaded, with nothing in it.
- Only LB Phone and LB Tablet. No other phone or tablet resource is supported.

## World screens

- **Not proved in a game client yet.** The page of a display is tested in Chromium 103 and the
  Lua in Lua 5.4, both against stand-ins for the game. Every native is in FiveM's reference, and
  FiveM's source says that a page in a DUI can post to a NUI callback and that `SendDuiMessage`
  arrives in it as a `message` event. What only a game client can show is still open: that the
  texture of a model is replaced and the page is visible on it, that the injected mouse lands
  where it is aimed, and that the original texture comes back. `examples/world` exists to settle
  it: `/worldtest` reports each step. Until someone has run it and it passed, build on world
  screens with a fallback to an ordinary screen.
- **FiveM marks texture replacement as experimental.** The reference says of `AddReplaceTexture`
  that it is not for a live environment. It is what every screen on a prop is built on.
- **A browser per display.** Each costs memory and a share of every frame. A resource has at
  most 4 at a time unless `nexus_world_limit` says otherwise, and the limit is counted per
  resource: two resources with four displays each are eight browsers.
- **Memory is not given back.** FiveM has no native that releases the texture a display drew on,
  so every display that was ever created leaves one behind until the game closes. Create a
  display when a player arrives and keep it while they are near. Do not create one per glance.
- **Local to a client.** Nothing is synchronised: other players see the texture the prop ships
  with unless their own client has a display too.
- **Shared by every copy of the model.** A texture is replaced, not an object. Two time clocks of
  the same model show the same picture, and a second display on the same texture is refused.
- **The model has to be loaded** when the display is created, and a replacement does not
  outlive the model being unloaded.
- **A display never has the focus.** `:focus` does not match in it and no caret is drawn. The
  runtime marks the focused element with `data-nexus-focus`, and typing works. See
  [Input on a display](bridge.md#input-on-a-display).
- **Single clicks only.** There is no double click, `event.buttons` is 0 during a drag, a
  `<select>` shows no list, and characters composed from several keys do not arrive.
- **While operating, the pointer follows the window, not the prop.** The mouse at the left edge
  of the game window is the pointer at the left edge of the screen, wherever the camera has put
  that screen. The game's own cursor may stay visible next to the one the page draws.
- **One display is operated at a time**, and not while a screen has the focus.
- **A message from a display does not say which display.** `Nexus.on` handlers get the data and
  nothing else. Put what tells displays apart in their props.

## The dev server

- **`nexus dev --game` needs the game on the same machine** as the dev server.
- **The mock has no setting for latency or for failure.** A handler that should be slow awaits a
  timer, and one that should fail returns `reject(...)`.
- **One set of props per screen** in the mock. A second scenario is a `dev.action` button.
- The mock does not simulate focus: in a browser every screen receives the mouse and the keyboard.
- **A world screen is shown flat**, in a frame of its size. Nothing stands in for the prop, the
  camera or `Nexus.operate`: the frame takes the mouse and the keyboard whenever it is clicked.

## The command line

- One template for `nexus create`.
- `nexus build` has no watch mode. `nexus dev --game` is the way to iterate in game.

## Testing

- **Client Lua is not tested inside the game.** The Lua runtimes are tested in a real Lua 5.4
  with the FiveM functions they use replaced by stand-ins, and the example is started on a real
  server. Nothing drives a game client.
- **Apps are tested in a frame that stands in for LB**, built from what LB's own page does with
  a custom app, in Chromium 103. The suite does not run LB Phone or LB Tablet.
- **World screens are tested without a DUI.** The page of a display runs in Chromium 103 under
  the address a display has, with the mouse of the test driver in place of the injected one, and
  the Lua runs against stand-ins for the DUI and texture natives. That browser has the focus,
  which a display in game never has.
