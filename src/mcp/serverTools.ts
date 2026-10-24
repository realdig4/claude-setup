/** MCP tools: catalog search, server install/uninstall/list/test/enable, targets, Claude Desktop restart. */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { InstallPreview, InstallRequest, InstallResult, InstalledServer, ServerConfig, TargetRef } from '@shared/types'
import {
  assertServerName,
  defineTool,
  refsFor,
  scopeSchema,
  splitCommandLine,
  stringMapSchema,
  targetIdSchema,
  type CoreGetter
} from './common'
import {
  UserError,
  changeResultsData,
  configLine,
  describeRef,
  detailCatalogServer,
  formatChangeResults,
  formatTestResult,
  hasRemote,
  needsKey,
  requiredValueNames,
  summarizeCatalogServer,
  summarizeInstalled,
  targetLabel,
  testResultData,
  toolResult,
  truncate
} from './format'

function findEntries(all: InstalledServer[], name: string, target?: string, scope?: string): InstalledServer[] {
  return all.filter((s) => s.name === name && (!target || s.target.target === target) && (!scope || s.target.scope === scope))
}

function previewText(p: InstallPreview): string {
  const lines = [`Preview for "${p.name}" — nothing has been written yet.`, `Starts with: ${configLine(p.config, 300)}`]
  for (const t of p.targets) {
    lines.push('', `${t.supported ? '•' : '✘'} ${describeRef(t.target)}${t.configPath ? ` → ${t.configPath}` : ''}${t.note ? ` (${t.note})` : ''}`)
    if (t.supported && t.snippet) lines.push(truncate(t.snippet, 1500))
  }
  if (p.missingValues.length) lines.push('', `Missing required values: ${p.missingValues.join(', ')} — pass them in env, headers or arg_values.`)
  for (const r of p.missingRuntimes) {
    lines.push(`Needs ${r.label}${r.install?.command ? ` (install: ${r.install.command})` : r.install?.url ? ` (get it from ${r.install.url})` : ''}.`)
  }
  for (const w of p.warnings) lines.push(`Note: ${w}`)
  return lines.join('\n')
}

function installText(r: InstallResult): string {
  const lines = [r.ok ? `Installed "${r.name}".` : `"${r.name}" was not installed everywhere.`, formatChangeResults(r.results)]
  if (r.test) lines.push(formatTestResult(r.test, `Connection test for "${r.name}"`))
  for (const w of r.warnings) lines.push(`Note: ${w}`)
  if (r.results.some((x) => x.ok && x.needsRestart)) lines.push('Restart the app(s) marked "restart needed" to load the change.')
  return lines.join('\n')
}

