/**
 * A problem the person at the terminal can fix. `message` says what is wrong and `hint` says
 * what to do next. Anything else that is thrown is a bug and is printed with its stack.
 */
export class CliError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}
