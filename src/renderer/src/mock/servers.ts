/**
 * Mock: TargetsApi + ServersApi — five apps (Claude Desktop running, Claude Code, VS Code installed;
 * Cursor and Windsurf not installed) and a handful of installed servers. Installing, removing, toggling,
 * copying and testing all update this in-memory state and emit realistic progress events.
 */
import type { ServersApi, TargetsApi } from '@shared/api'
import type {
  CatalogServer,
  InstallOption,
  InstallPreview,
  InstallRequest,
  InstallResult,
  InstalledServer,
  OpResult,
  RuntimeInfo,
  ServerConfig,
  TargetChangeResult,
  TargetId,
  TargetInfo,
  TargetRef,
  TestResult
} from '@shared/types'
import { CATALOG, findCatalogServer } from './catalog'
import { runtimeSnapshot } from './doctor'
import { addRecentProject, recordBackup } from './misc'
import { configPathFor, sampleProject, userConfigPath } from './paths'
import { clone, daysAgo, emit, env, homePath, log, sleep } from './runtime'

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

const TARGET_LABELS: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

interface TargetState {
  id: TargetId
  installed: boolean
  version?: string
  running?: boolean
}

let targetState: TargetState[] = [
  { id: 'claude-desktop', installed: true, version: '1.6.2', running: true },
  { id: 'claude-code', installed: true, version: '2.1.309' },
  { id: 'vscode', installed: true, version: '1.106.0' },
  { id: 'cursor', installed: false },
  { id: 'windsurf', installed: false }
]

let installedState: InstalledServer[] | null = null

/** Built lazily so paths follow the configured fake OS. */
function installed(): InstalledServer[] {
  if (installedState) return installedState
  const desktop = userConfigPath('claude-desktop')
  const code = userConfigPath('claude-code')
  const vscode = userConfigPath('vscode')
  const project = sampleProject()
  installedState = [
    {
      name: 'filesystem',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', homePath('Documents'), homePath('Projects')] },
      enabled: true,
      configPath: desktop,
      catalogId: 'io.github.modelcontextprotocol/filesystem',
      managedByUs: true,
      installedAt: daysAgo(12)
    },
    {
      name: 'notion',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'] },
      enabled: true,
      configPath: desktop,
      catalogId: 'com.notion/mcp',
      managedByUs: true,
      installedAt: daysAgo(9)
    },
    {
      name: 'memory',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      enabled: false,
      configPath: desktop,
      catalogId: 'io.github.modelcontextprotocol/memory',
      managedByUs: true,
      installedAt: daysAgo(30)
    },
    {
      name: 'github',
      target: { target: 'claude-code', scope: 'user' },
      config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_EXAMPLEexampleEXAMPLE0000' } },
      enabled: true,
      configPath: code,
      catalogId: 'io.github.github/github-mcp-server',
      managedByUs: true,
      installedAt: daysAgo(3)
    },
    {
      name: 'context7',
      target: { target: 'claude-code', scope: 'user' },
      config: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      enabled: true,
      configPath: code,
      catalogId: 'io.github.upstash/context7',
      managedByUs: true,
      installedAt: daysAgo(0.02)
    },
    {
      name: 'sequential-thinking',
      target: { target: 'claude-code', scope: 'project', projectPath: project },
      config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      enabled: true,
      configPath: configPathFor({ target: 'claude-code', scope: 'project', projectPath: project }),
      managedByUs: false
    },
    {
      name: 'playwright',
      target: { target: 'vscode', scope: 'user' },
      config: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
      enabled: true,
      configPath: vscode,
      catalogId: 'com.microsoft/playwright-mcp',
      managedByUs: true,
      installedAt: daysAgo(8)
    },
    {
      name: 'context7',
      target: { target: 'vscode', scope: 'user' },
      config: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      enabled: true,
      configPath: vscode,
      catalogId: 'io.github.upstash/context7',
      managedByUs: true,
      installedAt: daysAgo(0.02)
    }
  ]
  return installedState
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return a.target === b.target && (a.scope ?? 'user') === (b.scope ?? 'user') && (a.projectPath ?? '') === (b.projectPath ?? '')
}

