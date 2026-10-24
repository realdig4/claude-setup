/** `install <id>` (from the catalog) and `add <name>` (custom command or URL). */
import type { Command } from 'commander'
import type { Core } from '@core/index'
import type { CatalogServer, EnvVarSpec, InstallOption, InstallPreview, InstallRequest, InstallResult, ServerConfig, TargetRef } from '@shared/types'
import { SERVER_NAME_RE, splitCommandLine } from '../../mcp/helpers'
import { buildTargetRefs, collect, pairsToArgValues, pairsToRecord, parseScope, parseTargetList } from '../args'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { describeConfigForHumans, describeRef, printChangeResults, printTestResult, truncate } from '../format'

interface CommonInstallOptions {
  target: string[]
  scope?: 'user' | 'project' | 'local'
  project?: string
  env: string[]
  header: string[]
  test?: boolean
  overwrite?: boolean
  yes?: boolean
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('-t, --target <apps>', 'Apps: desktop, code, vscode, cursor, windsurf (comma-separated; default: your usual apps)', collect, [])
    .option('-s, --scope <scope>', 'Claude Code / VS Code scope: user (all projects), project or local', parseScope)
    .option('-p, --project <path>', 'Project folder for project/local scope (default: current folder)')
    .option('-e, --env <NAME=value>', 'Environment variable, e.g. an API key (repeatable)', collect, [])
    .option('-H, --header <Name=value>', 'HTTP header for remote servers (repeatable)', collect, [])
    .option('--test', 'Check that the server starts after installing')
    .option('--overwrite', 'Replace an existing server with the same name')
    .option('-y, --yes', 'Do not ask questions; fail if a required value is missing')
}

