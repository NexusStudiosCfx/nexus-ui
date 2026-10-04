# The sandbox

An editor and a live preview for `.nexus` components that runs entirely in the browser. It
compiles with the real compiler, runs the result with the real runtime, and stands in for the game
with the same host `nexus dev` uses, so what works here works in a resource.

It is a small Vite project of its own. The website embeds its build.

## Build

```
npm install
npm run build
```

writes `dist/`. Everything in it is static, and every address is relative to `playground.js`, so
the folder can be served from any path of any site.

| File | |
|---|---|
| `playground.js` | The ES module. Exports `mount` and `examples`. |
| `playground.css` | Its styles. `mount` loads the file itself. |
| `frame.html` | The preview frame: the runtime, the contract library and the mock host, in one file. |
| `assets/*.woff2` | Inter and JetBrains Mono, fetched only when the page has not declared them. |
| `index.html` | A page that mounts the sandbox, to look at the build on its own. |

`npm run dev` serves the same page from the sources on port 4331. `npm run preview` serves
`dist/` on that port.

## Embed

```html
<div id="playground"></div>

<script type="module">
  import { mount } from './playground/playground.js';

  const playground = mount(document.getElementById('playground'), { example: 'hud', height: 640 });
  // playground.destroy() removes it again.
</script>
```

`mount(element, options)` replaces the content of `element` and returns `{ destroy() }`. The
sandbox lives in a shadow tree, so the styles of the page and its own do not reach each other,
and the page does not have to link `playground.css`. Until the stylesheet has loaded, the element
keeps the height the sandbox will have.

| Option | | Default |
|---|---|---|
| `example` | The example to start from, by name. | `'counter'` |
| `files` | Files to start from instead: `{ 'Main.nexus': '...', 'contract.ts': '...', 'mock.ts': '...' }`. | none |
| `compact` | `true` for a small embed: only the component and the preview. | `false` |
| `height` | Height while the editor and the preview are side by side: a number of pixels or a CSS length. Narrower than 820 pixels they are stacked and the height follows the content. | `640`, compact `380` |
| `hash` | Keep the project in the fragment of the address. | `true`, compact `false` |

With `hash`, Share writes the project to the fragment as `#code=...` and copies the address, and
a page opened with that fragment starts from it. `#example=hud` starts from an example, and a
link that only changes the fragment loads what it names. The fragment wins over `files` and
`example`. Leave `hash` off where several sandboxes share a page.

`examples` is the list of `{ name, title, description }` in the order of the menu.

### Examples

| Name | Shows |
|---|---|
| `counter` | Signals and a computed value. |
| `list` | A search over a list, and `{#each}` with a key. |
| `form` | `bind:` on inputs, a select and a checkbox, validation, and the contract refusing input. |
| `call` | A typed call, a refusal with details (`errors` in the contract, `reject` in the mock), the rate limit. |
| `hud` | A screen on the `hud` layer fed by state the mock changes on a timer, and mock actions. |
| `transition` | Pushes from the mock, `transition:` on the rows of a list, `after`. |
| `keys` | `onKey` for the arrow keys, Enter and Backspace. |
| `component` | A child component with props, a named slot and a slot with a fallback. |

### Files of a project

Names are flat, without folders. `Main.nexus` is the screen the preview opens and has to be
there. Other `.nexus` files are components it imports (`import Card from './Card.nexus'`).
`contract.ts` and `mock.ts` are what `web/contract.ts` and `web/mock.ts` are in a resource, and
both are optional. Further `.ts` and `.json` files can be imported by name. A project holds at
most 12 files of 64 kB each.

## How it works

- **Nothing the visitor types runs in the page.** The page parses and compiles the files as
  text. The result runs in `frame.html`, an `<iframe sandbox="allow-scripts">` without an origin
  of its own: it cannot reach the page, its storage or its cookies, and the two only exchange
  messages. A shared link is code someone else wrote, and it is treated the same way.
- **The frame holds the real thing.** `src/frame/main.ts` bundles the runtime, the contract
  library and `createHost` from `src/cli/host/core.ts`, which answers `ready`, validates calls
  against the contract and runs the handlers of the mock. Its observer feeds the bridge log.
- **A new build replaces the preview only once it runs.** It starts in a second frame behind the
  one on screen. A build that fails leaves the last working preview in place, under a panel
  that names the file, the line and the message. An error of the running code is traced back
  through the source maps to the line that was written.
- **The parser is the one difference to `nexus build`.** The compiler parses TypeScript with the
  parser Vite ships, which is native code. Here `vite` is aliased to `src/engine/parser.ts`,
  which answers with acorn. The tests compile every example, the garage example and a set of
  typed components with both parsers and expect identical output.

Types are removed, not checked: there is no type checker in the browser.

The script of the frame is written into `frame.html` itself, and it evaluates the compiled
modules. A site that sends a Content-Security-Policy has to allow that for this one file
(`script-src 'unsafe-inline' 'unsafe-eval'`), and `frame-src 'self'` for the page that embeds it.

## Tests

```
npm test
```

runs the parser comparison and the tests of the engine. They need the dependencies of the
repository root installed as well (`npm install` there), because the comparison runs the native
parser. The build does not. The tests that drive the built sandbox in a browser are skipped
unless `PLAYGROUND_BROWSER` holds the path of a Chrome or Chromium executable. They need
`npm run build` first, and pass in Chromium 103 as in a current Chrome.

`npm run typecheck` also checks the contracts and mocks of the examples against each other.
