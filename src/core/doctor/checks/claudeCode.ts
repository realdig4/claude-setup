/** Claude Code: installed + on PATH, settings files readable, managed (IT) restrictions, official plugin marketplace. */
import { dirname, join } from 'node:path'
import type { DoctorCheck, RuntimeInfo } from '@shared/types'
import { isPlainObject, pathExists, readJson } from '../../fs/json'
import { readClaudeSettings } from '../../models/claudeSettings'
import { run } from '../../platform/exec'
import { claudeConfigDir, claudeJsonPath, managedClaudeCodeDir } from '../../platform/paths'
import { errorText, guard, installFix, type CheckGroup, type RunContext } from '../context'
import { parseRegQuery } from '../policies'

const CATEGORY = 'claude-code' as const
const SETTINGS_DOCS = 'https://code.claude.com/docs/en/settings'
const OFFICIAL_MARKETPLACE = 'claude-plugins-official'

const TITLES = {
  installed: 'Claude Code',
  path: 'claude command on PATH',
  settings: 'Claude Code settings file',
  claudeJson: 'Claude Code data file (.claude.json)',
  managed: 'Managed Claude Code settings',
  marketplace: 'Official plugin marketplace'
}

function isBundledCopy(path: string | undefined): boolean {
  return !!path && /[\\/]\.vscode[^\\/]*[\\/]extensions[\\/]/i.test(path)
}

function normalizeDir(p: string): string {
  return p.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase()
}

function expandWindowsVars(p: string): string {
  return p.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (process.env[key] ?? whole) : whole
  })
}

/** Directories on the user's persistent PATH (Windows registry), expanded and normalized. */
async function windowsPathDirs(): Promise<string[] | null> {
  const keys = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']
  const dirs: string[] = []
  let readAny = false
  for (const key of keys) {
    const r = await run('reg', ['query', key, '/v', 'Path'], { timeoutMs: 8000 })
    if (!r.ok) continue
    readAny = true
    const raw = Object.entries(parseRegQuery(r.stdout)).find(([k]) => k.toLowerCase() === 'path')?.[1]
    if (raw) dirs.push(...raw.split(';').map(expandWindowsVars).map(normalizeDir).filter(Boolean))
  }
  return readAny ? dirs : null
}