/** Register the catalog, server and target tools. */
export function registerServerTools(server: McpServer, getCore: CoreGetter): void {
  defineTool(
    server,
    'search_mcp_servers',
    {
      title: 'Search MCP servers',
      description:
        'Search the combined catalog of public MCP server registries (official MCP registry, GitHub, Smithery, Docker and more). ' +
        'Returns ids for get_mcp_server and install_mcp_server.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('What the server should do or connect to, e.g. "github", "postgres", "web search"'),
        category: z.string().max(80).optional().describe('Category id, e.g. "developer-tools"'),
        remote_only: z.boolean().optional().describe('Only servers that run in the cloud (nothing to install locally)'),
        no_key_required: z.boolean().optional().describe('Only servers that need no API key'),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0)
      }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const page = await core.catalog.search({
        query: a.query,
        category: a.category,
        remoteOnly: a.remote_only,
        noKeyRequired: a.no_key_required,
        limit: a.limit,
        offset: a.offset
      })
      if (!page.items.length) {
        return toolResult(`No MCP servers found${a.query ? ` for "${a.query}"` : ''}. Try a broader search or another word.`, { total: 0, items: [] })
      }
      const lines = [
        `Found ${page.total} MCP server${page.total === 1 ? '' : 's'}${a.query ? ` for "${a.query}"` : ''} (showing ${page.offset + 1}-${page.offset + page.items.length}):`
      ]
      page.items.forEach((s, i) => {
        const badges = [s.official ? 'official' : '', s.verified ? 'verified' : '', hasRemote(s) ? 'remote' : '', needsKey(s) ? 'needs key' : '']
          .filter(Boolean)
          .join(', ')
        lines.push('', `${page.offset + i + 1}. ${s.name} — id: ${s.id}${badges ? ` [${badges}]` : ''}`, `   ${truncate(s.description, 200)}`)
      })
      if (page.offset + page.items.length < page.total) lines.push('', `More results: call again with offset ${page.offset + page.items.length}.`)
      return toolResult(lines.join('\n'), { total: page.total, offset: page.offset, limit: page.limit, items: page.items.map(summarizeCatalogServer) })
    }
  )

  defineTool(
    server,
    'get_mcp_server',
    {
      title: 'Get MCP server details',
      description: 'Full details for one catalog server: description, install options (option ids), required environment variables, headers and arguments.',
      inputSchema: z.object({ id: z.string().min(1).max(300).describe('Catalog id from search_mcp_servers') }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const s = await core.catalog.get(a.id)
      if (!s) throw new UserError(`No catalog server with id "${a.id}". Use search_mcp_servers to find the right id.`)
      const lines = [`${s.name} — id: ${s.id} (default name: ${s.slug})`]
      const facts = [s.publisher ? `by ${s.publisher}` : '', s.official ? 'official' : '', s.verified ? 'verified' : '', s.stars ? `${s.stars} stars` : '']
      if (facts.some(Boolean)) lines.push(facts.filter(Boolean).join(' · '))
      if (s.repository) lines.push(`Repository: ${s.repository}`)
      lines.push('', truncate(s.longDescription || s.description, 1500), '', 'Install options:')
      for (const o of s.install) {
        const where = o.url ?? o.package ?? ''
        lines.push(`• option_id "${o.id}": ${o.label} (${o.transport}${o.runtime !== 'none' ? `, needs ${o.runtime}` : ''})${where ? ` — ${where}` : ''}`)
        const required = requiredValueNames(o)
        if (required.length) lines.push(`  Required: ${required.join(', ')}`)
        const optional = [...o.env, ...(o.headers ?? [])].filter((v) => !v.required).map((v) => v.name)
        if (optional.length) lines.push(`  Optional: ${optional.join(', ')}`)
        const args = (o.argsSpec ?? []).map((x) => `${x.name}${x.required ? ' (required)' : ''}${x.repeatable ? ' (list)' : ''}`)
        if (args.length) lines.push(`  Arguments (arg_values): ${args.join(', ')}`)
        if (o.notes) lines.push(`  ${truncate(o.notes, 300)}`)
      }
      if (!s.install.length) lines.push('• No automatic install option; see the repository for manual setup.')
      return toolResult(lines.join('\n'), detailCatalogServer(s))
    }
  )

  defineTool(
    server,
    'install_mcp_server',
    {
      title: 'Install MCP server',
      description:
        'Add an MCP server to one or more apps. Give exactly one of: catalog_id (from search), command (custom local server) or url (custom remote server). ' +
        'Use dry_run=true first to preview. Confirm the apps and values with the user before installing.',
      inputSchema: z.object({
        catalog_id: z.string().max(300).optional().describe('Catalog id from search_mcp_servers'),
        option_id: z.string().max(100).optional().describe('Install option id from get_mcp_server (default: the recommended one)'),
        command: z.string().max(1000).optional().describe('Custom local server: the executable, e.g. "npx" or "uvx"'),
        args: z.array(z.string().max(2000)).max(100).optional().describe('Custom server: command arguments. Catalog server: extra arguments appended'),
        url: z.string().url().max(2000).optional().describe('Custom remote server URL, e.g. https://example.com/mcp'),
        transport: z.enum(['http', 'sse']).optional().describe('Remote transport (default http)'),
        name: z.string().max(64).optional().describe('Config name ([A-Za-z0-9_-]); required for custom servers'),
        targets: z.array(targetIdSchema).min(1).describe('Apps to add the server to'),
        scope: scopeSchema.optional().describe('Claude Code: user (all projects), project (.mcp.json) or local; VS Code: user or project'),
        project_path: z.string().max(1000).optional().describe('Absolute project folder for project/local scope'),
        env: stringMapSchema.optional().describe('Environment variables, e.g. API keys'),
        headers: stringMapSchema.optional().describe('HTTP headers for remote servers'),
        arg_values: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe('Catalog servers: values for named arguments (lists for repeatable ones)'),
        test: z.boolean().optional().describe('Run a connection test after installing'),
        overwrite: z.boolean().optional().describe('Replace an existing server with the same name'),
        dry_run: z.boolean().optional().describe('Only show what would be written')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (a) => {
      const sources = [a.catalog_id, a.command, a.url].filter((v) => v !== undefined && v !== '').length
      if (sources !== 1) throw new UserError('Give exactly one of catalog_id, command or url.')
      if (a.name) assertServerName(a.name)
      const targets = refsFor(a.targets, a.scope, a.project_path)
      let req: InstallRequest
      if (a.catalog_id) {
        req = {
          catalogId: a.catalog_id,
          optionId: a.option_id,
          values: { env: a.env, headers: a.headers, args: a.arg_values, extraArgs: a.args },
          name: a.name,
          targets,
          overwrite: a.overwrite,
          test: a.test
        }
      } else {
        if (!a.name) throw new UserError('Choose a name for the custom server (letters, numbers, "-" or "_").')
        let config: ServerConfig
        if (a.command) {
          const { command, args } = splitCommandLine(a.command, a.args)
          config = { type: 'stdio', command, args, ...(a.env && Object.keys(a.env).length ? { env: a.env } : {}) }
        } else {
          config = { type: a.transport ?? 'http', url: a.url as string, ...(a.headers && Object.keys(a.headers).length ? { headers: a.headers } : {}) }
        }
        req = { config, name: a.name, targets, overwrite: a.overwrite, test: a.test }
      }
      const core = await getCore()
      if (a.dry_run) {
        const p = await core.servers.preview(req)
        return toolResult(previewText(p), {
          dryRun: true,
          name: p.name,
          config: { line: configLine(p.config, 500) },
          targets: p.targets.map((t) => ({ ...t, snippet: truncate(t.snippet, 1500) })),
          missingValues: p.missingValues,
          missingRuntimes: p.missingRuntimes.map((r) => ({ id: r.id, label: r.label, install: r.install })),
          warnings: p.warnings
        })
      }
      const r = await core.servers.install(req)
      return toolResult(
        installText(r),
        { ok: r.ok, name: r.name, results: changeResultsData(r.results), ...(r.test ? { test: testResultData(r.test) } : {}), warnings: r.warnings },
        !r.ok && r.results.every((x) => !x.ok)
      )
    }
  )

  defineTool(
    server,
    'uninstall_mcp_server',
    {
      title: 'Uninstall MCP server',
      description: 'Remove an MCP server from apps. Without targets it is removed from every app where it is installed. A backup is made first.',
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        targets: z.array(targetIdSchema).optional().describe('Apps to remove it from (default: all where installed)'),
        scope: scopeSchema.optional(),
        project_path: z.string().max(1000).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      let refs: TargetRef[]
      if (a.targets?.length) {
        refs = refsFor(a.targets, a.scope, a.project_path)
      } else {
        const found = findEntries(await core.servers.list(), a.name, undefined, a.scope)
        if (!found.length) throw new UserError(`No installed server is called "${a.name}". Use list_installed_mcp_servers to see the names.`)
        refs = found.map((s) => s.target)
      }
      const results = await core.servers.uninstall(a.name, refs)
      const ok = results.every((r) => r.ok)
      return toolResult(`${ok ? `Removed "${a.name}".` : `Some removals failed for "${a.name}".`}\n${formatChangeResults(results)}`, {
        ok,
        results: changeResultsData(results)
      }, results.length > 0 && results.every((r) => !r.ok))
    }
  )

  defineTool(
    server,
    'list_installed_mcp_servers',
    {
      title: 'List installed MCP servers',
      description: 'MCP servers configured in Claude Desktop, Claude Code, VS Code, Cursor and Windsurf (secret values are hidden).',
      inputSchema: z.object({
        target: targetIdSchema.optional().describe('Only this app'),
        scope: scopeSchema.optional(),
        project_path: z.string().max(1000).optional().describe('Include project/local servers of this folder')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const servers = await core.servers.list({ target: a.target, scope: a.scope, projectPath: a.project_path })
      if (!servers.length) {
        return toolResult(`No MCP servers are installed${a.target ? ` in ${targetLabel(a.target)}` : ''}.`, { servers: [] })
      }
      const lines = [`${servers.length} MCP server${servers.length === 1 ? '' : 's'} installed:`]
      for (const s of servers) {
        lines.push(`• ${s.name} — ${describeRef(s.target)}${s.enabled ? '' : ' (disabled)'}: ${configLine(s.config, 140)}`)
      }
      return toolResult(lines.join('\n'), { servers: servers.map(summarizeInstalled) })
    }
  )

  defineTool(
    server,
    'test_mcp_server',
    {
      title: 'Test MCP server',
      description:
        'Start an MCP server and list its tools to check it works. Test an installed server by name (and target), or a custom command/url before installing.',
      inputSchema: z.object({
        name: z.string().max(64).optional().describe('Installed server name'),
        target: targetIdSchema.optional().describe('App where it is installed (needed if installed in several)'),
        scope: scopeSchema.optional(),
        project_path: z.string().max(1000).optional(),
        command: z.string().max(1000).optional().describe('Custom: executable to start'),
        args: z.array(z.string().max(2000)).max(100).optional(),
        env: stringMapSchema.optional(),
        url: z.string().url().max(2000).optional().describe('Custom: remote server URL'),
        transport: z.enum(['http', 'sse']).optional(),
        headers: stringMapSchema.optional(),
        timeout_seconds: z.number().int().min(3).max(180).default(45)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const timeoutMs = a.timeout_seconds * 1000
      if (a.name) {
        const found = findEntries(await core.servers.list({ target: a.target, scope: a.scope, projectPath: a.project_path }), a.name, a.target, a.scope)
        if (!found.length) throw new UserError(`No installed server called "${a.name}"${a.target ? ` in ${targetLabel(a.target)}` : ''}.`)
        const entry = found[0]
        const t = await core.servers.testInstalled(entry.name, entry.target)
        const others = found.slice(1).map((s) => describeRef(s.target))
        const text = formatTestResult(t, `"${entry.name}" (${describeRef(entry.target)})`) + (others.length ? `\nAlso installed in: ${others.join(', ')}` : '')
        return toolResult(text, { name: entry.name, target: entry.target.target, ...testResultData(t) }, !t.ok)
      }
      let config: ServerConfig
      if (a.command) {
        const { command, args } = splitCommandLine(a.command, a.args)
        config = { type: 'stdio', command, args, ...(a.env ? { env: a.env } : {}) }
      } else if (a.url) {
        config = { type: a.transport ?? 'http', url: a.url, ...(a.headers ? { headers: a.headers } : {}) }
      } else {
        throw new UserError('Give the name of an installed server, or a command or url to test.')
      }
      const t = await core.servers.test(config, { timeoutMs })
      return toolResult(formatTestResult(t, configLine(config, 120)), testResultData(t), !t.ok)
    }
  )

  defineTool(
    server,
    'enable_disable_mcp_server',
    {
      title: 'Enable or disable MCP server',
      description: 'Turn an installed MCP server on or off without removing its settings.',
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        target: targetIdSchema,
        enabled: z.boolean().describe('true to enable, false to disable'),
        scope: scopeSchema.optional(),
        project_path: z.string().max(1000).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      let ref: TargetRef = refsFor([a.target], a.scope, a.project_path)[0]
      if (!a.scope) {
        const found = findEntries(await core.servers.list({ target: a.target }), a.name, a.target)
        if (found.length) ref = found[0].target
      }
      const r = await core.servers.setEnabled(a.name, ref, a.enabled)
      return toolResult(formatChangeResults([r]), { results: changeResultsData([r]) }, !r.ok)
    }
  )

  defineTool(
    server,
    'list_targets',
    {
      title: 'List apps (targets)',
      description: 'Which MCP apps are installed on this computer (Claude Desktop, Claude Code, VS Code, Cursor, Windsurf), their config files and server counts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const targets = await core.targets.list()
      const lines = targets.map((t) => {
        const state = t.installed ? `installed${t.version ? ` (${t.version})` : ''}` : 'not found'
        const config = t.configPath ? ` — config: ${t.configPath}${t.configExists ? '' : ' (not created yet)'}` : ''
        const problems = !t.configValid && t.configError ? ` — config problem: ${truncate(t.configError, 200)}` : ''
        const running = t.running ? ' — running' : ''
        return `• ${t.label}: ${state}, ${t.serverCount} server${t.serverCount === 1 ? '' : 's'}${running}${config}${problems}`
      })
      return toolResult(lines.join('\n'), {
        targets: targets.map((t) => ({
          id: t.id,
          label: t.label,
          installed: t.installed,
          version: t.version,
          configPath: t.configPath,
          configExists: t.configExists,
          configValid: t.configValid,
          configError: t.configError,
          running: t.running,
          supportsRemote: t.supportsRemote,
          scopes: t.scopes,
          serverCount: t.serverCount,
          notes: t.notes.slice(0, 5)
        }))
      })
    }
  )

  defineTool(
    server,
    'restart_claude_desktop',
    {
      title: 'Restart Claude Desktop',
      description:
        'Fully quit and reopen Claude Desktop so it loads changed MCP servers. Warning: if you are running inside Claude Desktop, this closes the current conversation.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const r = await core.targets.restartDesktop()
      return toolResult(r.message + (r.details ? `\n${truncate(r.details, 1000)}` : ''), { ok: r.ok, message: r.message }, !r.ok)
    }
  )
}
