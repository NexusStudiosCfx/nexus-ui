# The bridge

The bridge carries messages between the page and Lua. Every message is declared once, in
`web/contract.ts`. From that file the toolchain derives the TypeScript types of `nui`, the Lua
validators that run on the server, and the checks of the browser mock, so the three cannot drift
apart.

Contents:

- [The contract](#the-contract)
- [Schemas](#schemas)
- [What is generated](#what-is-generated)
- [In the page: `nui`](#in-the-page-nui)
- [In client Lua](#in-client-lua)
- [In server Lua](#in-server-lua)
- [Refusals](#refusals)
- [Surfaces](#surfaces)
- [Security model](#security-model)
- [Where JSON and Lua differ](#where-json-and-lua-differ)
- [Dev mode](#dev-mode)
- [The mock](#the-mock)
- [Wire format](#wire-format)

## The contract

```ts
// web/contract.ts
import { contract, s } from 'nexus/contract';

export default contract({
  // Page to server, with an answer. Validated on the server before the handler runs.
  calls: {
    'shop:buy': {
      input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
      output: s.object({ ok: s.boolean(), balance: s.int() }),
      rate: { limit: 5, per: 10 },
    },
  },
  // Server or client Lua to page.
  pushes: {
    'shop:stock': s.object({ item: s.string({ max: 40 }), stock: s.int({ min: 0 }) }),
  },
  // Page to client Lua, nothing comes back. For what is not authority: previews, cameras.
  client: {
    'shop:preview': s.object({ item: s.string({ max: 40 }) }),
  },
  // Named objects that client Lua patches and the page reads reactively.
  state: {
    hud: s.object({ health: s.int(), armour: s.int(), cash: s.int() }),
  },
  // What Lua opens a screen with. Types `props` in web/screens/Shop.nexus.
  screens: {
    shop: s.object({ item: s.string({ max: 40 }), price: s.int({ min: 0 }) }),
  },
});
```

| Section | Direction | Lua side | Page side |
|---|---|---|---|
| `calls` | page to server and back | `Nexus.handle(name, fn)` on the server | `await nui.call(name, input)` |
| `pushes` | Lua to page | `Nexus.push(...)` on either side | `nui.on(name, fn)` |
| `client` | page to client Lua | `Nexus.on(name, fn)` on the client | `nui.client(name, data)` |
| `state` | Lua to page | `Nexus.set(...)` on either side | `nui.state(name)` |
| `screens` | client Lua to page | `Nexus.open(name, props)` on the client | `props` of the screen |

A call has four optional parts:

- `input`: what the page sends. Leave it out for a call that takes nothing: `nui.call('shop:list')`.
- `output`: what the handler returns. Leave it out for a call that returns nothing.
- `rate`: at most `limit` calls in any `per` seconds, counted per player and per call. Without it
  the limit is 30 calls per 10 seconds.
- `errors`: what a refusal carries, by code. See [Refusals](#refusals).

A name is 1 to 64 characters from letters, digits and `_ : . - /`. A state and the props of a
screen must be an `s.object`: a state because it is patched key by key, props because they are
read by name.

`screens` is optional, screen by screen. A screen it names has its `props` typed from the schema:
the script needs no `interface Props`, and one it writes anyway must accept what the contract
declares. `ScreenProps<'shop'>` from `nexus` is that type, for a helper that takes the props. A
screen the contract does not name is typed by its own `interface Props`, as before.

`contract()` checks the definition when the file loads and throws a `ContractError` that names
the place, for example `calls["shop:buy"].rate.limit must be a whole number from 1 to 10000, got 0`.
`nexus build`, `nexus check` and `nexus dev` print it.

## Schemas

Every schema is strict. An object accepts exactly its keys, and every string, array and record
has a maximum size, set by you or by default. A payload that passed validation therefore has a
bounded size, whatever the sender intended.

| Schema | Accepts | TypeScript type |
|---|---|---|
| `s.string({ min, max, pattern })` | Text of `min` to `max` characters. Default `max`: 1024. | `string` |
| `s.int({ min, max })` | A whole number in range. Without a range, any integer a JavaScript number holds exactly. | `number` |
| `s.number({ min, max })` | A finite number. Never NaN or infinity. | `number` |
| `s.boolean()` | `true` or `false` | `boolean` |
| `s.enum(['car', 'bike'])` | One of the listed strings | `'car' \| 'bike'` |
| `s.literal('yes')` | Exactly that string, number or boolean | `'yes'` |
| `s.array(item, { min, max })` | A list of `min` to `max` items. Default `max`: 256. | `T[]` |
| `s.object({ key: schema })` | An object with exactly these keys | `{ key: T }` |
| `s.record(value, { max })` | An object used as a map: text keys of at most 64 characters, at most `max` entries. Default: 256. | `Record<string, T>` |
| `s.union(a, b, ...)` | A value that one of the schemas accepts | `A \| B` |
| `s.json({ maxBytes, maxDepth })` | Any JSON value within a size and a depth. Defaults: 4096 bytes, 8 deep. | `unknown` |
| `s.optional(schema)` | The value, or nothing | `T \| undefined`, and `key?: T` in an object |
| `s.nullable(schema)` | The value, `null`, or nothing | `T \| null \| undefined` |

Details that matter:

- **Length is counted in characters**, not bytes, on both sides: `'日本語'` has length 3.
- **Items of an array and values of a record cannot be optional or nullable.** A Lua table
  cannot hold `nil`, so the gap would be lost on the way. Wrap the array itself instead.
- **`s.nullable` is `s.optional` that also lets TypeScript pass `null`.** Lua has no `null`. See
  [Where JSON and Lua differ](#where-json-and-lua-differ).
- **A union is tried member by member**, and the value passes when one accepts it. Its members
  cannot be optional or nullable: wrap the union instead. For objects that differ by a tag, give
  each a `s.literal` key, which also lets TypeScript narrow on it:

  ```ts
  s.union(
    s.object({ kind: s.literal('cash'), amount: s.int({ min: 1 }) }),
    s.object({ kind: s.literal('item'), name: s.string({ max: 40 }) }),
  )
  ```

- **`s.json` is for data whose shape the resource does not own**, such as the metadata of an
  inventory item. It is the one schema that is not strict about shape, so it is bounded another
  way: by what the value would weigh as JSON and by how deep it nests. The weight is counted the
  same on both sides and is close to the length of the JSON text, not equal to it: a string
  costs its bytes plus 2, a number 8, a boolean 4, a list or object 2 plus 1 per entry, and a key
  its bytes plus 2. Read what you take out of it as carefully as any unknown value.

### Patterns

`pattern` takes a regular expression that the whole string must match. Because the same check has
to give the same answer in JavaScript and in Lua, only a subset is allowed, and `s.string` throws
for anything outside it:

- The pattern starts with `^` and ends with `$`.
- It is a sequence of ASCII characters, `\d`, `\w`, escaped punctuation such as `\.`, and classes
  such as `[a-z0-9_ ]`. Ranges in a class run between letters or digits.
- Each of those may be followed by `?`, `*`, `+`, `{n}`, `{n,}` or `{n,m}`.
- Not allowed: flags, `.`, groups, alternatives with `|`, negated classes such as `[^a]`, other
  escapes such as `\s`, and characters outside ASCII.

```ts
s.string({ max: 8, pattern: /^[A-Z0-9 ]{1,8}$/ })   // a number plate
s.string({ pattern: /^#[0-9a-f]{6}$/ })             // a colour
s.string({ max: 24, pattern: /^[a-z0-9_]+$/ })      // a model name
```

A string that contains a character outside ASCII never matches a pattern. For free text, such as
a chat message, use `min` and `max` alone. For a fixed list of values use `s.enum`.

In Lua a pattern is not run by Lua's own pattern matcher. The generated code walks the text once
per part of the pattern, so the time it takes depends on the length of the text and nothing
else. There is no input that makes it slow.

## What is generated

| File | Written by | Contents |
|---|---|---|
| `web/nexus-contract.d.ts` | `nexus dev`, `nexus build`, `nexus check` | Fills in the `NexusContract` interface of the runtime, which types `nui` |
| `nexus/contract.lua` | `nexus build`, `nexus dev --game` | One validator per message and the rate limit of every call, as plain Lua |
| `nexus/screens.lua` | `nexus build`, `nexus dev --game` | Focus, Escape and surface of every screen, from the `<screen>` tags |
| `nexus/client.lua`, `nexus/server.lua` | `nexus build`, `nexus dev --game` | The two Lua runtimes, copied from the package |

The four Lua files depend on nothing: no framework, no library. `fxmanifest.lua` loads them like
this, before your own scripts:

```lua
lua54 'yes'

ui_page 'web/dist/index.html'
files { 'web/dist/index.html', 'web/dist/**/*' }

shared_scripts { 'nexus/contract.lua' }
client_scripts { 'nexus/screens.lua', 'nexus/client.lua', 'client/main.lua' }
server_scripts { 'nexus/server.lua', 'server/main.lua' }
```

`nexus build` checks these lines and prints the ones that are missing.

The generators are also available from code:

```ts
import { generate } from 'nexus-ui/contract';

const { types, lua } = generate(contract);
```

## In the page: `nui`

```ts
import { nui, NuiError } from 'nexus';
```

| | |
|---|---|
| `nui.call(name, input, { timeout })` | Calls a server handler. Resolves with the output, rejects with a `NuiError`. The default timeout is 10 seconds. |
| `nui.pending(name)` | A read-only signal: a call of that name is waiting for its answer. |
| `nui.on(name, handler)` | Listens to a push until the component is removed. Returns a function that stops listening. |
| `nui.client(name, data)` | Sends a message to client Lua. Nothing comes back. |
| `nui.state(name)` | A reactive object that mirrors what Lua sets with `Nexus.set`. |
| `nui.close()` | Asks Lua to close the screen that has focus. |

All of them are typed by the contract: a wrong name, a missing key or a misspelt field of the
answer is a type error in the editor and in `nexus check`.

A failed call rejects with a `NuiError`. Its `code` is one of:

| Code | Meaning |
|---|---|
| `invalid` | The input did not pass the contract, or the call is not in it. `message` says what was wrong, for example `amount: expected at least 1`. |
| `rate_limited` | The player made this call too often. |
| `rejected` | The handler raised an error, the call has no handler, or (in dev mode) the answer did not match the contract. The server console has the reason. |
| `timeout` | No answer arrived in time. |
| `offline` | There is nothing to answer: the page runs in a browser without a mock handler for this call. |
| anything else | A code the handler returned with `Nexus.reject(code, details)`. `details` holds what it passed along. |

```ts
try {
  const { balance } = await nui.call('shop:buy', { item: 'water', amount: 2 });
} catch (error) {
  if (error instanceof NuiError && error.code === 'not_enough_money') showHint();
}
```

`ScreenProps<'shop'>` is the type of the props the contract declares for a screen.

## In client Lua

`nexus/client.lua` defines the global `Nexus`.

```lua
Nexus.open('shop', { item = 'water', price = 5 })   -- open, or update the props of an open screen
Nexus.close('shop')                                 -- returns whether anything was closed
Nexus.close()                                       -- closes the screen that has focus
Nexus.isOpen('shop')

Nexus.push('shop:stock', { item = 'water', stock = 2 })   -- a push from client Lua
Nexus.set('hud', { health = 87 })                         -- patches the state 'hud'
Nexus.unset('hud', 'armour')                              -- removes keys from it
Nexus.locale(strings)                                     -- the strings behind t()

Nexus.on('shop:preview', function(data) end)        -- a message from nui.client
Nexus.onOpen('shop', function(props) end)
Nexus.onClose('shop', function() end)

local result, problem = Nexus.call('shop:buy', { item = 'water', amount = 2 })   -- a contract call
Nexus.app('phone', { name = 'Shop' })               -- an app in LB Phone, see Surfaces
```

- **Focus is automatic.** The screen opened last that asks for focus has it. When it closes,
  focus goes back to the one before it, or to the game. A screen on the `hud` layer never takes
  focus. Nothing calls `SetNuiFocus` by hand.
- **`focus="mouse"`** shows the cursor. FiveM cannot give a page the mouse without the keyboard,
  so the page also receives key events. To let the player keep moving while a screen is open, add
  `keep-input`. While such a screen shows the cursor, the runtime disables the camera and attack
  controls, so that moving the mouse does not turn the view and a click does not fire a weapon.
- **Escape** is handled by the page: a screen with `close="escape"` asks Lua to close it. The
  runtime keeps the pause menu shut for a quarter of a second afterwards, because the key is
  usually still down when the game gets its input back.
- **`Nexus.set` sends only the keys whose value changed.** Calling it ten times a second with
  the same values sends nothing. A table is compared by its content, key by key and item by
  item, so the same list built again is the same value. Before the page has loaded, the state is
  kept and sent when it is ready.
- **`Nexus.unset(name, key, ...)` removes keys.** In the page they read as `undefined` again,
  which is how a state starts. A key that is not there sends nothing.
- **`Nexus.call(name, data, callback)` makes a contract call from client Lua**, for what does
  not start in a page: a target option, an item, a command. It goes through the same validation,
  rate limit and server handler as `nui.call`. The callback receives `result, problem`. Without
  a callback it waits for the answer and returns the same two values, so it has to run in a
  thread or an event handler. `problem` is `nil` on success and otherwise
  `{ code = string, message = string?, details = any }`, with the codes of a `NuiError`.
- **`onClose` runs however the screen closed:** from Lua, from the page, or because the resource
  stopped. It is the place to undo what `onOpen` did.
- **Messages from the page are validated** against `contract.client` before your handler runs.
  One that does not match is dropped.
- A name that is not in the contract, or a screen that does not exist, raises an error at the
  line that used it.

The runtime starts no thread while it is idle. One runs while a `keep-input` screen has focus,
and one for a quarter of a second after a screen is closed from the page.

When the resource stops, the `onClose` handlers of open screens run and focus is released.

## In server Lua

`nexus/server.lua` defines the global `Nexus`.

```lua
Nexus.handle('shop:buy', function(source, data)
    -- data has passed the contract: a table with item and amount, and nothing else.
    local price = prices[data.item]
    if not price then
        return Nexus.reject('unknown_item')
    end
    if not removeMoney(source, price * data.amount) then
        return Nexus.reject('not_enough_money')
    end
    return { ok = true, balance = getMoney(source) }
end)

Nexus.push(source, 'shop:stock', { item = 'water', stock = 2 })   -- to one player
Nexus.push(-1, 'shop:stock', { item = 'water', stock = 2 })       -- to everyone

Nexus.set(source, 'job', { name = 'police', grade = 2 })          -- a state, for one player
Nexus.set(-1, 'weather', { kind = 'rain' })                       -- or for everyone
Nexus.unset(source, 'job', 'grade')                               -- removes keys
```

A handler may wait (`Wait`, a database query). A call has one handler.

`Nexus.set` on the server reaches the player's client, which applies the patch as its own
`Nexus.set` would: it compares, and only what changed reaches the page. The server keeps no copy
of a state, so it does not know what a player's page shows. A player who joins later has not
received what was set for everyone before: set it again for that player when they join.

When a handler raises an error, the call is answered with `rejected` and the server console
names the call and the player:

```
[nexus] the handler of 'shop:buy' raised an error for player 3: server/main.lua:12: ...
```

## Refusals

`Nexus.reject(code)` refuses a call. The code is a string of 1 to 64 characters, and the page
gets it as the `code` of a `NuiError`.

A refusal can carry data. Declare it under `errors`, by code:

```ts
'shop:buy': {
  input: s.object({ item: s.string({ max: 40 }), amount: s.int({ min: 1, max: 100 }) }),
  output: s.object({ ok: s.boolean(), balance: s.int() }),
  errors: {
    not_enough_money: s.object({ missing: s.int({ min: 1 }) }),
    out_of_stock: s.object({ left: s.int({ min: 0 }) }),
  },
},
```

```lua
return Nexus.reject('not_enough_money', { missing = price - balance })
```

```ts
import { nui, NuiError, type NexusContract } from 'nexus';

type BuyErrors = NexusContract['calls']['shop:buy']['errors'];

try {
  await nui.call('shop:buy', { item: 'water', amount: 2 });
} catch (error) {
  if (error instanceof NuiError && error.code === 'not_enough_money') {
    const { missing } = error.details as BuyErrors['not_enough_money'];
  }
}
```

`error.details` is `unknown`, because a call can also end in `timeout` or `invalid`, which carry
nothing. The generated `NexusContract` has the declared types, as above.

A code that `errors` does not list can still be returned, without details. In dev mode the
server checks details against the schema as it checks an answer, and refuses details for a code
that declares none. `Nexus.call` in client Lua gets them as `problem.details`.

## Surfaces

A surface is somewhere a screen is shown other than the resource's own page. There are two: an
app in LB Phone and an app in LB Tablet. A screen names its surface in its tag, and client Lua
registers the app:

```nexus
<screen surface="phone" />
```

```lua
Nexus.app('phone', {
    name = 'Garage',
    description = 'Your vehicles',
    icon = 'web/dist/app-icon.png',
    defaultApp = true,
})
```

| Field | |
|---|---|
| `name` | The name under the icon. Required. |
| `icon` | A file the resource ships, as a path from its root. The runtime turns it into what each LB expects. |
| `identifier` | What LB knows the app by. Default: the name of the resource. |
| `fixBlur` | LB Phone only. Default `true`: the frame is drawn at its real size, with a font size that scales with the phone. |
| anything else | Passed to LB's `AddCustomApp` as it is: `description`, `developer`, `defaultApp`, `size`, `price` and so on. |

The runtime sets `ui`, `onOpen` and `onClose` itself. What LB does with the other fields is in
its own documentation.

- **Registration needs no care.** The app is added when LB is running, added again when LB
  restarts, and removed when the resource stops. If LB is not on the server, `Nexus.app` does
  nothing and logs nothing. If LB refuses the app, the client console has the reason LB gave.
- **One screen per surface.** A project has at most one screen with `surface="phone"` and one
  with `surface="tablet"`. That screen is the whole app: build its pages as components inside.
- **LB opens and closes it.** `Nexus.open` and `Nexus.close` refuse the name of an app.
  `Nexus.onOpen` and `Nexus.onClose` run when LB shows and hides it, and `Nexus.isOpen(name)`
  says whether it is showing.
- **Calls are answered to the page that asked.** Pushes, state and the locale go to the main
  page and to every app that is showing. An app that was hidden is brought up to date when it
  comes back.
- **The same build serves all of them.** The app is the resource's `web/dist/index.html` with
  the surface in its address, loaded in a frame of the phone or tablet. `files` in
  `fxmanifest.lua` needs nothing extra.
- **An app has no props and no focus of its own.** `focus`, `keep-input`, `close`, `size` and
  `layer` cannot stand next to `surface`.
- **LB sets the root font size of an app** from the size the device is drawn at, so `rem`
  follows the device: about 15px in the phone and 18.5px in the tablet at the sizes of the dev
  frames. The same component is therefore larger in the tablet. Use `rem` for what should grow
  with the device and `px` for what should not.
- **LB Tablet removes the frame of an app that is not in front**, so a tablet app starts again
  each time it is opened. LB Phone keeps an app it has put in the background. Keep what must
  survive in state or on the server, not in the component.

An app that LB Phone kept in the background is not loaded again when the player returns to it,
and the page is not told. To load fresh data on every return, let Lua say so through a state:

```lua
Nexus.onOpen('garageApp', function()
    Nexus.set('app', { shown = GetGameTimer() })
end)
```

```ts
const app = nui.state('app');

effect(() => {
  app.shown;                 // run again each time LB shows the app
  untrack(() => void load());
});
```

`nexus check` and `nexus build` report an app screen that reads props, a surface that no Lua
registers, and a `Nexus.app` for a surface no screen declares. See
[`nexus check`](cli.md#nexus-check).

## Security model

A player controls their own client completely. They can open the developer tools of the page,
call `fetch` on the NUI callback, or trigger the server event directly from an injected script
with any Lua value. The server runtime assumes all of that.

For every call that arrives, in this order:

1. **Identity comes from the server.** `source` is the one FiveM attached to the event. Nothing
   in the payload says who is calling, and an event that did not come from a player is ignored.
2. **Unknown calls are dropped.** A name that is not in the contract gets no handler, no answer
   and no log line.
3. **The rate limit is applied**, per player and per call. It is a sliding window: at most
   `limit` accepted calls in any `per` seconds. Calls with invalid input count too, so
   validation cannot be flooded. Refused calls do not count, so hammering does not extend the
   wait. A player's windows are freed when they leave.
4. **The input is validated** before the handler sees it: types, ranges, lengths, patterns,
   unknown keys. Validation stops at the first problem, and it stops counting the entries of a
   table as soon as there is one too many, so a huge payload is refused without being walked.
   A table that carries a metatable (which is how a function reference arrives) is refused.
5. **The handler runs isolated.** An error in it is caught and logged with the call name, the
   player and a stack trace, the caller gets `rejected`, and the next call works as usual.
6. **The answer goes to the caller only.**

What the bridge does not do is decide whether a player is allowed to do something. The contract
says a `model` is a short lowercase string. Whether that model is for sale, whether this player
owns it and whether they can pay is for the handler to decide, from what the server knows. Never
accept a price, a balance or a player id from the page: send the item, and look the rest up.

The client runtime validates too: `contract.client` messages before your handlers run, and the
input of a call before it is sent, so an honest page gets an immediate `invalid` or
`rate_limited` without a trip to the server. The server relies on none of it.

In production, refused input is not logged, so that a flood cannot fill the console. The caller
still receives the reason.

`{@html}` in a component inserts raw HTML. Text typed by players must never go through it.

## Where JSON and Lua differ

A value crosses the bridge as JSON and is then a Lua table. A few things do not survive that
trip, and the contract is defined by what Lua actually receives. The browser mock applies the
same rules, so what works in `nexus dev` works in game.

- **`null` does not exist in Lua.** A key that holds `null` is an absent key. `s.optional` and
  `s.nullable` therefore accept both `null` and a missing key, and a value Lua leaves out reaches
  the page as `undefined`, never as `null`. Test with `== null`.
- **A trailing `null` in an array disappears**: `[1, 2, null]` arrives as `{ 1, 2 }`. A `null`
  in the middle leaves a gap and is refused.
- **An empty array and an empty object are the same thing** in Lua, an empty table, and FiveM
  encodes an empty table as `[]`. An empty table from Lua therefore reaches the page as `[]`,
  also where the contract says object or record. Iterating it and reading keys from it behave
  as for an empty object.
- **Integers** are limited to what a JavaScript number holds exactly, between -(2^53 - 1) and
  2^53 - 1, so a value means the same on both sides. `1.0` is accepted as the integer 1.
- **Paths in messages count from 1**, as Lua does: `vehicles[2].price: expected an integer`.

## Dev mode

Set the convar `nexus_dev` to 1 on a development server:

```
setr nexus_dev 1
```

`setr` makes it visible to clients as well. With it:

- The server validates what handlers return. An answer that does not match the contract is
  logged and the caller gets `rejected`.
- The details of a refusal are checked against `errors` in the same way.
- `Nexus.push` and `Nexus.set` validate what they are given, on both sides, and raise an error
  at the line that sent the wrong data.
- Refused input and dropped page messages are logged with the reason.

The props of `Nexus.open` are checked in the page, not in Lua, and only under `nexus dev`: a
screen opened with props that do not match `contract.screens` still opens, and the browser
console says what was wrong.

Leave it off in production: output validation costs time on every call, and a bug in a handler's
answer should not take a working feature away from players.

## The mock

`web/mock.ts` stands in for both Lua sides while the page runs in a browser under `nexus dev`.

```ts
import { mock, reject } from 'nexus/contract';
import locale from '../locales/en.json';
import contract from './contract';

export default mock(contract, {
  // The strings behind t().
  locale,
  // The props each screen is opened with from the toolbar.
  screens: {
    shop: { item: 'water', price: 5, stock: 3 },
  },
  // The first value of each state.
  state: {
    hud: { health: 100, armour: 0, cash: 500 },
  },
  // Stand-ins for the server handlers. Typed by the contract.
  calls: {
    'shop:buy': async (input, { push }) => {
      if (input.amount > 3) return reject('out_of_stock', { left: 3 });
      push('shop:stock', { item: input.item, stock: 3 - input.amount });
      return { ok: true, balance: 120 };
    },
  },
  // Stand-ins for the Nexus.on handlers of client Lua.
  client: {
    'shop:preview': (data) => console.info('preview', data.item),
  },
  // Runs once when the page loads: for what Lua does on its own, such as a HUD loop.
  setup({ open, set, action }) {
    open('hud');
    setInterval(() => set('hud', { health: Math.round(Math.random() * 100) }), 1000);
    action('Take damage', () => set('hud', { health: 12 }));
  },
});
```

Handlers and `setup` receive a context with `push(name, data)`, `set(name, patch)`,
`unset(name, key, ...)`, `open(screen, props)` and `close(screen)`, which do what the functions
of the same name do in client Lua, and `action(label, run)`, which adds a button to the dev
toolbar and returns the function that removes it. Use it for what only the game would trigger: a
push from another player, a state that changes on its own.

`reject(code, details)` is the mock's `Nexus.reject`.

The mock enforces the contract exactly as the Lua side does, with the same codes and the same
messages: unknown calls, invalid input, the rate limit, and answers and refusal details that do
not match (always checked, as in dev mode). The props under `screens` are checked against
`contract.screens`. A call without a handler is answered with `offline`.

A screen with a `surface` is shown in a frame the size of a phone or a tablet, over the page,
by its own button in the toolbar. Hiding the frame is what LB closing the app is in game.

## Wire format

This is private to the runtimes and may change between versions. It is documented so that the
traffic you see in the developer tools makes sense.

**Page to Lua**: a POST to the NUI callback `https://<resource>/nexus` with a JSON body. Lua
answers the request at once with `{}`. The result of a call comes back later as a message.

| Body | Meaning |
|---|---|
| `{ t: 'ready' }` | The page has loaded. Lua answers with the locale, the states and the open screens. |
| `{ t: 'call', id, name, data }` | A call. `id` is a number chosen by the page. |
| `{ t: 'client', name, data }` | A message for client Lua. |
| `{ t: 'close', screen? }` | Close this screen, or the one that has focus. |

An app adds `surface: 'phone'` or `surface: 'tablet'` to each of these and posts to the same
callback, so that Lua answers the frame that asked. An app cannot send `close`.

**Lua to page**: `SendNUIMessage`, received as a `message` event. Every message has `__nexus: 1`.

| Message | Meaning |
|---|---|
| `{ t: 'open', screen, props? }` | Open the screen, or update its props. `props` is left out when it is empty. |
| `{ t: 'close', screen }` | Close the screen. |
| `{ t: 'push', name, data }` | A push. |
| `{ t: 'state', name, data?, removed? }` | The changed keys of a state, and the names of the keys taken out with `Nexus.unset`. |
| `{ t: 'locale', data }` | The strings behind `t()`. |
| `{ t: 'res', id, ok: true, data }` | The answer to a call. |
| `{ t: 'res', id, ok: false, code, message?, details? }` | A failed call. |

An app receives the same messages through LB's `SendCustomAppMessage`, which LB forwards to the
frame with `postMessage`. `open` and `close` are never sent to an app.

**Client to server**: the event `<resource>:nexus:call` with `id, name, data`. **Server to
client**: `<resource>:nexus:res` with `id, ok, data` or `id, false, code, message, details`,
sent to the caller only, `<resource>:nexus:push` with `name, data`, and `<resource>:nexus:state`
with `name, patch` or `name, nil, keys`.

**In a browser** there is no FiveM. `nexus dev` installs `window.__NEXUS_HOST__` before the
page's scripts run, and the page talks to it instead:

```ts
window.__NEXUS_HOST__ = {
  post(message): Promise<unknown>,   // receives what the page would POST
  onMessage(listener): void,         // the page registers its receiver for Lua's messages
  resource: string,
  action(label, run): () => void,    // adds a button to the dev toolbar
};
```
