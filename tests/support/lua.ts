import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LuaFactory, type LuaEngine } from 'wasmoon';

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

const JSON_LUA = readFileSync(here('./json.lua'), 'utf8');
const FIVEM_LUA = readFileSync(here('./fivem.lua'), 'utf8');

export const CLIENT_LUA = readFileSync(here('../../lua/client.lua'), 'utf8');
export const SERVER_LUA = readFileSync(here('../../lua/server.lua'), 'utf8');

const factory = new LuaFactory();

export type LogEntry =
  | { kind: 'clientEvent'; name: string; target: number; args: unknown[] }
  | { kind: 'serverEvent'; name: string; args: unknown[] }
  | { kind: 'nui'; message: Record<string, unknown> }
  | { kind: 'nuiResponse'; body: unknown }
  | { kind: 'focus'; focus: boolean; cursor: boolean }
  | { kind: 'keepInput'; keep: boolean }
  | { kind: 'addApp'; resource: string; app: Record<string, unknown> }
  | { kind: 'removeApp'; resource: string; identifier: string }
  | { kind: 'appMessage'; resource: string; identifier: string; args: unknown[] }
  | { kind: 'createDui'; dui: number; url: string; width: number; height: number }
  | { kind: 'destroyDui'; dui: number }
  | { kind: 'duiMessage'; dui: number; message: Record<string, unknown> }
  | { kind: 'duiMouse'; dui: number; event: 'move' | 'down' | 'up' | 'wheel'; args: unknown[] }
  | { kind: 'runtimeTexture'; txd: string; name: string; handle: string }
  | { kind: 'replaceTexture'; txd: string; texture: string; with: [string, string] }
  | { kind: 'restoreTexture'; txd: string; texture: string }
  | { kind: 'camera'; call: string; args: unknown[] }
  | { kind: 'object'; call: 'create' | 'delete'; entity: number; model?: string }
  | { kind: 'print'; text: string }
  | { kind: 'error'; text: string };

/** A Lua 5.4 state with the test JSON codec loaded, and optionally the FiveM stand-ins. */
export class Lua {
  private constructor(private readonly engine: LuaEngine) {}

  static async create(options: { fivem?: boolean } = {}): Promise<Lua> {
    const engine = await factory.createEngine();
    await engine.doString(`json = (function()\n${JSON_LUA}\nend)()`);
    if (options.fivem) await engine.doString(FIVEM_LUA);
    return new Lua(engine);
  }

  /** Runs a chunk. A Lua error rejects with its message. */
  async run(code: string): Promise<unknown> {
    try {
      return await this.engine.doString(code);
    } finally {
      // wasmoon leaves every returned value on the main stack, which overflows after a few
      // dozen calls. Nothing else lives there between chunks.
      this.engine.global.setTop(0);
    }
  }

  /** Runs a chunk that receives `value` (through JSON, as the game would deliver it) as `...`. */
  async call(code: string, value: unknown): Promise<unknown> {
    this.engine.global.set('__input', JSON.stringify(value) ?? 'null');
    return this.run(`return (function(...)\n${code}\nend)(json.decode(__input))`);
  }

  async trigger(event: string, source: number | string, ...args: unknown[]): Promise<void> {
    this.engine.global.set('__input', JSON.stringify(args));
    await this.run(`Sim.trigger(${JSON.stringify(event)}, ${JSON.stringify(source)}, __input, ${args.length})`);
  }

  /** Posts to a NUI callback, as the page does with fetch. */
  async post(body: unknown, callback = 'nexus'): Promise<void> {
    this.engine.global.set('__input', JSON.stringify(body));
    await this.run(`Sim.post(${JSON.stringify(callback)}, __input)`);
  }

  async tick(ms = 16, frames = 1): Promise<void> {
    await this.run(`for _ = 1, ${frames} do Sim.tick(${ms}) end`);
  }

  async convar(name: string, value: number): Promise<void> {
    await this.run(`Sim.convars[${JSON.stringify(name)}] = ${value}`);
  }

  /** Everything recorded since the last call, in order. */
  async drain(): Promise<LogEntry[]> {
    return JSON.parse((await this.run('return Sim.drain()')) as string) as LogEntry[];
  }

  /** The threads that are alive. A timer that waits to fire once is not one. */
  async threads(): Promise<number> {
    return (await this.run('return Sim.threadCount()')) as number;
  }

  /** How often each control was disabled since the last call. */
  async disabledControls(): Promise<Record<string, number>> {
    const value = JSON.parse((await this.run('return Sim.takeDisabled()')) as string) as unknown;
    return Array.isArray(value) ? {} : (value as Record<string, number>);
  }

  close(): void {
    this.engine.global.close();
  }
}
