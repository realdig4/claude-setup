/** Mock: app (info, settings, secrets), backups and self (Claude Setup's own MCP server / CLI). */
import type { AppApi, BackupsApi, SelfApi } from '@shared/api'
import type { AppInfo, AppSettings, BackupEntry, CatalogSource, InstallResult, OpResult, TargetChangeResult, TargetId, TargetRef } from '@shared/types'
import { configPathFor, dataDir, desktopConfigPath, userConfigPath, claudeSettingsPath, vscodeSettingsPath } from './paths'
import { backupIdFor, clone, daysAgo, emit, env, hoursAgo, log, minutesAgo, sleep } from './runtime'

// ─────────────────────────────────────────────────────────────────────────────
// Settings & secrets
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SOURCES: Record<CatalogSource, boolean> = {
  official: true,
  anthropic: true,
  github: true,
  smithery: true,
  docker: true,
  cline: true,
  awesome: true,
  glama: false,
  pulsemcp: false,
  seed: true
}

let settings: AppSettings = {
  mode: 'simple',
  theme: 'system',
  defaultTargets: [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }],
  sources: { ...DEFAULT_SOURCES },
  catalogTtlHours: 24,
  autoRestartDesktop: false,
  keepBackups: 30,
  onboarded: true,
  recentProjects: []
}

const secrets = new Map<string, string>([
  ['model:prof-kimi', 'sk-example-kimi-key'],
  ['proxy:groq', 'gsk_example_groq_key']
])

/** Override initial settings (used by installMockApi for ?theme= / ?mode= / ?onboarded=). */
export function seedSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch, sources: { ...settings.sources, ...(patch.sources ?? {}) } }
}

/** Current settings (read-only copy) for other mock modules. */
export function currentSettings(): AppSettings {
  return clone(settings)
}

export function storeSecret(ref: string, value: string | null): void {
  if (value === null || value === '') secrets.delete(ref)
  else secrets.set(ref, value)
}

export function secretExists(ref: string): boolean {
  return secrets.has(ref)
}

export function addRecentProject(path: string): void {
  settings = { ...settings, recentProjects: [path, ...settings.recentProjects.filter((p) => p !== path)].slice(0, 8) }
}