function targetLabel(ref: TargetRef): string {
  const base = TARGET_LABELS[ref.target]
  if (ref.scope === 'project') return `${base} (this project)`
  if (ref.scope === 'local') return `${base} (just you, this project)`
  return base
}

function targetInfo(state: TargetState): TargetInfo {
  const count = installed().filter((s) => s.target.target === state.id).length
  const configPath = userConfigPath(state.id)
  const base = {
    id: state.id,
    label: TARGET_LABELS[state.id],
    installed: state.installed,
    version: state.version,
    configPath,
    configExists: state.installed,
    configValid: true,
    serverCount: count
  }
  switch (state.id) {
    case 'claude-desktop':
      return {
        ...base,
        description: 'The Claude app for chatting, writing and research.',
        running: state.running,
        supportsRemote: false,
        scopes: ['user'],
        notes: [
          'Claude Desktop reads its tools when it starts — restart it after changes.',
          'Online (remote) tools are connected through a small bridge (mcp-remote).'
        ],
        primary: true
      }
    case 'claude-code':
      return {
        ...base,
        description: 'Claude in your terminal — also powers the Claude Code extensions for VS Code and JetBrains.',
        supportsRemote: true,
        scopes: ['user', 'project', 'local'],
        notes: ['Tools added here also work in the Claude Code VS Code extension.'],
        primary: true
      }
    case 'vscode':
      return {
        ...base,
        description: 'VS Code’s built-in agent mode (GitHub Copilot) can use tools too.',
        supportsRemote: true,
        scopes: ['user', 'project'],
        notes: [],
        primary: false
      }
    case 'cursor':
      return {
        ...base,
        description: 'The Cursor code editor.',
        supportsRemote: true,
        scopes: ['user', 'project'],
        notes: state.installed ? [] : ['Cursor isn’t installed on this computer.'],
        primary: false
      }
    case 'windsurf':
      return {
        ...base,
        description: 'The Windsurf code editor.',
        supportsRemote: true,
        scopes: ['user'],
        notes: state.installed ? [] : ['Windsurf isn’t installed on this computer.'],
        primary: false
      }
  }
}

/** Snapshot of the targets (for other mock modules, e.g. doctor). */
export function targetsSnapshot(): TargetInfo[] {
  return targetState.map(targetInfo)
}

/** Snapshot of installed servers (for other mock modules). */
export function installedSnapshot(): InstalledServer[] {
  return clone(installed())
}

// ─────────────────────────────────────────────────────────────────────────────
// Config building (catalog option + values → ServerConfig, per-target snippets)
// ─────────────────────────────────────────────────────────────────────────────

function fill(template: string, values: Record<string, string>, args: Record<string, string | string[]>): string {
  return template
    .replace(/\{\{arg:([A-Za-z0-9_-]+)\}\}/g, (_, name: string) => {
      const value = args[name]
      return Array.isArray(value) ? value.join(' ') : (value ?? '')
    })
    .replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, name: string) => values[name] ?? '')
}

function argValues(option: InstallOption, values: Record<string, string | string[]>): string[] {
  const out: string[] = []
  for (const spec of option.argsSpec ?? []) {
    const value = values[spec.name]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    const list = Array.isArray(value) ? value : [value]
    // Positional for repeatable folder lists, --name=value for named options.
    if (spec.repeatable) out.push(...list)
    else out.push(`--${spec.name}=${list.join(',')}`)
  }
  return out
}