/** Find a catalog server by id, or by exact name/slug through search. */
export async function resolveCatalogServer(core: Core, idOrName: string): Promise<CatalogServer> {
  const direct = await core.catalog.get(idOrName)
  if (direct) return direct
  const page = await core.catalog.search({ query: idOrName, limit: 8 })
  const lower = idOrName.toLowerCase()
  const exact = page.items.filter((s) => s.slug.toLowerCase() === lower || s.name.toLowerCase() === lower || s.id.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  const suggestions = (exact.length ? exact : page.items).slice(0, 5)
  throw new CliError(
    `No catalog server matches "${idOrName}" exactly.`,
    EXIT.failed,
    suggestions.length ? `Did you mean:\n${suggestions.map((s) => `  claude-setup install ${s.id}   (${s.name})`).join('\n')}` : `Search first: claude-setup search ${idOrName}`
  )
}

interface FoundSpec {
  kind: 'env' | 'header' | 'arg'
  name: string
  description?: string
  secret: boolean
  repeatable: boolean
  placeholder?: string
  helpUrl?: string
}

/** Locate the spec of a missing value (preview names may carry an env:/header:/arg: prefix). */
export function findValueSpec(server: CatalogServer | undefined, option: InstallOption | undefined, raw: string): FoundSpec {
  const prefix = /^(env|headers?|args?):/i.exec(raw)?.[1]?.toLowerCase()
  const name = raw.replace(/^(env|headers?|args?):/i, '')
  const options = option ? [option] : (server?.install ?? [])
  const fromEnv = (v: EnvVarSpec, kind: 'env' | 'header'): FoundSpec => ({
    kind,
    name: v.name,
    description: v.description,
    secret: v.secret,
    repeatable: false,
    placeholder: v.placeholder,
    helpUrl: v.helpUrl
  })
  for (const o of options) {
    if (!prefix || prefix === 'env') {
      const e = o.env.find((v) => v.name === name)
      if (e) return fromEnv(e, 'env')
    }
    if (!prefix || prefix.startsWith('header')) {
      const h = o.headers?.find((v) => v.name === name)
      if (h) return fromEnv(h, 'header')
    }
    if (!prefix || prefix.startsWith('arg')) {
      const a = o.argsSpec?.find((v) => v.name === name)
      if (a) return { kind: 'arg', name: a.name, description: a.description, secret: false, repeatable: !!a.repeatable }
    }
  }
  const kind = prefix?.startsWith('header') ? 'header' : prefix?.startsWith('arg') ? 'arg' : 'env'
  return { kind, name, secret: /key|token|secret|password|pat$/i.test(name), repeatable: false }
}

function flagFor(spec: FoundSpec): string {
  return spec.kind === 'env' ? `--env ${spec.name}=…` : spec.kind === 'header' ? `--header ${spec.name}=…` : `--arg ${spec.name}=…`
}

/** Ask for every missing required value (or explain which flags to pass). Mutates `req.values`. */
async function fillMissingValues(ctx: CliContext, req: InstallRequest, preview: InstallPreview, server?: CatalogServer, option?: InstallOption, yes?: boolean): Promise<boolean> {
  if (!preview.missingValues.length) return false
  const specs = preview.missingValues.map((raw) => findValueSpec(server, option, raw))
  if (yes || !ctx.prompt.interactive) {
    throw new CliError(
      `Some required values are missing: ${specs.map((s) => s.name).join(', ')}.`,
      EXIT.usage,
      `Pass them like this: ${specs.map(flagFor).join(' ')}`
    )
  }
  const values = (req.values ??= {})
  ctx.out.line(ctx.out.c.bold(`"${req.name ?? server?.slug ?? 'This server'}" needs a few values:`))
  for (const spec of specs) {
    if (spec.description) ctx.out.line(`  ${ctx.out.c.dim(truncate(spec.description, 200))}`)
    if (spec.helpUrl) ctx.out.line(`  ${ctx.out.c.dim(`Get it here: ${spec.helpUrl}`)}`)
    if (spec.placeholder && !spec.secret) ctx.out.line(`  ${ctx.out.c.dim(`Example: ${spec.placeholder}`)}`)
    const label = `${spec.name}${spec.repeatable ? ' (separate several with commas)' : ''}:`
    const value = spec.secret
      ? await ctx.prompt.secret(label)
      : await ctx.prompt.text(label, { validate: (v) => (v ? undefined : 'A value is required.') })
    if (spec.kind === 'env') values.env = { ...values.env, [spec.name]: value }
    else if (spec.kind === 'header') values.headers = { ...values.headers, [spec.name]: value }
    else values.args = { ...values.args, [spec.name]: spec.repeatable ? value.split(',').map((v) => v.trim()).filter(Boolean) : value }
  }
  return true
}

function printPreview(ctx: CliContext, p: InstallPreview): void {
  const { out } = ctx
  out.line(`${out.c.bold(`"${p.name}"`)} will be added to:`)
  for (const t of p.targets) {
    const mark = t.supported ? out.c.green(out.sym.bullet) : out.c.red(out.sym.fail)
    out.line(`  ${mark} ${describeRef(t.target)}${t.configPath ? out.c.dim(` ${out.sym.arrow} ${t.configPath}`) : ''}${t.note ? out.c.yellow(` (${t.note})`) : ''}`)
  }
  out.line(`  ${out.c.dim('Starts with:')} ${describeConfigForHumans(p.config)}`)
  for (const r of p.missingRuntimes) {
    out.warn(`Needs ${r.label}, which was not found.${r.install?.command ? ` Install it with: ${r.install.command}` : r.install?.url ? ` Get it from ${r.install.url}` : ''}`)
  }
  for (const w of p.warnings) out.warn(w)
}

function printInstallResult(ctx: CliContext, r: InstallResult, alreadyShown: string[]): void {
  printChangeResults(ctx, r.results)
  if (r.test) printTestResult(ctx, r.test, `"${r.name}"`)
  for (const w of r.warnings) if (!alreadyShown.includes(w)) ctx.out.warn(w)
}

async function offerDesktopRestart(ctx: CliContext, core: Core, r: InstallResult, yes?: boolean): Promise<void> {
  const desktop = r.results.find((x) => x.ok && x.needsRestart && x.target.target === 'claude-desktop')
  if (!desktop || ctx.json) return
  if (!yes && ctx.prompt.interactive && (await ctx.prompt.confirm('Restart Claude Desktop now to load it?', true))) {
    const res = await ctx.out.withSpinner('Restarting Claude Desktop…', () => core.targets.restartDesktop())
    if (res.ok) ctx.out.success(res.message)
    else ctx.out.warn(res.message)
    return
  }
  ctx.out.hint('Restart Claude Desktop to load it: claude-setup restart')
}

/** Validate --target/--scope early (before any lookups) so typos fail fast. */
function explicitTargets(ctx: CliContext, opts: CommonInstallOptions): TargetRef[] | undefined {
  return opts.target.length ? buildTargetRefs(parseTargetList(opts.target), opts.scope, opts.project, ctx.deps.cwd()) : undefined
}

/** Shared tail of install/add: targets, missing values, preview, confirm, install, report. */
async function runInstall(
  ctx: CliContext,
  core: Core,
  req: Omit<InstallRequest, 'targets'>,
  opts: CommonInstallOptions,
  explicit: TargetRef[] | undefined,
  server?: CatalogServer,
  option?: InstallOption
): Promise<void> {
  let targets: TargetRef[]
  if (explicit) {
    targets = explicit
  } else {
    const defaults = (await core.app.getSettings()).defaultTargets
    if (!defaults.length) throw new CliError('Choose where to install it.', EXIT.usage, 'Add --target desktop,code (or vscode, cursor, windsurf).')
    targets = opts.scope ? buildTargetRefs([...new Set(defaults.map((d) => d.target))], opts.scope, opts.project, ctx.deps.cwd()) : defaults
  }
  const request: InstallRequest = { ...req, targets, overwrite: opts.overwrite, test: opts.test }
  let preview = await ctx.out.withSpinner('Preparing…', () => core.servers.preview(request))
  if (await fillMissingValues(ctx, request, preview, server, option, opts.yes)) {
    preview = await core.servers.preview(request)
    if (preview.missingValues.length) throw new CliError(`Still missing: ${preview.missingValues.join(', ')}.`, EXIT.usage)
  }
  if (!preview.targets.some((t) => t.supported)) {
    if (!ctx.json) printPreview(ctx, preview)
    throw new CliError('None of the chosen apps can use this server.', EXIT.failed, 'Pick other apps with --target, or another install option with --option.')
  }
  if (!ctx.json) printPreview(ctx, preview)
  if (!(await ctx.confirmOrYes('Install now?', opts.yes))) return ctx.out.line('Nothing was changed.')
  const result = await ctx.out.withSpinner(opts.test ? 'Installing and testing…' : 'Installing…', () => core.servers.install(request))
  if (!result.ok) ctx.fail()
  if (ctx.json) return ctx.out.printJson(result)
  printInstallResult(ctx, result, preview.warnings)
  await offerDesktopRestart(ctx, core, result, opts.yes)
}

/** Register `install` and `add`. */
export function registerInstallCommands(program: Command, ctx: CliContext): void {
  addCommonOptions(
    program
      .command('install')
      .description('Install an MCP server from the catalog into Claude Desktop, Claude Code and more')
      .argument('<id>', 'Catalog id from "claude-setup search" (or the server name)')
      .option('-n, --name <name>', 'Name in the app config (default: the catalog name)')
      .option('-o, --option <id>', 'Install option id (see "claude-setup info <id>")')
      .option('-a, --arg <NAME=value>', 'Value for a server argument (repeat for lists)', collect, [])
  ).action(async (id: string, opts: CommonInstallOptions & { name?: string; option?: string; arg: string[] }) => {
    if (opts.name && !SERVER_NAME_RE.test(opts.name)) throw new CliError(`"${opts.name}" is not a valid name.`, EXIT.usage, 'Use 1-64 letters, numbers, "-" or "_".')
    const values = { env: pairsToRecord(opts.env, 'env'), headers: pairsToRecord(opts.header, 'header'), args: pairsToArgValues(opts.arg) }
    const explicit = explicitTargets(ctx, opts)
    const core = await ctx.core()
    const server = await ctx.out.withSpinner('Looking up the server…', () => resolveCatalogServer(core, id))
    if (!server.install.length) {
      throw new CliError(`${server.name} has no automatic install option.`, EXIT.failed, server.repository ? `See ${server.repository} for manual setup.` : undefined)
    }
    let option: InstallOption | undefined
    if (opts.option) {
      option = server.install.find((o) => o.id === opts.option) ?? server.install.find((o) => o.kind === opts.option)
      if (!option) throw new CliError(`${server.name} has no install option "${opts.option}".`, EXIT.usage, `Available: ${server.install.map((o) => o.id).join(', ')}`)
    } else if (server.install.length === 1) {
      option = server.install[0]
    } else if (!opts.yes && ctx.prompt.interactive && !ctx.json) {
      option = await ctx.prompt.select(
        `How should ${server.name} run?`,
        server.install.map((o) => ({ label: o.label, value: o, hint: `${o.transport}${o.runtime !== 'none' ? `, needs ${o.runtime}` : ''}` }))
      )
    }
    await runInstall(ctx, core, { catalogId: server.id, optionId: option?.id, values, name: opts.name }, opts, explicit, server, option)
  })

  addCommonOptions(
    program
      .command('add')
      .description('Add a custom MCP server: a local command (after --) or a remote --url')
      .argument('<name>', 'Name for the server (letters, numbers, - or _)')
      .argument('[command...]', 'Command that starts the server, e.g. -- npx -y some-mcp-server')
      .option('-u, --url <url>', 'Remote server URL (https://…)')
      .option('--transport <type>', 'Remote transport: http (default) or sse')
      .addHelpText('after', '\nExamples:\n  claude-setup add files -- npx -y @modelcontextprotocol/server-filesystem ~/Documents\n  claude-setup add docs --url https://example.com/mcp --target code')
  ).action(async (name: string, command: string[], opts: CommonInstallOptions & { url?: string; transport?: string }) => {
    if (!SERVER_NAME_RE.test(name)) throw new CliError(`"${name}" is not a valid name.`, EXIT.usage, 'Use 1-64 letters, numbers, "-" or "_" (no spaces).')
    if (!!opts.url === command.length > 0) throw new CliError('Give either a command (after --) or --url.', EXIT.usage, 'Example: claude-setup add files -- npx -y some-mcp-server')
    let config: ServerConfig
    if (opts.url) {
      let url: URL
      try {
        url = new URL(opts.url)
      } catch {
        throw new CliError(`"${opts.url}" is not a valid URL.`, EXIT.usage)
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CliError('The URL must start with https:// or http://.', EXIT.usage)
      const transport = (opts.transport ?? 'http').toLowerCase()
      if (transport !== 'http' && transport !== 'sse') throw new CliError('The transport must be http or sse.', EXIT.usage)
      const headers = pairsToRecord(opts.header, 'header')
      config = { type: transport, url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) }
    } else {
      const { command: exe, args } = splitCommandLine(command[0], command.slice(1))
      const env = pairsToRecord(opts.env, 'env')
      config = { type: 'stdio', command: exe, args, ...(Object.keys(env).length ? { env } : {}) }
    }
    const explicit = explicitTargets(ctx, opts)
    const core = await ctx.core()
    await runInstall(ctx, core, { config, name }, opts, explicit)
  })
}
