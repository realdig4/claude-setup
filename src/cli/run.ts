/** Runs one CLI invocation and returns its exit code (never throws). */
import { CommanderError } from 'commander'
import { CliContext, type CliDeps } from './context'
import { CliError, EXIT, PromptCancelled } from './errors'
import { buildProgram } from './program'

/** Parse `argv`, run the command and map every outcome to an exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const ctx = new CliContext(deps)
  const program = buildProgram(ctx)
  try {
    if (!argv.length) {
      program.outputHelp()
      return EXIT.ok
    }
    await program.parseAsync(argv, { from: 'user' })
    return ctx.exitCode
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0 || err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return EXIT.ok
      // A command group without a sub-command (e.g. `claude-setup models`) just shows its help.
      if (err.code === 'commander.help') return EXIT.ok
      // Parser errors thrown inside a command (e.g. a bad --target value) were not printed yet.
      if (!ctx.usageErrorShown) ctx.out.error(err.message.replace(/^error: /, ''))
      return EXIT.usage
    }
    if (err instanceof PromptCancelled) {
      ctx.out.error('Cancelled — nothing was changed.')
      return EXIT.cancelled
    }
    if (err instanceof CliError) {
      ctx.out.error(err.message)
      if (err.hint) for (const line of err.hint.split('\n')) deps.io.stderr.write(`  ${ctx.out.c.dim(line)}\n`)
      return err.exitCode
    }
    const message = err instanceof Error ? err.message : String(err)
    ctx.out.error(`Something went wrong: ${message}`)
    if (ctx.out.verbose && err instanceof Error && err.stack) deps.io.stderr.write(ctx.out.c.dim(err.stack) + '\n')
    else deps.io.stderr.write(`  ${ctx.out.c.dim('Run again with --verbose for details.')}\n`)
    return EXIT.failed
  } finally {
    await ctx.dispose()
  }
}