/** Whether a new terminal finds `claude` (null when it can't be determined). */
async function claudeOnPath(rc: RunContext, claudePath: string): Promise<boolean | null> {
  if (rc.os === 'win32') {
    const dirs = await windowsPathDirs()
    return dirs ? dirs.includes(normalizeDir(dirname(claudePath))) : null
  }
  const shell = process.env.SHELL || (rc.os === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const r = await run(shell, ['-ilc', 'command -v claude'], { timeoutMs: 8000 })
  if (r.timedOut || r.error) return null
  return r.ok && r.stdout.trim().length > 0
}

function installedCheck(claude: RuntimeInfo | undefined): DoctorCheck {
  const base = { id: 'code:installed', category: CATEGORY, title: TITLES.installed, docsUrl: 'https://code.claude.com/docs/en/setup' }
  if (!claude?.found || isBundledCopy(claude.path)) {
    const bundled = isBundledCopy(claude?.path) ? ' Only the copy built into the VS Code extension was found.' : ''
    return {
      ...base,
      status: 'info',
      detail: `Claude Code isn't installed as a terminal command.${bundled} Install it to use claude in a terminal (the VS Code extension works without it).`,
      fix: installFix(claude, 'claude', 'Claude Code')
    }
  }
  const version = claude.version ? ` ${claude.version}` : ''
  return { ...base, status: 'ok', detail: `Claude Code${version}${claude.path ? ` at ${claude.path}` : ''}.` }
}

async function pathCheck(rc: RunContext, claude: RuntimeInfo | undefined): Promise<DoctorCheck | null> {
  if (!claude?.found || !claude.path || isBundledCopy(claude.path)) return null
  const onPath = await claudeOnPath(rc, claude.path)
  if (onPath === null) return null
  const base = { id: 'code:path', category: CATEGORY, title: TITLES.path }
  if (onPath) return { ...base, status: 'ok', detail: 'Typing claude in a new terminal starts Claude Code.' }
  const dir = dirname(claude.path)
  const how =
    rc.os === 'win32'
      ? `Add ${dir} to your user PATH (Start → "Edit environment variables for your account" → Path → New), then open a new terminal.`
      : `Add this line to your shell profile (~/.zshrc or ~/.bashrc): export PATH="${dir}:$PATH"`
  return {
    ...base,
    status: 'info',
    detail: `Claude Code is installed at ${claude.path}, but that folder isn't on your PATH, so typing claude in a new terminal may not work. ${how}`
  }
}

async function settingsCheck(): Promise<DoctorCheck> {
  const file = await readClaudeSettings()
  const base = { id: 'code:settings', category: CATEGORY, title: TITLES.settings, docsUrl: SETTINGS_DOCS }
  if (file.error) {
    return {
      ...base,
      status: 'error',
      detail:
        `Claude Code can't read ${file.path} (${file.error}). It shows a "Settings Error" and ignores the whole file — ` +
        "fix it (comments and trailing commas aren't allowed) or restore a backup from Backups."
    }
  }
  if (!file.exists) return { ...base, status: 'ok', detail: `No settings file yet (${file.path}) — that's fine.` }
  return { ...base, status: 'ok', detail: `${file.path} is valid.` }
}

async function claudeJsonCheck(): Promise<DoctorCheck> {
  const path = claudeJsonPath()
  const r = await readJson<unknown>(path)
  const base = { id: 'code:claude-json', category: CATEGORY, title: TITLES.claudeJson }
  if (!r.exists) return { ...base, status: 'ok', detail: `${path} doesn't exist yet — Claude Code creates it the first time it runs.` }
  if (r.error || !isPlainObject(r.data)) {
    return {
      ...base,
      status: 'error',
      detail:
        `${path} can't be read (${r.error ?? 'not a JSON object'}). It holds Claude Code's MCP servers and project settings. ` +
        `Restore a backup from Backups, or a copy from ${join(claudeConfigDir(), 'backups')}.`
    }
  }
  return { ...base, status: 'ok', detail: `${path} is valid.` }
}

async function managedChecks(): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  const dir = managedClaudeCodeDir()
  const mcpFile = join(dir, 'managed-mcp.json')
  if (await pathExists(mcpFile)) {
    out.push({
      id: 'code:managed-mcp',
      category: CATEGORY,
      title: 'Managed MCP servers',
      status: 'warn',
      detail:
        `An administrator controls Claude Code's MCP servers on this computer (${mcpFile}). ` +
        'Servers you add for Claude Code are ignored while that file exists.',
      docsUrl: 'https://code.claude.com/docs/en/managed-mcp'
    })
  }
  const settings = await readJson<unknown>(join(dir, 'managed-settings.json'))
  if (settings.exists && !settings.error && isPlainObject(settings.data)) {
    const { forceLoginMethod, allowedProviders } = settings.data
    const limits: string[] = []
    if (typeof forceLoginMethod === 'string') limits.push(`sign-in is forced to "${forceLoginMethod}" (API keys and third-party models are blocked)`)
    if (Array.isArray(allowedProviders)) limits.push(`only these providers are allowed: ${allowedProviders.join(', ')}`)
    if (limits.length) {
      out.push({
        id: 'code:managed-settings',
        category: CATEGORY,
        title: TITLES.managed,
        status: 'warn',
        detail: `Your organization's managed settings apply: ${limits.join('; ')}.`,
        docsUrl: 'https://code.claude.com/docs/en/managed-settings'
      })
    }
  }
  return out
}

async function marketplaceCheck(claude: RuntimeInfo | undefined): Promise<DoctorCheck | null> {
  if (!claude?.found) return null
  const base = { id: 'code:marketplace', category: CATEGORY, title: TITLES.marketplace, docsUrl: 'https://code.claude.com/docs/en/plugins' }
  const added = { ...base, status: 'ok' as const, detail: 'The official plugin marketplace is added.' }
  const known = await readJson<unknown>(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json'))
  if (isPlainObject(known.data) && OFFICIAL_MARKETPLACE in known.data) return added
  const settings = await readClaudeSettings()
  const extra = settings.data?.extraKnownMarketplaces ?? settings.data?.additionalMarketplaces
  if (isPlainObject(extra) && OFFICIAL_MARKETPLACE in extra) return added
  return {
    ...base,
    status: 'info',
    detail:
      "The official plugin marketplace (anthropics/claude-plugins-official) isn't added yet. " +
      'Claude Code adds it the first time you run claude in a terminal, or add it on the Extensions page.'
  }
}

export const claudeCodeChecks: CheckGroup = {
  id: 'claude-code',
  category: CATEGORY,
  title: 'Claude Code',
  timeoutMs: 30_000,
  async run(rc) {
    let claude: RuntimeInfo | undefined
    let first: DoctorCheck
    try {
      claude = await rc.runtime('claude')
      first = installedCheck(claude)
    } catch (err) {
      const detail = `Couldn't check whether Claude Code is installed: ${errorText(err)}`
      first = { id: 'code:installed', category: CATEGORY, title: TITLES.installed, status: 'warn', detail }
    }
    const rest = await Promise.all([
      guard('code:path', CATEGORY, TITLES.path, () => pathCheck(rc, claude)),
      guard('code:settings', CATEGORY, TITLES.settings, () => settingsCheck()),
      guard('code:claude-json', CATEGORY, TITLES.claudeJson, () => claudeJsonCheck()),
      guard('code:managed', CATEGORY, TITLES.managed, () => managedChecks()),
      guard('code:marketplace', CATEGORY, TITLES.marketplace, () => marketplaceCheck(claude))
    ])
    return [first, ...rest.flat()]
  }
}
