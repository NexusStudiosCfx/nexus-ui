import type { Files } from '../engine/project';

export interface Example {
  /** What the `example` option of `mount` takes. */
  name: string;
  title: string;
  description: string;
  files: Files;
}

// Every example is a folder of real files next to this one, bundled as text.
const sources = import.meta.glob<string>(['./*/*.nexus', './*/*.ts', './*/*.json'], { query: '?raw', import: 'default', eager: true });

const CATALOGUE: [name: string, title: string, description: string][] = [
  ['counter', 'Counter', 'Signals and a computed value.'],
  ['list', 'List and search', 'A filtered list with keyed rows.'],
  ['form', 'Form', 'Two-way bindings and validation as you type.'],
  ['call', 'Typed call', 'A call the server can refuse, with details.'],
  ['hud', 'HUD', 'State that the mock changes on a timer.'],
  ['transition', 'Transitions', 'Pushed notifications that enter and leave.'],
  ['keys', 'Keyboard', 'A menu driven by the arrow keys and Enter.'],
  ['component', 'Component and slots', 'Props, a named slot and a fallback.'],
];

function filesOf(name: string): Files {
  const prefix = `./${name}/`;
  return Object.fromEntries(
    Object.entries(sources)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, text]) => [path.slice(prefix.length), text]),
  );
}

export const EXAMPLES: Example[] = CATALOGUE.map(([name, title, description]) => ({ name, title, description, files: filesOf(name) }));
