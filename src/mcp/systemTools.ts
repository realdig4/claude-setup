/** MCP tools: doctor, extensions (plugins/skills/agents…), catalog refresh, backups. */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { CheckStatus, DoctorCheck, ExtensionItem, OpResult } from '@shared/types'
import { defineTool, scopeSchema, type CoreGetter } from './common'
import { UserError, toolResult, truncate } from './format'

const extensionKindSchema = z.enum(['plugin', 'skill', 'agent', 'command', 'hook', 'statusline', 'output-style'])
const extensionSourceSchema = z.enum(['claude-cli', 'marketplace', 'skills.sh', 'aitmpl', 'anthropic-skills', 'local'])

const STATUS_ICON: Record<CheckStatus, string> = { error: '✘', warn: '⚠', info: 'ℹ', ok: '✔', skip: '–' }
const STATUS_ORDER: CheckStatus[] = ['error', 'warn', 'info', 'ok', 'skip']

function opText(r: OpResult): string {
  return [r.message, r.details ? truncate(r.details, 1500) : '', r.backupId ? `Backup: ${r.backupId}` : '', r.needsRestart ? 'Restart the affected app to apply it.' : '']
    .filter(Boolean)
    .join('\n')
}

function opData(r: OpResult): Record<string, unknown> {
  return { ok: r.ok, message: r.message, ...(r.details ? { details: truncate(r.details, 1500) } : {}), ...(r.backupId ? { backupId: r.backupId } : {}), ...(r.needsRestart ? { needsRestart: true } : {}) }
}

function checkLine(c: DoctorCheck): string {
  const fix = c.fix ? ` — fix available: "${c.fix.label}" (fix_id: ${c.fix.id}${c.fix.auto ? '' : ', manual steps'})` : ''
  return `${STATUS_ICON[c.status]} [${c.category}] ${c.title}${c.detail ? `: ${truncate(c.detail, 300)}` : ''}${fix}`
}

function extensionSummary(e: ExtensionItem): Record<string, unknown> {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    description: truncate(e.description, 200),
    ...(e.author ? { author: e.author } : {}),
    source: e.source,
    ...(e.marketplace ? { marketplace: e.marketplace } : {}),
    ...(e.installs !== undefined ? { installs: e.installs } : {}),
    ...(e.stars !== undefined ? { stars: e.stars } : {}),
    installed: e.installed,
    ...(e.scope ? { scope: e.scope } : {}),
    ...(e.enabled !== undefined ? { enabled: e.enabled } : {}),
    ...(e.warnings?.length ? { warnings: e.warnings } : {})
  }
}

