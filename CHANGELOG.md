# Changelog

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
