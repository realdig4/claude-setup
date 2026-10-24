/** `targets` (which apps are installed) and `restart` (restart Claude Desktop). */
import type { Command } from 'commander'
import type { CliContext } from '../context'
import { printOpResult } from '../format'

/** Register `targets` and `restart`. */
export function registerTargetCommands(program: Command, ctx: CliContext): void {
  program
    .command('targets')
    .alias('apps')
    .description('Show which apps (Claude Desktop, Claude Code, VS Code, Cursor, Windsurf) are installed')
    .action(async () => {
      const core = await ctx.core()
      const targets = await ctx.out.withSpinner('Looking for apps…', () => core.targets.list())
      if (ctx.json) return ctx.out.printJson(targets)
      const { out } = ctx
      out.table(
        ['APP', 'STATUS', 'SERVERS', 'CONFIG FILE'],
        targets.map((t) => [
          out.c.bold(t.label),
          t.installed ? out.c.green(`installed${t.version ? ` ${t.version}` : ''}`) + (t.running ? out.c.dim(' (running)') : '') : out.c.dim('not found'),
          String(t.serverCount),
          t.configPath ? (t.configValid ? t.configPath : out.c.red(`${t.configPath} (invalid: ${t.configError ?? 'cannot be read'})`)) : out.c.dim('—')
        ]),
        { flex: 3 }
      )
      const notes = targets.flatMap((t) => t.notes.map((n) => `${t.label}: ${n}`))
      if (notes.length) {
        out.line()
        for (const n of notes) out.line(`${out.c.dim(out.sym.info)} ${n}`)
      }
    })

  program
    .command('restart')
    .description('Quit and reopen Claude Desktop so it loads changed MCP servers')
    .action(async () => {
      const core = await ctx.core()
      const r = await ctx.out.withSpinner('Restarting Claude Desktop…', () => core.targets.restartDesktop())
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printOpResult(ctx, r)
    })
}
