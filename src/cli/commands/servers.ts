/** `search`, `info`, `list`, `uninstall`, `test`, `enable`, `disable`. */
import type { Command } from 'commander'
import type { Core } from '@core/index'
import type { CatalogSource, InstalledServer, Scope, TargetId } from '@shared/types'
import { hasRemote, needsKey, requiredValueNames } from '../../mcp/format'
import { buildTargetRefs, collect, parsePositiveInt, parseScope, parseTargetList } from '../args'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { describeConfigForHumans, describeRef, printChangeResults, printTestResult, targetLabel, truncate } from '../format'

const SOURCES: CatalogSource[] = ['official', 'anthropic', 'github', 'smithery', 'docker', 'cline', 'awesome', 'glama', 'pulsemcp', 'seed']

interface WhereOptions {
  target?: string[]
  scope?: Scope
  project?: string
}

/** Installed names that look like `name` (e.g. "deepwiki" → "deep-wiki"). */
export function similarNames(all: InstalledServer[], name: string): string[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = norm(name)
  if (!wanted) return []
  const names = [...new Set(all.map((s) => s.name))].filter((n) => n !== name)
  return names.filter((n) => norm(n) === wanted || norm(n).includes(wanted) || wanted.includes(norm(n))).slice(0, 3)
}

/** Installed entries called `name`, narrowed by --target/--scope/--project; throws a helpful error when none match. */
export async function findInstalled(ctx: CliContext, core: Core, name: string, where: WhereOptions, required = true): Promise<InstalledServer[]> {
  const ids: TargetId[] | undefined = where.target?.length ? parseTargetList(where.target) : undefined
  const projectPath = where.project ?? (where.scope === 'project' || where.scope === 'local' ? ctx.deps.cwd() : undefined)
  const all = await core.servers.list(projectPath ? { projectPath } : undefined)
  // Apps without scopes (Claude Desktop, Windsurf) report no scope: --scope only narrows apps that have one.
  const scopeMatches = (s: InstalledServer) => !where.scope || !s.target.scope || s.target.scope === where.scope
  const found = all.filter((s) => s.name === name && (!ids || ids.includes(s.target.target)) && scopeMatches(s))
  if (found.length || !required) return found
  const similar = similarNames(all, name)
  const elsewhere = ids && all.some((s) => s.name === name)
  throw new CliError(
    `"${name}" is not installed${elsewhere ? ' in the chosen apps' : ''}.`,
    EXIT.failed,
    similar.length ? `Did you mean: ${similar.join(', ')}?` : 'See installed servers: claude-setup list'
  )
}

function addWhereOptions(cmd: Command): Command {
  return cmd
    .option('-t, --target <apps>', 'Apps: desktop, code, vscode, cursor, windsurf (comma-separated)', collect, [])
    .option('-s, --scope <scope>', 'Claude Code / VS Code scope: user, project or local', parseScope)
    .option('-p, --project <path>', 'Project folder for project/local scope (default: current folder)')
}

