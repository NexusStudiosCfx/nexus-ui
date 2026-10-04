import { describe, expect, it } from 'vitest';
import { nearestSource, toSource, toTypeScript } from '../../src/cli/check/virtual';
import { generateScreensLua } from '../../src/cli/screens';
import { parse } from '../../src/compiler';
import { Lua } from '../support/lua';

const SHOP = `---
import { signal } from 'nexus';
import Price from '../components/Price.nexus';

interface Props {
  stock: number;
  history: { id: number; label: string }[];
}

const amount = signal(1);
---

<screen focus="mouse keyboard" />

<section class:busy={amount.value > 3}>
  {#if props.stock > 0}
    <input bind:value={amount} max={props.stock}>
    <Price value={amount} {...props} use:tooltip={'price'} />
  {:else if props.stock === 0}
    <p>{@html soldOut}</p>
  {:else}
    <p>never</p>
  {/if}
  {#each props.history as row, index (row.id)}
    <li title="Row {index}">{row.label}</li>
  {:else}
    <li>{empty}</li>
  {/each}
  {#key amount}
    <span>{amount}</span>
  {/key}
</section>
`;

describe('the TypeScript stand-in of a component', () => {
  const file = toTypeScript(parse(SHOP), SHOP);

  it('keeps the script, declares props from the Props interface and turns blocks into control flow', () => {
    expect(file.code).toBe(`import { signal } from 'nexus';
import Price from '../components/Price.nexus';

interface Props {
  stock: number;
  history: { id: number; label: string }[];
}

const amount = signal(1);

declare const props: Readonly<Props>;
function __nexusTemplate() {
(amount.value > 3
);
if (props.stock > 0
) {
(props.stock
);
(amount
);
(Price
);
(amount
);
(props
);
(tooltip
);
('price'
);
}
else if (props.stock === 0
) {
(soldOut
);
}
else {
}
for (const row of __nexusEach(props.history
)) {
const index: number = 0;
(row.id
);
(index
);
(row.label
);
}
{
(empty
);
}
(amount
);
{
(amount
);
}
}
declare const __nexusComponent: (props: Props) => Node;
export default __nexusComponent;
`);
  });

  it('checks the attributes of a component together, as its props', () => {
    const source = `---
import Meter from './Meter.nexus';
---

<Meter label="Fuel {level}%" {value} low={value < 15} wide slot="footer" on:click={pick} />
`;
    const meter = toTypeScript(parse(source), source);
    expect(meter.code).toContain(`__nexusUse(Meter)({
'label': \`Fuel \${(level
)}%\`,
'value': (value
),
'low': (value < 15
),
'wide': true,
});
(pick
);
`);

    // A missing prop is reported on the opening brace, a wrong value on the quote before its key.
    const brace = meter.code.indexOf('({') + 1;
    expect(source.slice(toSource(meter, brace) as number).startsWith('Meter label')).toBe(true);
    const quote = meter.code.indexOf("'value'");
    expect(source.slice(toSource(meter, quote) as number).startsWith('value} low')).toBe(true);
  });

  it('reports a problem in glue code at the expression the glue was written for', () => {
    const source = '{#each list as item}\n  <p>{item}</p>\n{/each}\n';
    const each = toTypeScript(parse(source), source);
    const glue = each.code.indexOf('__nexusEach');
    expect(toSource(each, glue)).toBeNull();
    expect(source.slice(nearestSource(each, glue)).startsWith('item}')).toBe(true);
  });

  it('maps every copied expression back to where it was written', () => {
    for (const expression of ['amount.value > 3', 'props.stock === 0', 'soldOut', 'row.label', 'tooltip', "'price'", 'Price\n']) {
      const generated = file.code.indexOf(expression, file.code.indexOf('__nexusTemplate'));
      const source = toSource(file, generated);
      expect(source, expression).not.toBeNull();
      expect(SHOP.slice(source as number, (source as number) + expression.trimEnd().length)).toBe(expression.trimEnd());
    }
    const script = file.code.indexOf('const amount');
    expect(SHOP.slice(toSource(file, script) as number).startsWith('const amount = signal(1);')).toBe(true);
  });

  it('has no source position for the glue between expressions', () => {
    expect(toSource(file, file.code.indexOf('declare const props'))).toBeNull();
    expect(toSource(file, file.code.indexOf('__nexusEach'))).toBeNull();
  });

  it('leaves props untyped when the script declares no Props', () => {
    const source = '<p>{props.anything}</p>\n';
    expect(toTypeScript(parse(source), source).code).toContain('declare const props: Readonly<Record<string, any>>;');
  });

  it('hands a handler to a typed function, so its parameter is the event of that element', () => {
    const source = '<input on:input={(event) => save(event.currentTarget.value)}>\n<Row on:pick={(id) => pick(id)} />\n';
    const { code } = toTypeScript(parse(source), source);
    expect(code).toContain('__nexusOn("input", "input", ((event) => save(event.currentTarget.value)\n));');
    // The events of a component are its own. TypeScript is not told what they carry.
    expect(code).not.toContain('__nexusOn("Row"');
    expect(code).toContain('((id) => pick(id)\n);');
  });

  it('types the props of a screen from the contract when the contract declares them', () => {
    const source = '<screen />\n<p>{props.name}</p>\n';
    const { code } = toTypeScript(parse(source), source, { screen: 'shop' });
    expect(code).toContain(`declare const props: Readonly<import('nexus').ScreenProps<"shop">>;`);
    expect(code).toContain(`(props: import('nexus').ScreenProps<"shop">) => Node`);
  });

  it('holds the Props a screen writes itself to what the contract declares', () => {
    const source = '---\ninterface Props { name: string }\n---\n<screen />\n<p>{props.name}</p>\n';
    const typed = toTypeScript(parse(source), source, { screen: 'shop' });
    expect(typed.code).toContain(`: Props = undefined as unknown as import('nexus').ScreenProps<"shop">;`);
    expect(typed.code).toContain('declare const props: Readonly<Props>;');
    // A mismatch is reported on the name of the interface.
    const at = toSource(typed, typed.code.indexOf('__nexusContractProps'));
    expect(source.slice(at as number).startsWith('Props { name: string }')).toBe(true);
  });
});