export const appApi: AppApi = {
  async info(): Promise<AppInfo> {
    const exe =
      env.platform === 'win32'
        ? 'C:\\Program Files\\Claude Setup\\Claude Setup.exe'
        : env.platform === 'darwin'
          ? '/Applications/Claude Setup.app/Contents/MacOS/Claude Setup'
          : '/opt/Claude Setup/claude-setup'
    const mcpEntry =
      env.platform === 'win32'
        ? 'C:\\Program Files\\Claude Setup\\resources\\app.asar\\out\\main\\mcp.js'
        : env.platform === 'darwin'
          ? '/Applications/Claude Setup.app/Contents/Resources/app.asar/out/main/mcp.js'
          : '/opt/Claude Setup/resources/app.asar/out/main/mcp.js'
    return {
      name: 'Claude Setup',
      version: '0.1.0',
      platform: env.platform,
      arch: env.platform === 'darwin' ? 'arm64' : 'x64',
      dataDir: dataDir(),
      surface: 'gui',
      selfMcpConfig: { type: 'stdio', command: exe, args: [mcpEntry], env: { ELECTRON_RUN_AS_NODE: '1' } },
      packaged: false
    }
  },

  async getSettings() {
    return clone(settings)
  },

  async updateSettings(patch) {
    settings = { ...settings, ...patch, sources: { ...settings.sources, ...(patch.sources ?? {}) } }
    emit('state', { key: 'settings' })
    log('info', 'app', `Settings updated: ${Object.keys(patch).join(', ')}`)
    return clone(settings)
  },

  async setSecret(ref, value): Promise<OpResult> {
    if (!ref.trim()) return { ok: false, message: 'A secret needs a name.' }
    storeSecret(ref, value)
    return { ok: true, message: value ? 'Saved securely on this computer.' : 'Removed.' }
  },

  async hasSecret(ref) {
    return secretExists(ref)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backups
// ─────────────────────────────────────────────────────────────────────────────

/** Built lazily so paths follow the configured fake OS. */
let backupsState: BackupEntry[] | null = null

function backupsList(): BackupEntry[] {
  backupsState ??= [
    {
      id: backupIdFor(new Date(Date.now() - 25 * 60_000)),
      createdAt: minutesAgo(25),
      reason: 'Install "context7" in Claude Code and VS Code',
      files: [
        { path: userConfigPath('claude-code'), existed: true, size: 48_213 },
        { path: userConfigPath('vscode'), existed: true, size: 612 }
      ]
    },
    {
      id: backupIdFor(new Date(Date.now() - 5 * 3_600_000)),
      createdAt: hoursAgo(5),
      reason: 'Use Kimi K3 in Claude Code',
      files: [
        { path: claudeSettingsPath(), existed: true, size: 1_842 },
        { path: vscodeSettingsPath(), existed: true, size: 3_377 }
      ]
    },
    {
      id: backupIdFor(new Date(Date.now() - 3 * 86_400_000)),
      createdAt: daysAgo(3),
      reason: 'Install "github" in Claude Code',
      files: [{ path: userConfigPath('claude-code'), existed: true, size: 47_950 }]
    },
    {
      id: backupIdFor(new Date(Date.now() - 12 * 86_400_000)),
      createdAt: daysAgo(12),
      reason: 'Install "filesystem" in Claude Desktop',
      files: [{ path: desktopConfigPath(), existed: false, size: 0 }]
    }
  ]
  return backupsState
}

/** Record a backup like the core does before every write. Returns the backup id. */
export function recordBackup(reason: string, paths: string[]): string {
  const id = backupIdFor()
  const files = paths.map((path) => ({ path, existed: true, size: 900 + Math.round(Math.random() * 40_000) }))
  backupsState = [{ id, createdAt: new Date().toISOString(), reason, files }, ...backupsList()].slice(0, settings.keepBackups)
  return id
}

export const backupsApi: BackupsApi = {
  async list() {
    return clone(backupsList())
  },

  async restore(id): Promise<OpResult> {
    await sleep(700)
    const entry = backupsList().find((b) => b.id === id)
    if (!entry) return { ok: false, message: 'That backup no longer exists.' }
    const safety = recordBackup(`Before restoring backup from ${new Date(entry.createdAt).toLocaleString()}`, entry.files.map((f) => f.path))
    const count = entry.files.length
    return {
      ok: true,
      message: `Restored ${count} ${count === 1 ? 'file' : 'files'}. Your current files were backed up first.`,
      backupId: safety,
      needsRestart: entry.files.some((f) => f.path === desktopConfigPath())
    }
  },

  async delete(id): Promise<OpResult> {
    const list = backupsList()
    backupsState = list.filter((b) => b.id !== id)
    return list.length === backupsState.length ? { ok: false, message: 'That backup no longer exists.' } : { ok: true, message: 'Backup deleted.' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Self (Claude Setup as an MCP server, CLI shim)
// ─────────────────────────────────────────────────────────────────────────────

const selfRegistered = new Set<TargetId>(['claude-code'])

export const selfApi: SelfApi = {
  async mcpStatus() {
    const targets: TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']
    return targets.map((target) => ({ target, registered: selfRegistered.has(target), configPath: userConfigPath(target) }))
  },

  async registerMcp(targets: TargetRef[]): Promise<InstallResult> {
    await sleep(600)
    const results: TargetChangeResult[] = targets.map((ref) => {
      selfRegistered.add(ref.target)
      const configPath = configPathFor(ref)
      return {
        target: ref,
        ok: true,
        message: ref.target === 'claude-desktop' ? 'Added. Restart Claude Desktop to start using it.' : 'Added.',
        configPath,
        backupId: recordBackup('Register Claude Setup as a tool', [configPath]),
        needsRestart: ref.target === 'claude-desktop'
      }
    })
    return { ok: true, name: 'claude-setup', results, warnings: [] }
  },

  async unregisterMcp(targets: TargetRef[]) {
    await sleep(400)
    return targets.map((ref) => {
      selfRegistered.delete(ref.target)
      return { target: ref, ok: true, message: 'Removed.', configPath: configPathFor(ref) }
    })
  },

  async installCli(): Promise<OpResult> {
    await sleep(500)
    const where = env.platform === 'win32' ? '%USERPROFILE%\\.local\\bin' : '~/.local/bin'
    return { ok: true, message: `Installed the claude-setup command in ${where}. Open a new terminal to use it.` }
  }
}