/** Register `search`, `info`, `list`, `uninstall`, `test`, `enable` and `disable`. */
export function registerServerCommands(program: Command, ctx: CliContext): void {
  program
    .command('search')
    .description('Search the MCP server catalog')
    .argument('[query...]', 'What the server should do or connect to, e.g. github or "web search"')
    .option('-c, --category <id>', 'Only servers in this category')
    .option('--remote', 'Only servers that run in the cloud (nothing to install locally)')
    .option('--no-key', 'Only servers that need no API key')
    .option('--source <registry>', `Only one registry: ${SOURCES.join(', ')}`)
    .option('--sort <order>', 'relevance, popular, name or updated')
    .option('-n, --limit <n>', 'How many results to show', parsePositiveInt, 20)
    .action(async (words: string[], opts: { category?: string; remote?: boolean; key: boolean; source?: string; sort?: string; limit: number }) => {
      if (opts.source && !SOURCES.includes(opts.source as CatalogSource)) throw new CliError(`Unknown registry "${opts.source}".`, EXIT.usage, `Use one of: ${SOURCES.join(', ')}`)
      if (opts.sort && !['relevance', 'popular', 'name', 'updated'].includes(opts.sort)) throw new CliError(`Unknown sort order "${opts.sort}".`, EXIT.usage)
      const query = words.join(' ').trim() || undefined
      const core = await ctx.core()
      const page = await ctx.out.withSpinner('Searching the catalog…', () =>
        core.catalog.search({
          query,
          category: opts.category,
          remoteOnly: opts.remote || undefined,
          noKeyRequired: opts.key === false || undefined,
          source: opts.source as CatalogSource | undefined,
          sort: opts.sort as 'relevance' | 'popular' | 'name' | 'updated' | undefined,
          limit: Math.min(opts.limit, 100)
        })
      )
      if (ctx.json) return ctx.out.printJson(page)
      const { out } = ctx
      if (!page.items.length) {
        out.line(`No MCP servers found${query ? ` for "${query}"` : ''}.`)
        out.hint('Try a shorter or different word, or refresh the catalog: claude-setup refresh')
        return
      }
      out.line(out.c.bold(`Found ${page.total} server${page.total === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}`) + out.c.dim(page.total > page.items.length ? ` (showing ${page.items.length})` : ''))
      out.line()
      const width = String(page.items.length).length
      page.items.forEach((s, i) => {
        const badges = [s.official ? out.c.green('official') : '', s.verified ? out.c.green('verified') : '', hasRemote(s) ? out.c.cyan('remote') : '', needsKey(s) ? out.c.yellow('needs key') : '']
          .filter(Boolean)
          .join(out.c.dim(' · '))
        out.line(`${out.c.dim(String(i + 1).padStart(width) + '.')} ${out.c.bold(s.name)}  ${badges}`)
        out.line(`${' '.repeat(width + 2)}${out.c.dim(s.id)}`)
        out.line(`${' '.repeat(width + 2)}${truncate(s.description, Math.max(40, out.width - width - 4))}`)
      })
      out.line()
      out.hint(`Details: claude-setup info <id>    Install: claude-setup install <id>`)
    })

  program
    .command('info')
    .description('Show details and install options for a catalog server')
    .argument('<id>', 'Catalog id (from search) or server name')
    .action(async (id: string) => {
      const core = await ctx.core()
      const server = (await core.catalog.get(id)) ?? (await core.catalog.search({ query: id, limit: 5 })).items.find((s) => s.slug === id || s.name.toLowerCase() === id.toLowerCase()) ?? null
      if (!server) throw new CliError(`No catalog server called "${id}".`, EXIT.failed, `Search for it: claude-setup search ${id}`)
      if (ctx.json) return ctx.out.printJson(server)
      const { out } = ctx
      out.line(`${out.c.bold(server.name)}  ${out.c.dim(server.id)}`)
      out.line(truncate(server.longDescription || server.description, 1200))
      out.line()
      out.pairs([
        ['Publisher', server.publisher],
        ['Repository', server.repository],
        ['Website', server.homepage],
        ['Categories', server.categories.join(', ')],
        ['Default name', server.slug],
        ['Version', server.version],
        ['Stars', server.stars !== undefined ? String(server.stars) : undefined],
        ['Sources', server.sources.join(', ')]
      ])
      out.line()
      out.line(out.c.bold('Install options'))
      if (!server.install.length) out.line(`  ${out.c.dim('None — see the repository for manual setup.')}`)
      for (const o of server.install) {
        out.line(`  ${out.sym.bullet} ${out.c.bold(o.id)}  ${o.label} ${out.c.dim(`(${o.transport}${o.runtime !== 'none' ? `, needs ${o.runtime}` : ''})`)}`)
        if (o.package || o.url) out.line(`    ${out.c.dim(o.url ?? o.package ?? '')}`)
        for (const v of [...o.env, ...(o.headers ?? [])]) {
          const tags = [v.required ? out.c.yellow('required') : 'optional', v.secret ? 'secret' : ''].filter(Boolean).join(', ')
          out.line(`    ${v.name} ${out.c.dim(`(${tags})`)}${v.description ? ` ${out.sym.dash} ${truncate(v.description, 100)}` : ''}`)
        }
        for (const a of o.argsSpec ?? []) {
          out.line(`    --arg ${a.name}=… ${out.c.dim(`(${a.required ? 'required' : 'optional'}${a.repeatable ? ', repeatable' : ''})`)}${a.description ? ` ${out.sym.dash} ${truncate(a.description, 100)}` : ''}`)
        }
        if (o.notes) out.line(`    ${out.c.dim(truncate(o.notes, 300))}`)
      }
      out.line()
      const first = server.install[0]
      const example = first ? requiredValueNames(first).map((n) => ` --env ${n}=…`).join('') : ''
      out.hint(`Install: claude-setup install ${server.id}${example}`)
    })

  addWhereOptions(program.command('list').alias('ls').description('List installed MCP servers')).action(async (opts: WhereOptions) => {
    const core = await ctx.core()
    const ids = opts.target?.length ? parseTargetList(opts.target) : undefined
    const projectPath = opts.project ?? (opts.scope === 'project' || opts.scope === 'local' ? ctx.deps.cwd() : undefined)
    const all = await ctx.out.withSpinner('Reading app configs…', () => core.servers.list({ scope: opts.scope, projectPath, target: ids?.length === 1 ? ids[0] : undefined }))
    const servers = all.filter((s) => !ids || ids.includes(s.target.target))
    if (ctx.json) return ctx.out.printJson(servers)
    const { out } = ctx
    if (!servers.length) {
      out.line(`No MCP servers installed${ids ? ` in ${ids.map(targetLabel).join(', ')}` : ''}.`)
      out.hint('Find one with: claude-setup search <topic>')
      return
    }
    out.table(
      ['NAME', 'APP', 'STATUS', 'STARTS WITH'],
      servers.map((s) => [s.name, describeRef(s.target), s.enabled ? out.c.green('on') : out.c.yellow('off'), describeConfigForHumans(s.config)])
    )
  })

  addWhereOptions(program.command('uninstall').alias('remove').description('Remove an MCP server from apps (a backup is made first)'))
    .argument('<name>', 'Installed server name')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (name: string, opts: WhereOptions & { yes?: boolean }) => {
      const core = await ctx.core()
      const found = await findInstalled(ctx, core, name, opts)
      const refs = found.map((s) => s.target)
      if (!ctx.json) ctx.out.line(`"${name}" will be removed from: ${refs.map(describeRef).join(', ')}`)
      if (!(await ctx.confirmOrYes('Remove it?', opts.yes))) return ctx.out.line('Nothing was changed.')
      const results = await ctx.out.withSpinner('Removing…', () => core.servers.uninstall(name, refs))
      if (results.some((r) => !r.ok)) ctx.fail()
      if (ctx.json) return ctx.out.printJson(results)
      printChangeResults(ctx, results)
      if (results.some((r) => r.ok && r.needsRestart)) ctx.out.hint('Restart Claude Desktop to apply it: claude-setup restart')
    })

  addWhereOptions(program.command('test').description('Start an installed MCP server and check that it works'))
    .argument('<name>', 'Installed server name')
    .action(async (name: string, opts: WhereOptions) => {
      const core = await ctx.core()
      const found = await findInstalled(ctx, core, name, opts)
      const entry = found[0]
      if (found.length > 1 && !opts.target?.length && !ctx.json) {
        ctx.out.warn(`"${name}" is installed in several apps; testing the one in ${describeRef(entry.target)} (choose with --target).`)
      }
      const t = await ctx.out.withSpinner(`Starting ${name}…`, () => core.servers.testInstalled(entry.name, entry.target))
      if (!t.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(t)
      printTestResult(ctx, t, `"${name}" (${describeRef(entry.target)})`)
    })

  for (const enable of [true, false]) {
    addWhereOptions(program.command(enable ? 'enable' : 'disable').description(enable ? 'Turn an installed MCP server back on' : 'Turn an MCP server off without removing it'))
      .argument('<name>', 'Installed server name')
      .action(async (name: string, opts: WhereOptions) => {
        const core = await ctx.core()
        let found = await findInstalled(ctx, core, name, opts, !opts.target?.length)
        if (!found.length && opts.target?.length) {
          const projectPath = opts.project ?? (opts.scope && opts.scope !== 'user' ? ctx.deps.cwd() : undefined)
          found = buildTargetRefs(parseTargetList(opts.target), opts.scope, projectPath, ctx.deps.cwd()).map((target) => ({ name, target }) as InstalledServer)
        }
        if (!found.length) throw new CliError(`"${name}" is not installed.`, EXIT.failed, 'See installed servers: claude-setup list')
        const results = []
        for (const entry of found) results.push(await core.servers.setEnabled(name, entry.target, enable))
        if (results.some((r) => !r.ok)) ctx.fail()
        if (ctx.json) return ctx.out.printJson(results)
        printChangeResults(ctx, results)
        if (results.some((r) => r.ok && r.needsRestart)) ctx.out.hint('Restart Claude Desktop to apply it: claude-setup restart')
      })
  }
}
