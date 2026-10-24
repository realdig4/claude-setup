/** `mcp status|register|unregister`: Claude Setup's own MCP server in Claude apps. */
import type { Command } from 'commander'
import type { TargetRef } from '@shared/types'
import { buildTargetRefs, collect, parseScope, parseTargetList } from '../args'
import type { CliContext } from '../context'
import { printChangeResults, targetLabel } from '../format'

/** Register `mcp status|register|unregister`. */
export function registerMcpCommands(program: Command, ctx: CliContext): void {
  const mcp = program.command('mcp').description('Let Claude manage your setup by adding Claude Setup as an MCP server')

  mcp
    .command('status')
    .description('Show where Claude Setup is registered as an MCP server')
    .action(async () => {
      const core = await ctx.core()
      const [status, targets] = await Promise.all([core.self.mcpStatus(), core.targets.list().catch(() => [])])
      if (ctx.json) return ctx.out.printJson(status)
      const { out } = ctx
      out.table(
        ['APP', 'REGISTERED', 'CONFIG FILE'],
        status.map((s) => {
          const installed = targets.find((t) => t.id === s.target)?.installed
          return [targetLabel(s.target), s.registered ? out.c.green('yes') : installed === false ? out.c.dim('app not found') : 'no', s.configPath ?? out.c.dim('—')]
        }),
        { flex: 2 }
      )
      if (!status.some((s) => s.registered)) out.hint('Add it with: claude-setup mcp register')
    })

  mcp
    .command('register')
    .description('Add Claude Setup to Claude Desktop / Claude Code (default: the installed ones)')
    .option('-t, --target <apps>', 'Apps: desktop, code, vscode, cursor, windsurf', collect, [])
    .option('-s, --scope <scope>', 'Claude Code scope (default: user = all projects)', parseScope)
    .action(async (opts: { target: string[]; scope?: 'user' | 'project' | 'local' }) => {
      const core = await ctx.core()
      let refs: TargetRef[]
      if (opts.target.length) refs = buildTargetRefs(parseTargetList(opts.target), opts.scope ?? 'user', undefined, ctx.deps.cwd())
      else {
        const installed = (await core.targets.list()).filter((t) => t.installed && (t.id === 'claude-desktop' || t.id === 'claude-code'))
        refs = installed.map((t) => (t.id === 'claude-code' ? { target: t.id, scope: opts.scope ?? 'user' } : { target: t.id }))
        if (!refs.length) refs = [{ target: 'claude-code', scope: opts.scope ?? 'user' }]
      }
      const r = await ctx.out.withSpinner('Registering…', () => core.self.registerMcp(refs))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printChangeResults(ctx, r.results)
      for (const w of r.warnings) if (!r.results.some((x) => x.message === w)) ctx.out.warn(w)
      if (r.results.some((x) => x.ok && x.needsRestart)) ctx.out.hint('Restart Claude Desktop to load it: claude-setup restart')
      else if (r.ok) ctx.out.hint('Start a new Claude Code session, then ask Claude to find or install MCP servers.')
    })

  mcp
    .command('unregister')
    .description('Remove Claude Setup from apps (default: everywhere it is registered)')
    .option('-t, --target <apps>', 'Apps: desktop, code, vscode, cursor, windsurf', collect, [])
    .action(async (opts: { target: string[] }) => {
      const core = await ctx.core()
      const refs: TargetRef[] = opts.target.length ? parseTargetList(opts.target).map((target) => ({ target })) : []
      const results = await ctx.out.withSpinner('Removing…', () => core.self.unregisterMcp(refs))
      if (results.some((r) => !r.ok)) ctx.fail()
      if (ctx.json) return ctx.out.printJson(results)
      if (!results.length) return ctx.out.line('Claude Setup is not registered anywhere.')
      printChangeResults(ctx, results)
    })
}