function buildConfig(server: CatalogServer, option: InstallOption, req: InstallRequest): ServerConfig {
  const env = { ...(req.values?.env ?? {}) }
  const args = req.values?.args ?? {}
  const extra = req.values?.extraArgs ?? []
  if (option.kind === 'remote') {
    const headers: Record<string, string> = {}
    for (const spec of option.headers ?? []) {
      const value = req.values?.headers?.[spec.name]
      if (value) headers[spec.name] = value
    }
    return {
      type: option.transport === 'sse' ? 'sse' : 'http',
      url: fill(option.url ?? '', env, args),
      ...(Object.keys(headers).length ? { headers } : {})
    }
  }
  const envOut: Record<string, string> = {}
  for (const spec of option.env) {
    const value = env[spec.name] ?? spec.default
    if (value) envOut[spec.name] = value
  }
  let command: string
  let baseArgs: string[]
  if (option.command) {
    command = option.command
    baseArgs = (option.args ?? []).map((a) => fill(a, env, args))
  } else if (option.kind === 'npm') {
    command = 'npx'
    baseArgs = option.args ?? ['-y', option.version && option.version !== 'latest' ? `${option.package}@${option.version}` : `${option.package}@latest`]
  } else if (option.kind === 'pypi') {
    command = 'uvx'
    baseArgs = option.args ?? [option.package ?? server.slug]
  } else if (option.kind === 'docker') {
    command = 'docker'
    baseArgs = ['run', '-i', '--rm', ...option.env.flatMap((e) => (envOut[e.name] ? ['-e', e.name] : [])), `${option.package}${option.version ? `:${option.version}` : ''}`]
  } else {
    command = option.package ?? server.slug
    baseArgs = option.args ?? []
  }
  return {
    type: 'stdio',
    command,
    args: [...baseArgs, ...argValues(option, args), ...extra],
    ...(Object.keys(envOut).length ? { env: envOut } : {})
  }
}

/** What actually gets written for a target (Desktop bridges remote servers through mcp-remote). */
function entryFor(target: TargetId, config: ServerConfig): { entry: Record<string, unknown>; note?: string; key: string } {
  if (target === 'claude-desktop') {
    if (config.type !== 'stdio') {
      const headerArgs = Object.entries(config.headers ?? {}).flatMap(([k, v]) => ['--header', `${k}:${v}`])
      return {
        key: 'mcpServers',
        entry: { command: 'npx', args: ['-y', 'mcp-remote', config.url, ...headerArgs] },
        note: 'Claude Desktop connects to online tools through a small bridge (mcp-remote). It needs Node.js.'
      }
    }
    const { type: _type, cwd: _cwd, ...rest } = config
    return { key: 'mcpServers', entry: rest }
  }
  if (target === 'vscode') return { key: 'servers', entry: { ...config } }
  if (target === 'windsurf' && config.type !== 'stdio') {
    return { key: 'mcpServers', entry: { serverUrl: config.url, ...(config.headers ? { headers: config.headers } : {}) } }
  }
  if (target === 'cursor' && config.type !== 'stdio') {
    return { key: 'mcpServers', entry: { url: config.url, ...(config.headers ? { headers: config.headers } : {}) } }
  }
  return { key: 'mcpServers', entry: { ...config } }
}

function snippet(target: TargetId, name: string, config: ServerConfig): { text: string; note?: string; written: unknown } {
  const { entry, note, key } = entryFor(target, config)
  return { text: JSON.stringify({ [key]: { [name]: entry } }, null, 2), note, written: entry }
}

function missingValues(option: InstallOption, req: InstallRequest): string[] {
  const missing: string[] = []
  for (const spec of option.env) if (spec.required && !spec.default && !req.values?.env?.[spec.name]) missing.push(spec.name)
  for (const spec of option.headers ?? []) if (spec.required && !req.values?.headers?.[spec.name]) missing.push(spec.name)
  for (const spec of option.argsSpec ?? []) {
    const value = req.values?.args?.[spec.name]
    if (spec.required && (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))) missing.push(spec.name)
  }
  return missing
}

