const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: number, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const color = {
  bold: (text: string) => paint(1, text),
  dim: (text: string) => paint(2, text),
  red: (text: string) => paint(31, text),
  green: (text: string) => paint(32, text),
  yellow: (text: string) => paint(33, text),
  cyan: (text: string) => paint(36, text),
};

export const log = {
  info(message: string): void {
    process.stdout.write(`${message}\n`);
  },
  step(message: string): void {
    process.stdout.write(`${color.green('ok')} ${message}\n`);
  },
  error(message: string, hint?: string): void {
    process.stderr.write(`${color.red('error')} ${message}\n`);
    if (hint) process.stderr.write(`\n${hint}\n`);
  },
};
