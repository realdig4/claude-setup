/** `ext search|install|list|remove`: plugins, skills, agents, commands, hooks for Claude Code. */
import type { Command } from 'commander'
import type { ExtensionKind, ExtensionSource, Scope } from '@shared/types'
import { parseExtensionKind, parsePositiveInt, parseScope } from '../args'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { printOpResult, truncate } from '../format'

const SOURCES: ExtensionSource[] = ['claude-cli', 'marketplace', 'skills.sh', 'aitmpl', 'anthropic-skills', 'local']

interface ScopeOptions {
  scope?: Scope
  project?: string
}

function scopeArgs(ctx: CliContext, opts: ScopeOptions): { scope?: Scope; projectPath?: string } {
  const needsProject = opts.scope === 'project' || opts.scope === 'local'
  return { scope: opts.scope, ...(needsProject ? { projectPath: opts.project ?? ctx.deps.cwd() } : {}) }
}

/** Register `ext search|install|list|remove`. */
export function registerExtensionCommands(program: Command, ctx: CliContext): void {
  const ext = program.command('ext').alias('extensions').description('Plugins, skills, agents, slash commands, hooks and status lines for Claude Code')

  ext
    .command('search')
    .description('Search extensions')
    .argument('[query...]', 'What to look for')
    .option('-k, --kind <kind>', 'plugin, skill, agent, command, hook, statusline or output-style', parseExtensionKind)
    .option('--source <source>', `Only one source: ${SOURCES.join(', ')}`)
    .option('-n, --limit <n>', 'How many results', parsePositiveInt, 20)
    .action(async (words: string[], opts: { kind?: ExtensionKind; source?: string; limit: number }) => {
      if (opts.source && !SOURCES.includes(opts.source as ExtensionSource)) throw new CliError(`Unknown source "${opts.source}".`, EXIT.usage, `Use one of: ${SOURCES.join(', ')}`)
      const core = await ctx.core()
      const query = words.join(' ').trim() || undefined
      const items = (
        await ctx.out.withSpinner('Searching…', () => core.extensions.search({ query, kind: opts.kind, source: opts.source as ExtensionSource | undefined, limit: opts.limit }))
      ).slice(0, opts.limit)
      if (ctx.json) return ctx.out.printJson(items)
      const { out } = ctx
      if (!items.length) return out.line(`No extensions found${query ? ` for "${query}"` : ''}.`)
      out.table(
        ['ID', 'KIND', 'DESCRIPTION'],
        items.map((e) => [e.installed ? `${e.id} ${out.c.green(out.sym.ok)}` : e.id, e.kind, truncate(e.description, 300) + (e.warnings?.length ? out.c.yellow(` ${out.sym.warn} ${e.warnings.join('; ')}`) : '')]),
        { flex: 2 }
      )
      out.hint('Install: claude-setup ext install <id>')
    })

  ext
    .command('install')
    .description('Install an extension by id')
    .argument('<id>', 'Extension id from "ext search"')
    .option('-s, --scope <scope>', 'user (default), project or local', parseScope)
    .option('-p, --project <path>', 'Project folder for project/local scope (default: current folder)')
    .action(async (id: string, opts: ScopeOptions) => {
      const core = await ctx.core()
      const r = await ctx.out.withSpinner(`Installing ${id}…`, () => core.extensions.install(id, scopeArgs(ctx, opts)))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printOpResult(ctx, r)
    })

  ext
    .command('list')
    .alias('ls')
    .description('List installed extensions')
    .option('-k, --kind <kind>', 'Only this kind', parseExtensionKind)
    .action(async (opts: { kind?: ExtensionKind }) => {
      const core = await ctx.core()
      const items = await ctx.out.withSpinner('Reading extensions…', () => core.extensions.installed(opts.kind))
      if (ctx.json) return ctx.out.printJson(items)
      const { out } = ctx
      if (!items.length) {
        out.line(`No ${opts.kind ? `${opts.kind}s` : 'extensions'} installed.`)
        out.hint('Find some: claude-setup ext search <topic>')
        return
      }
      out.table(
        ['ID', 'KIND', 'SCOPE', 'STATUS'],
        items.map((e) => [e.id, e.kind, e.scope ?? 'user', e.enabled === false ? out.c.yellow('off') : out.c.green('on')]),
        { flex: 0 }
      )
    })

  ext
    .command('remove')
    .alias('uninstall')
    .description('Remove an installed extension')
    .argument('<id>', 'Extension id from "ext list"')
    .option('-s, --scope <scope>', 'user (default), project or local', parseScope)
    .option('-p, --project <path>', 'Project folder for project/local scope (default: current folder)')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (id: string, opts: ScopeOptions & { yes?: boolean }) => {
      if (!(await ctx.confirmOrYes(`Remove ${id}?`, opts.yes))) return ctx.out.line('Nothing was changed.')
      const core = await ctx.core()
      const r = await ctx.out.withSpinner(`Removing ${id}…`, () => core.extensions.uninstall(id, scopeArgs(ctx, opts)))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printOpResult(ctx, r)
    })
}
