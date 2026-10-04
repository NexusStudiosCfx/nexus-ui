import { CliError } from './errors';

export interface FlagSpec {
  /** A flag that takes a value, such as `--port 5173`. Otherwise it is a switch. */
  value?: boolean;
}

export interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * Splits `argv` into positional arguments and the flags a command declares. An unknown flag is
 * an error, not something to ignore: a typo in `--game` should not silently start a plain server.
 */
export function parseArgs(argv: readonly string[], command: string, spec: Record<string, FlagSpec>): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name = '', inline] = arg.slice(2).split('=', 2);
    const flag = spec[name];
    if (!flag) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new CliError(
        `nexus ${command} has no option --${name}.`,
        known.length > 0 ? `Its options are: ${known.join(', ')}.` : `nexus ${command} takes no options.`,
      );
    }
    if (!flag.value) {
      if (inline !== undefined) throw new CliError(`--${name} does not take a value.`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`--${name} needs a value.`, `For example: nexus ${command} --${name} <value>`);
    }
    flags[name] = value;
  }

  return { positional, flags };
}
