/** `backups list` and `backups restore <id>`. */
import type { Command } from 'commander'
import { parsePositiveInt } from '../args'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { printOpResult } from '../format'

/** Register `backups list|restore`. */
export function registerBackupCommands(program: Command, ctx: CliContext): void {
  const backups = program.command('backups').alias('backup').description('Backups of config files made before every change')

  backups
    .command('list')
    .alias('ls')
    .description('List backups (newest first)')
    .option('-n, --limit <n>', 'How many to show', parsePositiveInt, 30)
    .action(async (opts: { limit: number }) => {
      const core = await ctx.core()
      const list = (await core.backups.list()).slice(0, opts.limit)
      if (ctx.json) return ctx.out.printJson(list)
      const { out } = ctx
      if (!list.length) return out.line('There are no backups yet.')
      out.table(
        ['ID', 'WHEN', 'WHY', 'FILES'],
        list.map((b) => [b.id, new Date(b.createdAt).toLocaleString(), b.reason, b.files.map((f) => f.path).join(', ')]),
        { flex: 3 }
      )
      out.hint('Undo a change: claude-setup backups restore <id>')
    })

  backups
    .command('restore')
    .description('Put back the files from a backup (current files are backed up first)')
    .argument('<id>', 'Backup id from "backups list"')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (id: string, opts: { yes?: boolean }) => {
      const core = await ctx.core()
      const entry = (await core.backups.list()).find((b) => b.id === id)
      if (!entry) throw new CliError(`No backup with id "${id}".`, EXIT.failed, 'See the list: claude-setup backups list')
      if (!ctx.json) {
        ctx.out.line(`Backup ${ctx.out.c.bold(entry.id)} ${ctx.out.c.dim(`(${entry.reason})`)} contains:`)
        for (const f of entry.files) ctx.out.line(`  ${ctx.out.sym.bullet} ${f.path}${f.existed ? '' : ctx.out.c.dim(' (did not exist — will be removed)')}`)
      }
      if (!(await ctx.confirmOrYes('Restore these files?', opts.yes))) return ctx.out.line('Nothing was changed.')
      const r = await ctx.out.withSpinner('Restoring…', () => core.backups.restore(id))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printOpResult(ctx, r)
    })
}