describe('generateScreensLua', () => {
  it('writes what the client runtime needs, as Lua that loads', async () => {
    const code = generateScreensLua([
      {
        name: 'shop',
        file: 'web/screens/Shop.nexus',
        declaration: { focus: { mouse: true, keyboard: true }, keepInput: false, close: 'escape', size: { width: 1920, height: 1080 }, layer: 'screen', cursor: null },
      },
      {
        name: 'hud',
        file: 'web/screens/Hud.nexus',
        declaration: { focus: { mouse: false, keyboard: false }, keepInput: false, close: 'none', size: null, layer: 'hud', cursor: null },
      },
      {
        name: 'radial-menu',
        file: 'web/screens/Radial-menu.nexus',
        declaration: { focus: { mouse: true, keyboard: false }, keepInput: true, close: 'escape', size: null, layer: 'screen', cursor: 'crosshair' },
      },
    ]);
    expect(code).toBe(`-- Generated by Nexus UI from the <screen> tags in web/screens. Do not edit: the next build overwrites it.

NexusScreens = {
    hud = { layer = 'hud', mouse = false, keyboard = false, keepInput = false, escape = false },
    ['radial-menu'] = { layer = 'screen', mouse = true, keyboard = false, keepInput = true, escape = true },
    shop = { layer = 'screen', mouse = true, keyboard = true, keepInput = false, escape = true },
}
`);

    const lua = await Lua.create();
    await lua.run(code);
    expect(await lua.run(`return NexusScreens['radial-menu'].keepInput and NexusScreens.shop.escape and NexusScreens.hud.layer`)).toBe('hud');
    lua.close();
  });

  it('marks the screen that is an app, so client Lua knows which page it lives in', () => {
    const code = generateScreensLua([
      {
        name: 'garageApp',
        file: 'web/screens/GarageApp.nexus',
        declaration: { focus: { mouse: false, keyboard: false }, keepInput: false, close: 'none', size: null, layer: 'screen', cursor: null, surface: 'phone' },
      },
    ]);
    expect(code).toContain("garageApp = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'phone' },");
  });

  it('gives a world screen the size of its browser, which is what Lua creates it with', () => {
    const code = generateScreensLua([
      {
        name: 'clock',
        file: 'web/screens/Clock.nexus',
        declaration: { focus: { mouse: false, keyboard: false }, keepInput: false, close: 'none', size: { width: 1280, height: 720 }, layer: 'screen', cursor: null, surface: 'world' },
      },
    ]);
    expect(code).toContain("clock = { layer = 'screen', mouse = false, keyboard = false, keepInput = false, escape = false, surface = 'world', width = 1280, height = 720 },");
  });

  it('writes an empty table for a project without screens', () => {
    expect(generateScreensLua([])).toContain('NexusScreens = {}\n');
  });
});
