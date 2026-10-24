/** Per-invocation CLI state: output, prompts, the lazily created core and the exit code. */
import type { Core } from '@core/index'
import type { SecretStore } from '@core/secrets'
import { CliError, EXIT } from './errors'
import { Output, type CliIo } from './output'
import { Prompter } from './prompt'

/** Everything the CLI needs from its environment (injected for tests). */
export interface CliDeps {
  io: CliIo
  version: string
  /** Create the shared core (only called by commands that need it). */
  createCore: () => Promise<Core>
  /** Secret store without starting the whole core (fast path for `secret get`). */
  secrets: () => SecretStore
  cwd: () => string
}

/** State shared by all commands of one invocation. */
export class CliContext {
  readonly out: Output
  readonly prompt: Prompter
  exitCode: number = EXIT.ok
  /** Commander already printed a usage error. */
  usageErrorShown = false
  private corePromise: Promise<Core> | null = null

  constructor(readonly deps: CliDeps) {
    this.out = new Output(deps.io)
    this.prompt = new Prompter(deps.io, this.out)
  }

  get io(): CliIo {
    return this.deps.io
  }

  get json(): boolean {
    return this.out.json
  }

  /** The core, created once on first use. */
  core(): Promise<Core> {
    if (!this.corePromise) {
      this.corePromise = this.deps.createCore().then(
        (core) => {
          // Results already carry friendly messages; raw log lines are only shown with --verbose.
          core.ctx.events.on('log', (e) => {
            if (this.out.verbose && e.level !== 'debug') this.io.stderr.write(this.out.c.dim(`[${e.level}] ${e.scope}: ${e.message}`) + '\n')
          })
          return core
        },
        (err: unknown) => {
          this.corePromise = null
          throw new CliError(`Claude Setup could not start: ${err instanceof Error ? err.message : String(err)}`)
        }
      )
    }
    return this.corePromise
  }

  /** Record a failure exit code (the highest code wins). */
  fail(code: number = EXIT.failed): void {
    this.exitCode = Math.max(this.exitCode, code)
  }

  /** Ask for confirmation unless --yes was given; refuse silently-dangerous non-interactive runs. */
  async confirmOrYes(question: string, yes: boolean | undefined, defaultYes = true): Promise<boolean> {
    if (yes) return true
    if (!this.prompt.interactive) {
      throw new CliError('This change needs confirmation.', EXIT.usage, 'Run it in a terminal, or add --yes to confirm.')
    }
    return this.prompt.confirm(question, defaultYes)
  }

  /** Stop background work held by the core (proxy, timers). */
  async dispose(): Promise<void> {
    if (!this.corePromise) return
    const core = await this.corePromise.catch(() => null)
    await core?.dispose().catch(() => {})
  }
}
