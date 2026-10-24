/** Errors with exit codes for the CLI. */

/** Exit codes: 0 ok, 1 operation failed, 2 usage/input problem, 130 cancelled (Ctrl+C). */
export const EXIT = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const

/** An expected problem: printed as a friendly message (plus optional hint), never with a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/** The user pressed Ctrl+C / Ctrl+D at a prompt. */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'PromptCancelled'
  }
}
