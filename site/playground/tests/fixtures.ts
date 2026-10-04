const component = (script: string, template = '<p>{label}</p>'): string => `---\n${script}\n---\n\n${template}\n`;

/** Components whose scripts and expressions use the TypeScript syntax the compiler removes. */
export const TYPED: Record<string, string> = {
  annotations: component(`
import { signal, computed, type Signal } from 'nexus';
import type { Vehicle } from './types';

interface Props {
  vehicles: Vehicle[];
  onPick?: (model: string) => void;
}

type Sort = 'name' | 'price';

const sort = signal<Sort>('name');
const selected: Signal<string | null> = signal(null);
const label = computed((): string => (selected.value as string) ?? 'none');
let pending!: number;
const first = props.vehicles[0]!;
const limits = { low: 1, high: 9 } satisfies Record<string, number>;
const narrowed = <number>pending;
`),
  functions: component(`
function pick<T extends { model: string }>(this: void, list: T[], index?: number, ...rest: string[]): T | undefined {
  return list[index ?? 0];
}

function describe(value: string): string;
function describe(value: number): string;
function describe(value: unknown): string {
  return String(value);
}

const identity = <T,>(value: T): T => value;
const load = async <T extends object = {}>(value: T): Promise<T> => value;
function isText(value: unknown): value is string {
  return typeof value === 'string';
}
declare const injected: number;
const label = describe(identity(1));
`),
  classes: component(`
interface Named { name: string }

abstract class Shape<T> implements Named {
  private readonly sides: number = 0;
  protected name!: string;
  declare kind: string;
  size?: number;
  static count = 0;
  abstract area(): number;
  describe(unit: string): string;
  describe(unit: number): string;
  describe(unit: unknown): string {
    return \`\${this.name} \${unit as string}\`;
  }
  public get total(): number {
    return this.sides;
  }
}

class Square extends Shape<number> {
  override area(): number {
    return 4;
  }
}

const label = new Square().describe('cm');
`),
  expressions: component(
    `
import { signal } from 'nexus';

interface Item { id: number; name: string; tags?: string[] }

const items = signal<Item[]>([]);
const label = 'x';
`,
    `<ul>
  {#each items.value as Item[] as { id, name }, index (id)}
    <li class:first={index === 0} on:click={(event: MouseEvent) => console.log(event.target as HTMLElement, name!)}>
      {(name satisfies string).toUpperCase()} {items.value[index]!.tags?.length ?? 0}
    </li>
  {/each}
</ul>
{#if (label as string).length > 0}<p>{label}</p>{/if}`,
  ),
  exports: component(`
export type Size = 'small' | 'large';
export interface Options { size: Size }
import { type Signal, signal } from 'nexus';

const label: Signal<Size> = signal('small');
`),
};

/** Sources the compiler refuses. Both parsers must put the error on the same line. */
export const BROKEN: Record<string, string> = {
  'a syntax error in the script': component('const label = ;'),
  'an unclosed brace in the script': component('function broken() {\n  return 1;\n'),
  'a statement in an expression': '<p>{const a = 1}</p>\n',
  'an unfinished expression': '<p>{count +}</p>\n',
  'an enum': component('enum Tab { Home, Shop }\nconst label = Tab.Home;'),
  'a namespace': component('namespace Shop { export const open = true; }\nconst label = 1;'),
  'a parameter property': component('class Wallet { constructor(private cash: number) {} }\nconst label = 1;'),
  'a value export': component('export const label = 1;'),
  'top-level await': component('const label = await fetch("/x");'),
  'props declared again': component('const props = {};\nconst label = 1;'),
  'a reserved name': component('const $label = 1;\nconst label = 1;'),
};
