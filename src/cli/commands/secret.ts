/**
 * `secret get <ref>` prints ONLY the secret (Claude Code's apiKeyHelper runs
 * `claude-setup secret get <ref>` and uses stdout as the key), `secret set <ref>` stores one
 * (from a pipe or a hidden prompt), `secret delete <ref>` removes it.
 * Uses the secret store directly — no full core start-up — so it stays fast.
 */
import type { Command } from 'commander'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { readAllStdin } from '../stdin'

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,199}$/

function checkRef(ref: string): string {
  if (!REF_RE.test(ref)) throw new CliError(`"${ref}" is not a valid secret name.`, EXIT.usage, 'Use letters, numbers and : . _ - @ / (for example profile:kimi).')
  return ref
}

/** Register `secret get|set|delete`. */
export function registerSecretCommands(program: Command, ctx: CliContext): void {
  const secret = program.command('secret').description('Read or store keys in the secure store (used by Claude Code’s apiKeyHelper)')

  secret
    .command('get')
    .description('Print a stored secret (and nothing else)')
    .argument('<ref>', 'Secret name, e.g. profile:kimi')
    .action(async (ref: string) => {
      const store = ctx.deps.secrets()
      const value = await store.get(checkRef(ref))
      if (value === null || value === undefined) throw new CliError(`No secret named "${ref}" is stored.`, EXIT.failed)
      ctx.out.raw(ctx.io.stdout.isTTY ? `${value}\n` : value)
    })

  secret
    .command('set')
    .description('Store a secret (pipe it in, or type it when asked — input is hidden)')
    .argument('<ref>', 'Secret name, e.g. profile:kimi')
    .action(async (ref: string) => {
      checkRef(ref)
      let value: string
      if (ctx.io.stdin.isTTY) value = await ctx.prompt.secret(`Value for ${ref}:`)
      else value = (await readAllStdin(ctx.io.stdin)).replace(/\r?\n$/, '')
      if (!value) throw new CliError('No value was given, so nothing was stored.', EXIT.usage)
      const store = ctx.deps.secrets()
      await store.set(ref, value)
      if (ctx.json) return ctx.out.printJson({ ok: true, ref, backend: store.backend() })
      ctx.out.success(`Stored "${ref}" in ${store.backend()}.`)
    })

  secret
    .command('delete')
    .alias('remove')
    .description('Remove a stored secret')
    .argument('<ref>', 'Secret name')
    .action(async (ref: string) => {
      const store = ctx.deps.secrets()
      const existed = await store.has(checkRef(ref))
      if (existed) await store.delete(ref)
      if (ctx.json) return ctx.out.printJson({ ok: true, ref, existed })
      if (existed) ctx.out.success(`Removed "${ref}".`)
      else ctx.out.info(`No secret named "${ref}" was stored.`)
    })
}