function missingRuntimes(option: InstallOption, targets: TargetRef[]): RuntimeInfo[] {
  const runtimes = runtimeSnapshot()
  const needed = new Set<string>()
  if (option.runtime === 'node') needed.add('node')
  if (option.runtime === 'uv') needed.add('uv')
  if (option.runtime === 'docker') needed.add('docker')
  if (option.kind === 'remote' && targets.some((t) => t.target === 'claude-desktop')) needed.add('node')
  return runtimes.filter((r) => needed.has(r.id) && !r.found)
}

interface Resolved {
  name: string
  config: ServerConfig
  server?: CatalogServer
  option?: InstallOption
}

function resolve(req: InstallRequest): Resolved | { error: string } {
  if (req.config) {
    const name = req.name ?? ''
    if (!NAME_RE.test(name)) return { error: 'Give the tool a short name using letters, numbers, - or _ (no spaces).' }
    return { name, config: req.config }
  }
  const server = req.catalogId ? findCatalogServer(req.catalogId) : undefined
  if (!server) return { error: 'That tool is no longer in the catalog. Refresh the catalog and try again.' }
  const option = server.install.find((o) => o.id === req.optionId) ?? server.install[0]
  if (!option) return { error: `${server.name} has no automatic install option.` }
  const name = req.name ?? server.slug
  if (!NAME_RE.test(name)) return { error: 'Names may only use letters, numbers, - and _ (up to 64 characters).' }
  return { name, config: buildConfig(server, option, req), server, option }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection tests
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: Record<string, string[]> = {
  filesystem: ['read_text_file', 'write_file', 'edit_file', 'list_directory', 'directory_tree', 'search_files', 'move_file', 'get_file_info'],
  github: ['get_me', 'search_repositories', 'get_file_contents', 'list_issues', 'create_issue', 'list_pull_requests', 'create_pull_request', 'request_copilot_review'],
  playwright: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot', 'browser_close'],
  context7: ['resolve-library-id', 'get-library-docs'],
  notion: ['notion-search', 'notion-fetch', 'notion-create-pages', 'notion-update-page'],
  memory: ['create_entities', 'create_relations', 'add_observations', 'search_nodes', 'read_graph', 'delete_entities'],
  fetch: ['fetch'],
  time: ['get_current_time', 'convert_time'],
  'sequential-thinking': ['sequentialthinking'],
  'brave-search': ['brave_web_search', 'brave_local_search', 'brave_news_search', 'brave_image_search'],
  sentry: ['find_organizations', 'find_issues', 'get_issue_details', 'search_events'],
  linear: ['list_issues', 'create_issue', 'update_issue', 'list_projects'],
  'chrome-devtools': ['navigate_page', 'take_screenshot', 'performance_start_trace', 'list_console_messages']
}

/** Which catalog server does this config come from? */
function identify(config: ServerConfig): CatalogServer | undefined {
  if (config.type !== 'stdio') return CATALOG.find((s) => s.install.some((o) => o.url && config.url.startsWith(o.url)))
  const joined = [config.command, ...(config.args ?? [])].join(' ')
  const bridged = /mcp-remote\s+(\S+)/.exec(joined)?.[1]
  if (bridged) return CATALOG.find((s) => s.install.some((o) => o.url && bridged.startsWith(o.url)))
  return CATALOG.find((s) => s.install.some((o) => o.package && joined.includes(o.package)))
}

async function runTest(config: ServerConfig): Promise<TestResult> {
  const started = Date.now()
  await sleep(700 + Math.random() * 800)
  const ms = Date.now() - started
  const server = identify(config)
  const runtimes = runtimeSnapshot()
  const fail = (kind: TestResult['kind'], error: string, hint: string, stderr?: string): TestResult => ({
    ok: false,
    kind,
    ms,
    tools: [],
    error,
    hint,
    stderr
  })
  if (config.type === 'stdio') {
    if (config.command === 'uvx' && !runtimes.find((r) => r.id === 'uv')?.found) {
      return fail('command-not-found', '“uvx” was not found on this computer.', 'Install uv from the Health Check page, then test again.')
    }
    if (config.command === 'docker' && !runtimes.find((r) => r.id === 'docker')?.running) {
      return fail(
        'process-exited',
        'Docker isn’t running.',
        'Start Docker Desktop and try again.',
        'docker: error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
      )
    }
    if (server?.slug === 'brave-search' && !config.env?.BRAVE_API_KEY) {
      return fail('auth-required', 'The server needs an API key.', 'Add your Brave Search API key (BRAVE_API_KEY) and test again.', 'Error: BRAVE_API_KEY environment variable is required')
    }
  }
  const tools = (TOOLS[server?.slug ?? ''] ?? ['ping']).map((name) => ({ name, description: `${name.replace(/[_-]/g, ' ')}` }))
  return {
    ok: true,
    ms,
    serverName: server?.slug ?? 'server',
    serverVersion: server?.version ?? '1.0.0',
    protocol: '2025-11-25',
    tools
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APIs
// ─────────────────────────────────────────────────────────────────────────────

function needsRestart(ref: TargetRef): boolean {
  return ref.target === 'claude-desktop' && !!targetState.find((t) => t.id === 'claude-desktop')?.running
}

export const targetsApi: TargetsApi = {
  async list() {
    await sleep(120)
    return clone(targetsSnapshot())
  },

  async restartDesktop(): Promise<OpResult> {
    const desktop = targetState.find((t) => t.id === 'claude-desktop')
    if (!desktop?.installed) return { ok: false, message: 'Claude Desktop isn’t installed on this computer.' }
    emit('progress', { op: 'restart-desktop', message: 'Closing Claude Desktop…', pct: 20 })
    await sleep(900)
    emit('progress', { op: 'restart-desktop', message: 'Starting Claude Desktop…', pct: 70 })
    await sleep(900)
    emit('progress', { op: 'restart-desktop', message: 'Claude Desktop is ready', pct: 100 })
    targetState = targetState.map((t) => (t.id === 'claude-desktop' ? { ...t, running: true } : t))
    log('info', 'targets', 'Restarted Claude Desktop')
    return { ok: true, message: 'Claude Desktop restarted — your tools are ready.' }
  },

  async configPath(ref) {
    return configPathFor(ref)
  },

  async readRaw(ref) {
    const path = configPathFor(ref)
    const state = targetState.find((t) => t.id === ref.target)
    if (!state?.installed) return { path, exists: false, text: '' }
    const entries = installed().filter((s) => sameTarget(s.target, ref))
    const key = ref.target === 'vscode' ? 'servers' : 'mcpServers'
    const servers = Object.fromEntries(entries.filter((s) => s.enabled || ref.target !== 'claude-desktop').map((s) => [s.name, entryFor(ref.target, s.config).entry]))
    const doc: Record<string, unknown> = { [key]: servers }
    if (ref.target === 'claude-desktop') doc.preferences = { sidebarMode: 'chat', quickEntryShortcut: 'double-tap-option' }
    if (ref.target === 'claude-code' && (ref.scope ?? 'user') === 'user') {
      doc.numStartups = 214
      doc.projects = { [sampleProject()]: { allowedTools: [], hasTrustDialogAccepted: true } }
    }
    return { path, exists: true, text: JSON.stringify(doc, null, 2) }
  }
}

export const serversApi: ServersApi = {
  async list(filter) {
    await sleep(150)
    return clone(
      installed().filter(
        (s) =>
          (!filter?.target || s.target.target === filter.target) &&
          (!filter?.scope || (s.target.scope ?? 'user') === filter.scope) &&
          (!filter?.projectPath || s.target.projectPath === filter.projectPath)
      )
    )
  },

  async preview(req): Promise<InstallPreview> {
    const resolved = resolve(req)
    if ('error' in resolved) {
      return { name: req.name ?? '', config: req.config ?? { type: 'stdio', command: '' }, targets: [], missingRuntimes: [], missingValues: [], warnings: [resolved.error] }
    }
    const warnings: string[] = []
    const targets = req.targets.map((ref) => {
      const state = targetState.find((t) => t.id === ref.target)
      const { text, note } = snippet(ref.target, resolved.name, resolved.config)
      const exists = installed().some((s) => s.name === resolved.name && sameTarget(s.target, ref))
      if (exists && !req.overwrite) warnings.push(`${targetLabel(ref)} already has a tool named “${resolved.name}”. It will be replaced only if you choose to.`)
      if (needsRestart(ref)) warnings.push('Claude Desktop is open — it needs a restart to load the new tool.')
      return {
        target: ref,
        configPath: configPathFor(ref),
        snippet: text,
        supported: true,
        note: state?.installed ? note : `${TARGET_LABELS[ref.target]} isn’t installed — the settings will be ready when you install it.`
      }
    })
    const option = resolved.option
    if (option?.runtime === 'docker' && !runtimeSnapshot().find((r) => r.id === 'docker')?.running) {
      warnings.push('Docker Desktop is installed but not running — start it before using this tool.')
    }
    return clone({
      name: resolved.name,
      config: resolved.config,
      targets,
      missingRuntimes: option ? missingRuntimes(option, req.targets) : [],
      missingValues: option ? missingValues(option, req) : [],
      warnings: [...new Set(warnings)]
    })
  },

  async install(req): Promise<InstallResult> {
    return installWith(req, 'install')
  },

  async uninstall(name, targets) {
    await sleep(350)
    const results = targets.map((ref) => {
      const configPath = configPathFor(ref)
      const exists = installed().some((s) => s.name === name && sameTarget(s.target, ref))
      if (!exists) return { target: ref, ok: false, message: `“${name}” isn’t in ${targetLabel(ref)}.`, configPath }
      const backupId = recordBackup(`Remove "${name}" from ${targetLabel(ref)}`, [configPath])
      installedState = installed().filter((s) => !(s.name === name && sameTarget(s.target, ref)))
      return { target: ref, ok: true, message: 'Removed.', configPath, backupId, needsRestart: needsRestart(ref) }
    })
    if (results.some((r) => r.ok)) serversChanged()
    return results
  },

  async setEnabled(name, ref, enabled) {
    await sleep(250)
    const configPath = configPathFor(ref)
    const entry = installed().find((s) => s.name === name && sameTarget(s.target, ref))
    if (!entry) return { target: ref, ok: false, message: `“${name}” isn’t in ${targetLabel(ref)}.`, configPath }
    const backupId = recordBackup(`${enabled ? 'Turn on' : 'Turn off'} "${name}" in ${targetLabel(ref)}`, [configPath])
    installedState = installed().map((s) => (s === entry ? { ...s, enabled } : s))
    const restart = needsRestart(ref)
    serversChanged()
    return {
      target: ref,
      ok: true,
      message: `${enabled ? 'Turned on' : 'Turned off'}.${restart ? ' Restart Claude Desktop to apply.' : ''}`,
      configPath,
      backupId,
      needsRestart: restart
    }
  },

  async update(name, ref, config) {
    await sleep(300)
    const configPath = configPathFor(ref)
    const entry = installed().find((s) => s.name === name && sameTarget(s.target, ref))
    if (!entry) return { target: ref, ok: false, message: `“${name}” isn’t in ${targetLabel(ref)}.`, configPath }
    if (config.type === 'stdio' && !config.command.trim()) return { target: ref, ok: false, message: 'The command can’t be empty.', configPath }
    const backupId = recordBackup(`Edit "${name}" in ${targetLabel(ref)}`, [configPath])
    installedState = installed().map((s) => (s === entry ? { ...s, config } : s))
    serversChanged()
    return { target: ref, ok: true, message: 'Saved.', configPath, backupId, needsRestart: needsRestart(ref), written: entryFor(ref.target, config).entry }
  },

  async copy(name, from, to) {
    const source = installed().find((s) => s.name === name && sameTarget(s.target, from))
    if (!source) return { ok: false, name, results: [], warnings: [`“${name}” wasn’t found in ${targetLabel(from)}.`] }
    return installWith({ config: source.config, name, targets: to }, 'copy', source.catalogId)
  },

  async test(config) {
    return clone(await runTest(config))
  },

  async testInstalled(name, ref) {
    const entry = installed().find((s) => s.name === name && sameTarget(s.target, ref))
    if (!entry) return { ok: false, kind: 'invalid-config', ms: 0, tools: [], error: `“${name}” isn’t in ${targetLabel(ref)}.`, hint: 'Refresh the list and try again.' }
    return clone(await runTest(entry.config))
  }
}

/** Like the core: tell listeners that installed servers changed. */
function serversChanged(): void {
  emit('state', { key: 'servers' })
}

/** Install (or copy) with progress events under `op`; `catalogId` keeps the catalog link when copying. */
async function installWith(req: InstallRequest, op: 'install' | 'copy', catalogId?: string): Promise<InstallResult> {
  const resolved = resolve(req)
  if ('error' in resolved) {
    return { ok: false, name: req.name ?? '', results: req.targets.map((target) => ({ target, ok: false, message: resolved.error })), warnings: [] }
  }
  const { name, config, option } = resolved
  const missing = option ? missingValues(option, req) : []
  if (missing.length) {
    const message = `Fill in ${missing.join(', ')} first.`
    return { ok: false, name, results: req.targets.map((target) => ({ target, ok: false, message })), warnings: [] }
  }
  emit('progress', { op, message: 'Checking requirements…', pct: 10 })
  await sleep(450)
  const results: TargetChangeResult[] = []
  let step = 0
  for (const ref of req.targets) {
    step++
    emit('progress', { op, message: `Adding to ${targetLabel(ref)}…`, pct: 10 + Math.round((step / req.targets.length) * 75) })
    await sleep(400)
    const configPath = configPathFor(ref)
    const exists = installed().some((s) => s.name === name && sameTarget(s.target, ref))
    if (exists && !req.overwrite) {
      results.push({ target: ref, ok: false, message: `${targetLabel(ref)} already has a tool named “${name}”. Pick another name or replace it.`, configPath })
      continue
    }
    const backupId = recordBackup(`Install "${name}" in ${targetLabel(ref)}`, [configPath])
    installedState = [
      ...installed().filter((s) => !(s.name === name && sameTarget(s.target, ref))),
      {
        name,
        target: ref,
        config,
        enabled: true,
        configPath,
        catalogId: resolved.server?.id ?? catalogId ?? req.catalogId,
        managedByUs: true,
        installedAt: new Date().toISOString()
      }
    ]
    if (ref.projectPath) addRecentProject(ref.projectPath)
    const { written } = snippet(ref.target, name, config)
    const restart = needsRestart(ref)
    results.push({
      target: ref,
      ok: true,
      message: restart ? 'Added. Restart Claude Desktop to start using it.' : 'Added.',
      configPath,
      backupId,
      needsRestart: restart,
      written
    })
  }
  const test = req.test && results.some((r) => r.ok) ? await runTest(config) : undefined
  emit('progress', { op, message: 'Done', pct: 100 })
  log('info', 'servers', `Installed ${name} in ${results.filter((r) => r.ok).length} app(s)`)
  if (results.some((r) => r.ok)) serversChanged()
  const warnings = option?.kind === 'remote' && req.targets.some((t) => t.target === 'claude-desktop') ? ['Claude Desktop uses mcp-remote to reach this online tool.'] : []
  return clone({ ok: results.length > 0 && results.every((r) => r.ok), name, results, test, warnings })

}

/** Mark a target as installed/not installed (handy when experimenting in the browser console). */
export function setTargetInstalled(id: TargetId, isInstalled: boolean): void {
  targetState = targetState.map((t) => (t.id === id ? { ...t, installed: isInstalled, version: isInstalled ? (t.version ?? '1.0.0') : undefined } : t))
}

/** The home directory as seen by the mock (for path pickers). */
export function mockHome(): string {
  return env.home
}
