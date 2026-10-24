/** `refresh`: re-download the MCP catalog from every enabled registry. */
import type { Command } from 'commander'
import type { CliContext } from '../context'

/** Register `refresh`. */
export function registerRefreshCommand(program: Command, ctx: CliContext): void {
  program
    .command('refresh')
    .description('Download the latest MCP server lists from the public registries')
    .option('--if-stale', 'Only refresh when the cached lists are older than the refresh interval')
    .action(async (opts: { ifStale?: boolean }) => {
      const core = await ctx.core()
      const stats = await ctx.out.withSpinner('Refreshing the catalog…', async (spinner) => {
        const off = core.ctx.events.on('catalog', (e) => {
          if (e.phase === 'source' && e.source) spinner.update(`Refreshing the catalog… ${e.source}${e.count !== undefined ? ` (${e.count})` : ''}`)
        })
        try {
          return await core.catalog.refresh({ force: !opts.ifStale })
        } finally {
          off()
        }
      })
      const failed = stats.sources.filter((s) => s.enabled && s.error)
      if (failed.length && failed.length === stats.sources.filter((s) => s.enabled).length) ctx.fail()
      if (ctx.json) return ctx.out.printJson(stats)
      const { out } = ctx
      out.success(`The catalog has ${stats.total} servers.`)
      out.table(
        ['SOURCE', 'SERVERS', 'STATUS'],
        stats.sources
          .filter((s) => s.enabled)
          .map((s) => [s.source, String(s.count), s.error ? out.c.red(s.error) : out.c.green('ok') + (s.lastFetched ? out.c.dim(` (${new Date(s.lastFetched).toLocaleString()})`) : '')]),
        { flex: 2 }
      )
    })
}