/** Register the doctor, extension, catalog-refresh and backup tools. */
export function registerSystemTools(server: McpServer, getCore: CoreGetter): void {
  defineTool(
    server,
    'run_doctor',
    {
      title: 'Run health check',
      description: 'Check runtimes (Node, uv, Docker), Claude Desktop, Claude Code, VS Code, model settings and MCP configs. Problems come with fix ids for apply_doctor_fix.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const report = await core.doctor.run()
      const s = report.summary
      const lines = [`Health check: ${s.ok ?? 0} ok, ${s.warn ?? 0} warning(s), ${s.error ?? 0} problem(s), ${s.info ?? 0} note(s).`]
      const sorted = [...report.checks].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
      for (const c of sorted.filter((c) => c.status === 'error' || c.status === 'warn' || c.status === 'info')) lines.push(checkLine(c))
      const passed = sorted.filter((c) => c.status === 'ok').length
      if (passed) lines.push(`(${passed} passing check${passed === 1 ? '' : 's'} not listed)`)
      return toolResult(lines.join('\n'), {
        ranAt: report.ranAt,
        summary: report.summary,
        checks: sorted.map((c) => ({
          id: c.id,
          category: c.category,
          title: c.title,
          status: c.status,
          ...(c.detail ? { detail: truncate(c.detail, 400) } : {}),
          ...(c.fix ? { fix: c.fix } : {})
        }))
      })
    }
  )

  defineTool(
    server,
    'apply_doctor_fix',
    {
      title: 'Apply health-check fix',
      description: 'Apply one fix from run_doctor (by fix_id). Config files are backed up first. Confirm with the user before applying.',
      inputSchema: z.object({ fix_id: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const r = await core.doctor.fix(a.fix_id)
      return toolResult(opText(r), opData(r), !r.ok)
    }
  )

  defineTool(
    server,
    'search_extensions',
    {
      title: 'Search Claude Code extensions',
      description: 'Search plugins, skills, subagents, slash commands, hooks, status lines and output styles for Claude Code.',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        kind: extensionKindSchema.optional(),
        source: extensionSourceSchema.optional(),
        limit: z.number().int().min(1).max(50).default(15)
      }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const items = (await core.extensions.search({ query: a.query, kind: a.kind, source: a.source, limit: a.limit })).slice(0, a.limit)
      if (!items.length) return toolResult(`No extensions found${a.query ? ` for "${a.query}"` : ''}.`, { items: [] })
      const lines = items.map(
        (e) => `• ${e.name} — ${e.kind}, id: ${e.id}${e.installed ? ' (installed)' : ''}\n  ${truncate(e.description, 160)}${e.warnings?.length ? `\n  ⚠ ${e.warnings.join('; ')}` : ''}`
      )
      return toolResult(lines.join('\n'), { items: items.map(extensionSummary) })
    }
  )

  defineTool(
    server,
    'install_extension',
    {
      title: 'Install extension',
      description: 'Install a plugin, skill, agent, command, hook, status line or output style by id (from search_extensions). Confirm with the user first.',
      inputSchema: z.object({
        id: z.string().min(1).max(400),
        scope: scopeSchema.optional().describe('user (default) or project/local'),
        project_path: z.string().max(1000).optional().describe('Absolute project folder for project/local scope')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (a) => {
      if ((a.scope === 'project' || a.scope === 'local') && !a.project_path) throw new UserError('project_path is required for project or local scope.')
      const core = await getCore()
      const r = await core.extensions.install(a.id, { scope: a.scope, projectPath: a.project_path })
      return toolResult(opText(r), opData(r), !r.ok)
    }
  )

  defineTool(
    server,
    'uninstall_extension',
    {
      title: 'Uninstall extension',
      description: 'Remove an installed plugin, skill, agent, command, hook, status line or output style by id. Confirm with the user first.',
      inputSchema: z.object({
        id: z.string().min(1).max(400),
        scope: scopeSchema.optional(),
        project_path: z.string().max(1000).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const r = await core.extensions.uninstall(a.id, { scope: a.scope, projectPath: a.project_path })
      return toolResult(opText(r), opData(r), !r.ok)
    }
  )

  defineTool(
    server,
    'list_installed_extensions',
    {
      title: 'List installed extensions',
      description: 'Plugins, skills, agents, commands, hooks, status lines and output styles installed for Claude Code.',
      inputSchema: z.object({ kind: extensionKindSchema.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const items = await core.extensions.installed(a.kind)
      if (!items.length) return toolResult(`No ${a.kind ? `${a.kind}s` : 'extensions'} installed.`, { items: [] })
      const lines = items.map((e) => `• ${e.name} — ${e.kind}${e.scope ? ` (${e.scope})` : ''}${e.enabled === false ? ', disabled' : ''}, id: ${e.id}`)
      return toolResult(lines.join('\n'), { items: items.map(extensionSummary) })
    }
  )

  defineTool(
    server,
    'refresh_catalog',
    {
      title: 'Refresh MCP catalog',
      description: 'Download the latest server lists from the public MCP registries (normally refreshed automatically once a day).',
      inputSchema: z.object({ force: z.boolean().optional().describe('Refresh even if the cache is still fresh') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (a) => {
      const core = await getCore()
      const stats = await core.catalog.refresh({ force: a.force })
      const lines = [`The catalog has ${stats.total} servers.`]
      for (const s of stats.sources.filter((x) => x.enabled)) lines.push(`• ${s.source}: ${s.count}${s.error ? ` — problem: ${truncate(s.error, 200)}` : ''}`)
      return toolResult(lines.join('\n'), { ...stats })
    }
  )

  defineTool(
    server,
    'list_backups',
    {
      title: 'List backups',
      description: 'Backups Claude Setup made before changing config files (newest first). Use restore_backup to undo a change.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const backups = (await core.backups.list()).slice(0, a.limit)
      if (!backups.length) return toolResult('There are no backups yet.', { backups: [] })
      const lines = backups.map((b) => `• ${b.id} — ${b.createdAt}: ${b.reason} (${b.files.map((f) => f.path).join(', ')})`)
      return toolResult(lines.join('\n'), { backups })
    }
  )

  defineTool(
    server,
    'restore_backup',
    {
      title: 'Restore backup',
      description: 'Put back the files saved in a backup (the current files are backed up first). Confirm with the user before restoring.',
      inputSchema: z.object({ id: z.string().min(1).max(100).describe('Backup id from list_backups') }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const r = await core.backups.restore(a.id)
      return toolResult(opText(r), opData(r), !r.ok)
    }
  )
}
