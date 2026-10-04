# The `.nexus` file format

A `.nexus` file is one component: its code, its markup and its styles. The compiler turns it into
a small JavaScript module that creates the markup once and then updates only the nodes whose
data changed. There is no virtual DOM and the component's code does not run again on updates.

```nexus
---
import { signal } from 'nexus';

const count = signal(0);
---

<button class="counter" on:click={() => count.value++}>
  Clicked {count} times
</button>

<style>
  .counter { padding: 8px 12px; }
</style>
```

Contents:

- [Parts of a file](#parts-of-a-file)
- [Script](#script): [TypeScript](#typescript), [keys](#keys), [timers](#timers),
  [sounds](#sounds), [dev helpers](#dev-helpers)
- [Template](#template): [text](#text-and-expressions), [signals](#signals-in-the-template),
  [attributes](#attributes), [whitespace](#whitespace)
- [Directives](#directives): [`on:`](#onevent), [`bind:`](#bind), [`class:`](#classname),
  [`style:`](#styleproperty), [`use:`](#useaction), [`transition:`](#transitionname)
- [Blocks](#blocks): [`{#if}`](#if), [`{#each}`](#each), [`{#key}`](#key), [`{@html}`](#html)
- [Components](#components), [slots](#slots)
- [`<screen>`](#screen), [apps for LB Phone and LB Tablet](#apps-for-lb-phone-and-lb-tablet)
- [Styles](#styles)
- [What Chromium 103 cannot run](#what-chromium-103-cannot-run)
- [Rules the compiler enforces](#rules-the-compiler-enforces)

## Parts of a file

1. **Script** (optional): TypeScript between two lines that contain only `---`, at the very top.
2. **Template**: everything after the script that is not a `<style>` block.
3. **Style** (optional, any number): `<style>` blocks at the top level of the file.

A file with only a template is a valid component.

## Script

```nexus
---
import { signal, computed, onMount, onCleanup } from 'nexus';
import Price from '../components/Price.nexus';

interface Props {
  item: string;
  price: number;
}

const amount = signal(1);
const total = computed(() => amount.value * props.price);

onMount(() => console.log('in the document'));
onCleanup(() => console.log('removed'));
---
```

- `import` statements are moved to the top of the compiled module. Everything else runs **once
  for each instance** of the component, when it is created.
- `props` is in scope without an import. It holds what the component was given and it is
  read-only. Reading `props.price` inside a template expression, a `computed` or an `effect` is
  tracked: when the value changes, whatever read it updates.
- Destructuring `props` copies the values at that moment, so the copies never update. The
  compiler warns about it. Read `props.name` where you use it, or wrap it:
  `const name = computed(() => props.name)`.
- `interface Props` (or `type Props`) describes the props for `nexus check`.
- `onMount(fn)` runs after the component's nodes are in the document. `onCleanup(fn)` runs when
  the component is removed. Effects created in the script stop with the component.
- The script runs synchronously, so it cannot use `await` at the top level. Put asynchronous
  work in a function: `onMount(async () => { ... })`.
- A script can export types (`export type`, `export interface`), so that another file can
  import them from the `.nexus` file. It cannot export values: the component is the only value
  the file exports. Shared code belongs in a `.ts` module.
- Names that start with `$` are reserved for the compiler.

### TypeScript

The script and every expression in the template are TypeScript. Types are removed and nothing
else is rewritten: annotations, generics, `interface`, `type`, `as`, `satisfies`, `!`,
`import type`, `declare`, overloads, `abstract`, access modifiers and `implements` all work.
An import that is only used as a type is dropped, as TypeScript itself does.

Syntax that generates code instead of only describing types is rejected with what to write
instead: `enum` (use an object with `as const`), `namespace`, constructor parameter properties
(`constructor(private x: number)`) and `import x = require()`. This is the same subset Node.js
runs natively, and the `erasableSyntaxOnly` option of TypeScript checks it in your editor.

### Keys

```nexus
---
import { onKey } from 'nexus';

onKey('Enter', confirm);
onKey(' ', () => jump());
onKey('ArrowDown', () => select(index.value + 1));
---
```

`onKey(key, handler)` calls the handler when the key is pressed while the component is mounted.
`key` is the `key` of the keyboard event, in any case: `'Escape'`, `'Enter'`, `'e'`, `' '`.

A key with a handler does nothing else. With a button focused, Space or Enter runs the handler
and does not also click the button. Arrow keys and Space do not scroll, Enter does not follow
the focused link.

Fields keep working while the player types. While an `<input>`, `<textarea>` or `<select>` (or
an editable element) has focus:

- a character key, Space included, goes to the field and its handler does not run, so a hotkey
  on `e` does not fire while someone types a name with an `e` in it;
- any other key reaches both: a handler for `ArrowDown` can move through a list of results
  while the caret stays in the search box, and Enter still starts a new line in a textarea.

With Ctrl, Alt or the Windows key held, the handler runs and the key keeps what it normally
does, so a handler on `r` does not block the browser's reload while you develop.

Escape is handled for you on a screen that declares `close="escape"`. With several screens
open, it closes one: the screen in use, which is the last one opened that takes focus.

### Timers

```nexus
---
import { after, every } from 'nexus';

every(1000, () => seconds.value++);
const cancel = after(3000, () => (notice.value = ''));
---
```

`after(ms, fn)` runs `fn` once and `every(ms, fn)` runs it repeatedly. Both stop when the
component is removed, so a closed screen leaves no timer running, and both return a function
that stops them earlier. They can be called from the script and from event handlers. A plain
`setTimeout` or `setInterval` keeps running after the screen is gone unless you clear it in
`onCleanup`.

### Sounds

```nexus
---
import { sound, nui } from 'nexus';

sound.register({ click: './sounds/click.ogg', close: './sounds/close.ogg', engine: './sounds/engine.ogg' });

const stopEngine = sound.loop('engine', { volume: 0.4 });

function leave() {
  sound.play('close', { keep: true });
  nui.close();
}
---

<button on:click={() => sound.play('click')}>Buy</button>
<button on:click={leave}>Close</button>
```

A sound started by a component stops when the component is removed: closing a screen silences
what it was playing. `keep: true` lets one sound play to its end anyway, which is what a
closing sound needs. A loop that is kept plays until the function `sound.loop` returned is
called.

### Dev helpers

```nexus
---
import { dev } from 'nexus';

dev.action('Sell out', () => (stock.value = 0));
---
```

`dev.action(label, fn)` adds a button to the toolbar of `nexus dev`. A build has no toolbar:
every call to `dev` is removed from it together with its arguments, so the label and the
function never reach players. Nothing has to be wrapped in a condition. The same goes for
calls in `.ts` and `.js` modules of the project.

## Template

### Text and expressions

```nexus
<p>Hello {props.name}, you have {messages.value.length} new messages.</p>
```

`{expression}` inserts the value of any JavaScript expression. It is always inserted as text,
never as markup, so a player's name containing `<b>` shows up as `<b>`. `null` and `undefined`
insert nothing.

To write a literal brace, use `{'{'}` or `&#123;`.

Character references work as in HTML for numeric forms (`&#160;`, `&#xA0;`) and for the common
names (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&nbsp;`, `&copy;`, `&hellip;`, `&times;`, arrows,
currency signs and a few more). The compiler warns about a name it does not know.

HTML comments (`<!-- ... -->`) are dropped.

### Signals in the template

When the whole expression is a signal, its value is used:

```nexus
<p>{count}</p>
<input value={name} disabled={nui.pending('shop:buy')}>
{#if open}...{/if}
```

Inside a larger expression, write `.value`:

```nexus
<p>{count.value + 1} of {items.value.length}</p>
```

The rule is the same everywhere a value is read: text, attributes, props of components, block
conditions and lists.

### Attributes

```nexus
<a href="/garage" title='Garage'>            <!-- text -->
<input value={name} max={props.stock}>        <!-- expression -->
<div class="item {kind} selected">            <!-- text with expressions in it -->
<button {disabled}>                           <!-- short for disabled={disabled} -->
<input {...attributes}>                       <!-- every key of an object -->
<input disabled>                              <!-- on, without a value -->
```

- `false`, `null` and `undefined` remove the attribute. `true` sets it without a value.
- `value`, `checked`, `selected` and `muted` are set as properties, so they change what a form
  control shows, not only its initial state.
- Void elements (`<input>`, `<img>`, `<br>` and so on) need no closing slash. Any element or
  component can be closed in place with `/>`.
- Every other tag is closed explicitly. `<li>` and `<p>` do not close themselves.
- A dynamic `class` only adds and removes its own names, so it works next to `class:` directives.

### Whitespace

- A run of spaces and line breaks is one space.
- Whitespace at the start and at the end of an element or a block is removed.
- Whitespace between two tags (or blocks) that contains a line break is removed.

So tags on separate lines have nothing between them, and `<b>one</b> <i>two</i>` on one line
keeps its space. Inside `<pre>` and `<textarea>` text is kept exactly as written.

## Directives

A directive is an attribute with a colon in its name. Directives work on elements, not on
components.

### `on:event`

```nexus
<button on:click={save}>Save</button>
<button on:click={() => remove(item.id)}>Remove</button>
<form on:submit|prevent={send}>...</form>
<div on:click|self|stop={close}>...</div>
```

The handler receives the event. Signal writes inside a handler are batched: the page updates
once, after the handler returns.

| Modifier | Effect |
|---|---|
| `prevent` | calls `event.preventDefault()` |
| `stop` | calls `event.stopPropagation()` |
| `once` | removes the handler after the first event |
| `self` | only runs when the event started on this element, not on a child |
| `capture` | listens in the capture phase |

### `bind:`

Two-way binding between a form control and a signal, or a property of a `store`.

```nexus
---
import { signal, store } from 'nexus';

const name = signal('');
const amount = signal(1);
const agreed = signal(false);
const colour = signal('red');
const extras = signal<string[]>([]);
const form = store({ city: '' });
const input = signal<HTMLInputElement | null>(null);
---

<input bind:value={name}>
<input type="number" bind:value={amount}>         <!-- a number, or null while empty -->
<textarea bind:value={form.city}></textarea>
<select bind:value={colour}>
  <option value="red">Red</option>
  <option value="blue">Blue</option>
</select>

<input type="checkbox" bind:checked={agreed}>

<input type="radio" value="red" bind:group={colour}>
<input type="radio" value="blue" bind:group={colour}>

<input type="checkbox" value="gps" bind:group={extras}>      <!-- an array of the checked values -->
<input type="checkbox" value="radio" bind:group={extras}>

<input bind:this={input}>                          <!-- the element itself, null once it is removed -->
```

| Binding | Works on |
|---|---|
| `bind:value` | `<input>`, `<textarea>`, `<select>` |
| `bind:checked` | `<input type="checkbox">`, `<input type="radio">` |
| `bind:group` | `<input>` with a fixed `type="radio"` or `type="checkbox"` |
| `bind:this` | any element |

`bind:value` alone is short for `bind:value={value}`.

### `class:name`

```nexus
<li class="row" class:selected={item.id === selected.value} class:disabled>
```

Adds the class while the value is truthy. `class:disabled` alone is short for
`class:disabled={disabled}`.

### `style:property`

```nexus
<div style:width="{percent}%" style:--accent={props.colour} style:opacity={visible.value ? 1 : 0.4}>
```

Sets one CSS property, including custom properties. `null`, `undefined` and `false` remove it.
Do not combine `style:` with a dynamic `style={...}` attribute on the same element: when the
attribute changes it replaces the whole inline style. The compiler warns about it.

### `use:action`

```nexus
---
function tooltip(node: Element, text: string) {
  node.setAttribute('title', text);
  return () => node.removeAttribute('title');
}
---

<button use:tooltip={props.hint}>?</button>
```

Calls `action(node, argument)` once the element is in the document. The function may return a
cleanup function. When the argument changes, the cleanup runs and the action is called again
with the new value. The cleanup also runs when the element is removed.

### `transition:name`

```nexus
{#if open}
  <div class="panel" transition:fade>...</div>
{/if}

<style>
  .fade-enter { animation: fade-in 150ms ease-out; }
  .fade-leave { animation: fade-in 150ms ease-in reverse forwards; }
  @keyframes fade-in { from { opacity: 0; } }
</style>
```

- When the element is inserted it has the class `name-enter`. The class is removed when the
  animation it started ends.
- Before the element is removed it gets `name-leave`, and it stays in the document until that
  animation ends.

CSS transitions work too. With no animation on `name-enter`, the class is removed right after
the element is inserted, which starts a transition from the enter styles:

```css
.slide { transition: transform 150ms; }
.slide-enter, .slide-leave { transform: translateX(-100%); }
```

A transition plays when the block that directly contains the element adds or removes it: the
branch of an `{#if}`, a row of an `{#each}`, or the screen itself when it opens and closes. A
leaving element is frozen: its bindings and event handlers no longer run.

## Blocks

### `{#if}`

```nexus
{#if props.stock > 5}
  <p>In stock</p>
{:else if props.stock > 0}
  <p>Only {props.stock} left</p>
{:else}
  <p>Sold out</p>
{/if}
```

A branch is created when its condition becomes true and removed when it stops being true. While
the same branch stays selected, its nodes are kept and only their bindings update.

### `{#each}`

```nexus
<ul>
  {#each props.vehicles as vehicle, index (vehicle.plate)}
    <li>{index + 1}. {vehicle.name}</li>
  {:else}
    <li>No vehicles</li>
  {/each}
</ul>
```

- `as vehicle` names the item. It can be a destructuring pattern: `as { name, plate }`.
- `, index` (optional) names the position, starting at 0.
- `(vehicle.plate)` (optional) is the **key**: a value that identifies the item. With a key, a
  row follows its item when the list is reordered: its nodes are moved, not created again, and
  only rows whose item is new are created. The key must be computed from the item and be unique
  in the list.
- Without a key, rows are matched by position: row 3 shows whatever item is third. Writing the
  index as the key, `as vehicle, index (index)`, says the same thing explicitly.
- `{:else}` (optional) is shown while the list is empty.

The list can be an array or any other iterable. `null` and `undefined` count as empty.

A block inside another can use the same names again. Inside it they mean its own item and
index, and outside it the outer ones:

```nexus
{#each groups as group, index (index)}
  <h2>{index + 1}. {group.name}</h2>
  {#each group.vehicles as vehicle, index (vehicle.plate)}
    <p>{index + 1}. {vehicle.name}</p>
  {/each}
{/each}
```

The one exception is a name that the outer block takes out of its item together with others,
as in `as { id, rows }`: bind `id` again further in and the compiler asks for another name.

### `{#key}`

```nexus
{#key props.vehicle.plate}
  <VehiclePreview vehicle={props.vehicle} />
{/key}
```

Removes its content and creates it again whenever the value changes. Use it to restart a
component or replay an enter transition for a new value.

### `{@html}`

```nexus
<div class="description">{@html props.descriptionHtml}</div>
```

Inserts a string as markup. **Never pass it text that a player typed**: a name, a chat message,
a plate, anything that comes from input. It is parsed as HTML, so such text could add elements
and run code in every client that displays it. Use `{expression}` for those. `{@html}` is for
markup written by the resource itself.

## Components

A tag that starts with a capital letter, or contains a dot, is a component. Import it in the
script and use it as a tag:

```nexus
---
import Price from '../components/Price.nexus';
import * as ui from '../components/ui';
---

<Price value={total} currency="USD" bold />
<ui.Button label="Buy" onPress={buy} />
<Price {...priceProps} bold />
```

- Attributes become props. An expression is passed live: the child reads the current value each
  time, so it updates when the value changes. A signal passed as the whole value arrives
  unwrapped (`props.value` is the number, not the signal).
- A function is a prop like any other. Pass handlers as props (`onPress={buy}`) and call them
  inside the component: `on:click={() => props.onPress?.()}`.
- Directives cannot be used on a component.

### Slots

A component renders what is between its tags with `<slot />`:

```nexus
<!-- Card.nexus -->
<article class="card">
  <header><slot name="title">Untitled</slot></header>
  <slot />
  <footer><slot name="footer" /></footer>
</article>
```

```nexus
<Card>
  <h2 slot="title">Sultan RS</h2>
  <p>Four doors, all-wheel drive.</p>
  <button slot="footer" on:click={buy}>Buy</button>
</Card>
```

- Children without a `slot` attribute go to `<slot />`.
- A direct child with `slot="name"` goes to `<slot name="name" />`.
- What is inside a `<slot>` tag is the fallback, shown when the parent gave nothing for it.

Slot content belongs to the parent: it reads the parent's variables and uses the parent's styles.

## `<screen>`

A file in `web/screens/` is a screen, named after the file with its first letter in lower case:
`Shop.nexus` is `shop`, `VehicleShop.nexus` is `vehicleShop`. Lua opens it with
`Nexus.open('shop', props)`. The `<screen>` tag declares how it behaves. It must be the first
thing in the template, and its attributes are plain values, not expressions.

```nexus
<screen focus="mouse keyboard" close="escape" size="1920x1080" />
```

| Attribute | Values | Default | Meaning |
|---|---|---|---|
| `focus` | `mouse`, `keyboard`, both, or `none` | both (`none` for a hud) | What the page gets through `SetNuiFocus` while the screen is open |
| `keep-input` | present or not | not | The game keeps receiving input (`SetNuiFocusKeepInput`) |
| `close` | `escape`, `none` | `escape` when the screen has keyboard focus | Escape closes the screen |
| `size` | `1920x1080` | none | Design size: the screen is a box of this size, scaled to fit the window and centred. Without it the screen fills the window. |
| `layer` | `screen`, `hud` | `screen` | A `hud` takes no focus and is drawn under the other screens |
| `cursor` | a CSS cursor | none | Cursor over the screen |
| `surface` | `phone`, `tablet`, `world` | none | The screen is an app in LB Phone or LB Tablet, or is drawn on a prop in the game world, see below |

A screen file without the tag gets the defaults. The build writes these declarations to
`nexus/screens.lua`, so focus is never handled by hand in Lua.

Inside a sized screen, lay things out in pixels of the design size. The `scale` signal holds the
current factor, for the cases where code needs it (converting pointer coordinates, for example),
and CSS can read it as `var(--nexus-scale)`.

Screens stack in the order they are opened, with every `hud` under every other screen. Escape
closes one screen at a time: the last one opened that takes focus, if it declares
`close="escape"`. A screen under it stays open until it is on top itself, and a screen with
`focus="none"` drawn over a menu does not get in the way.

### Apps for LB Phone and LB Tablet

```nexus
<screen surface="phone" />

<main class="app">...</main>
```

A screen with a `surface` is the root of an app. LB shows the built page in a frame of its own,
and the screen is mounted when that page loads: nothing opens it and nothing closes it, it lives
as long as the frame. Lua registers the app with `Nexus.app('phone', { ... })`.

- The frame belongs to LB, so the screen cannot say how it takes focus, closes, is sized or is
  stacked: `focus`, `keep-input`, `close`, `size` and `layer` are errors next to `surface`.
  `cursor` still works. The app fills the frame it is given.
- A resource has at most one screen for the phone and one for the tablet. Everything else in
  the app is components, and moving between its pages is the screen's own business
  (an `{#if}` or a `{#key}` on a signal).
- The same build serves the game's own page and the apps. `nui.call`, `nui.on`, `nui.state`,
  `t()` and the rest work in an app as they do in a screen.
- An app has no props when it starts, because nobody opened it. Give it what it needs through
  `nui.state` or a call. LB only delivers messages to an app whose frame exists (LB Tablet: only
  while the app is the one in front), so an app should ask for what it shows rather than count
  on having received every push.

### World screens

```nexus
<screen surface="world" size="1280x720" />

<main class="clock">...</main>
```

A screen with `surface="world"` is drawn on a texture of the game world, such as the screen of a
prop, by a browser of its own. Lua creates a display of it with
`Nexus.world('clock', { txd = '...', texture = '...', props = { ... } })`, and the screen is
mounted in that browser with those props.

- `size` is required: it is the resolution of the browser, and the screen fills it. Lay the
  screen out in those pixels. A texture is seen from a distance and at an angle, so type that is
  comfortable on a monitor is small on a prop.
- The screen takes no `focus`, `keep-input`, `close` or `layer`: it is not on the page that has
  the game's focus. A player uses it through `Nexus.operate`. `cursor` has no effect, because
  the page draws the only cursor there is.
- A resource may have any number of world screens. The same build serves them, the main page
  and the apps, and what only a display needs is loaded only by a display.
- `props`, `nui.call`, `nui.on`, `nui.state`, `nui.client`, `t()` and `onKey` work as in any
  screen. Text fields work too, with two differences that come from the browser never having the
  game's focus: `:focus` does not match, so style `[data-nexus-focus]` next to it, and no caret
  is drawn.

The Lua side, input and the limits are in [World screens](bridge.md#world-screens).

## Styles

```nexus
<style>
  .card { padding: 16px; }
  .card:hover > .title { color: white; }
  @keyframes pulse { 50% { opacity: 0.5; } }
  .badge { animation: pulse 1s infinite; }
</style>
```

`<style>` is **scoped**: its rules only match elements written in this file. The compiler adds
an attribute (`data-n-<hash>`) to the component's elements and to every selector, and renames
keyframes so that two components can both define `pulse`.

- Scoped rules do not reach into child components, and not into slot content the parent passed.
- `:global(...)` leaves a selector, or a part of one, unscoped:

  ```css
  :global(body) { margin: 0; }
  .card :global(.icon) { width: 16px; }      /* any .icon inside this component's .card */
  :global(.theme-dark) .card { color: white; }
  ```

- `<style global>` leaves the whole block unscoped. Use it for resets and shared classes.

Stylesheets (`import './theme.css'` in the script, or from any module) are not scoped.

## What Chromium 103 cannot run

FiveM's browser is Chromium 103. CSS it does not know is silently ignored there, and a missing
JavaScript function throws, while both work in the browser you develop in. The compiler and the
Vite plugin therefore refuse them and say what to write instead.

CSS: nesting, `:has()`, `@container` and container units, `color-mix()`, `oklch()`/`lab()`/
`color()`, relative colours, `light-dark()`, the `dvh`/`svh`/`lvh` units, `lh`, the `translate`,
`rotate` and `scale` properties (use `transform`), range syntax in media queries
(`width >= 600px`), `@scope`, `@starting-style`, `text-wrap`, `subgrid`, `linear()` easing,
trigonometric and rounding functions, `scrollbar-width`/`scrollbar-color`, scroll-driven
animations, anchor positioning. `mask` properties and `background-clip: text` need their
`-webkit-` form next to them. Rules inside `@supports` are not checked: they are your own
fallback.

JavaScript: `toSorted`/`toReversed`/`toSpliced`, `Object.groupBy`, `Array.fromAsync`,
`Promise.withResolvers`, `Promise.try`, the newer `Set` methods, `URL.canParse`,
`AbortSignal.any`, view transitions, the popover API and a few more. Newer syntax is not a
problem: the build rewrites it.

In a dependency (anything under `node_modules`) the same findings are warnings, because a
library may only use a feature after checking that it exists.

## Rules the compiler enforces

Every error names the file, line and column, shows the code around it and says what to write
instead. Besides syntax errors, these are checked:

- Tags and blocks are closed, in the right order.
- Directives, modifiers and bindings exist, and a binding is on an element it works on and bound
  to something that can be written.
- The key of an `{#each}` uses the item or the index.
- `<screen>` appears once, first, with known attributes and valid values. A surface screen has
  none of the attributes its frame decides, and a world screen has a `size` and none of the
  attributes that concern focus.
- Markup the browser would rearrange is rejected, because the compiled code finds nodes by
  position: a `<tr>` directly in a `<table>` (write the `<tbody>`), a `<div>` inside a `<p>`,
  an interactive element nested in another of the same kind, text directly inside a table row.
  This only concerns elements written directly inside one another. What a component renders,
  and what is inside a block or a slot, is created separately and inserted afterwards, which
  the browser never rearranges: a component inside a `<p>` is fine whatever it renders.
- `<style>` is at the top level, and there is no `<script>` tag.
- Syntax from other frameworks (`@click`, `:class`, `v-if`, `onClick={...}`, `className`) is
  pointed to its equivalent.
