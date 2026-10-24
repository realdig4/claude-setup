/**
 * Claude Desktop target: claude_desktop_config.json → "mcpServers".
 *
 * - Strict JSON; Desktop validates entries with zod ({command, args?: string[], env?: Record<string,string>}) and
 *   strips unknown keys, so only those keys are written. Every other top-level key (preferences…) is preserved.
 * - If the file doesn't parse, Desktop runs with NO servers and refuses to write it — Claude Setup refuses too.
 * - Local (stdio) servers only: remote servers are bridged through mcp-remote.
 * - macOS/Linux: GUI-launched Desktop has a minimal PATH, so npx/uvx/docker/node are written as absolute paths
 *   with env.PATH "<dir>:${PATH}" (Desktop expands ${PATH} itself). Windows keeps bare commands (Desktop resolves
 *   .cmd shims and re-reads the user PATH itself).
 * - Desktop rewrites the file from memory while running: changes are still written, flagged needsRestart and
 *   remembered so restartDesktop() can re-apply them if Desktop overwrote them while quitting.
 * - When the 3P (third-party inference) profile is in use, servers are written to its config as well.
 */
import { dirname, isAbsolute } from 'node:path'
import type { ServerConfig, StdioServerConfig, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject } from '../fs/json'
import { currentOS } from '../platform/paths'
import type { NormalizedRef, TargetAdapter } from './adapter'
import { editConfigDoc, getAt, getMap, jsonEqual, readConfigDoc, type DocEdit } from './configDoc'
import { detectDesktopInstall, resolveDesktopConfig } from './desktopPaths'
import { isDesktopRunning } from './desktopProcess'
import { parseStdioEntry, stdioNative } from './entries'
import { createFileAdapter, type Location } from './fileAdapter'
import { bridgeRemote, parseBridge } from './mcpRemote'
import { safeFixPath, safeWhich } from './sys'
import { desktopEntryProblems, invalidDesktopEntries, isRemoteConfig, SERVER_NAME_RE } from './validate'

/** Commands resolved to absolute paths for GUI-launched Desktop on macOS / Linux. */
export const DESKTOP_RESOLVED_COMMANDS = new Set([
  'npx',
  'node',
  'npm',
  'uvx',
  'uv',
  'docker',
  'bunx',
  'bun',
  'deno',
  'pnpm',
  'pnpx',
  'python3',
  'python'
])

export interface PrepareDeps {
  os: 'win32' | 'darwin' | 'linux'
  which: (command: string) => Promise<string | null>
  fixPath: () => Promise<void>
  /** Environment to copy proxy / CA settings from (defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

const defaultDeps = (): PrepareDeps => ({ os: currentOS(), which: safeWhich, fixPath: safeFixPath })

/** Desktop doesn't pass these to servers; copied into the entry when this machine has them (proxies, company CAs). */
const DESKTOP_PASS_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']

function withMachineEnv(stdio: StdioServerConfig, deps: PrepareDeps): StdioServerConfig {
  const source = deps.env ?? process.env
  const env = { ...(stdio.env ?? {}) }
  const has = (name: string) => Object.keys(env).some((k) => k.toUpperCase() === name)
  for (const name of DESKTOP_PASS_ENV) {
    if (has(name)) continue
    const key = deps.os === 'win32' ? name : [name, name.toLowerCase()].find((k) => source[k])
    const value = key ? source[key] : undefined
    if (key && value) env[key] = value
  }
  return Object.keys(env).length ? { ...stdio, env } : stdio
}

/** Turn any config into the stdio config Claude Desktop will run (bridge remotes, drop cwd, absolute paths on POSIX). */
export async function prepareDesktopConfig(config: ServerConfig, deps: PrepareDeps = defaultDeps()): Promise<StdioServerConfig> {
  const base: StdioServerConfig = isRemoteConfig(config) ? bridgeRemote(config) : { ...config, type: 'stdio' }
  delete base.cwd
  const stdio = withMachineEnv(base, deps)
  if (deps.os === 'win32') return stdio
  const command = stdio.command.trim()
  if (isAbsolute(command) || command.includes('/') || !DESKTOP_RESOLVED_COMMANDS.has(command)) return stdio
  await deps.fixPath()
  const abs = await deps.which(command)
  if (!abs) return stdio
  const env = { ...(stdio.env ?? {}) }
  if (!env.PATH) env.PATH = `${dirname(abs)}:\${PATH}`
  return { ...stdio, command: abs, env }
}

/** Native Desktop entry {command, args, env?}. Remote configs are bridged (pure, no PATH lookups). */
export function desktopToNative(config: ServerConfig): Record<string, unknown> {
  return stdioNative(isRemoteConfig(config) ? bridgeRemote(config) : config)
}

/** Desktop entry → ServerConfig; mcp-remote bridges come back as the remote server they stand for. */
export function desktopFromNative(entry: unknown): ServerConfig | null {
  if (!isPlainObject(entry)) return null
  const stdio = parseStdioEntry(entry)
  if (!stdio) return null
  delete stdio.cwd
  return parseBridge(stdio) ?? stdio
}

interface PendingChange {
  /** Entry to write, or null when the server was removed. */
  native: Record<string, unknown> | null
  at: number
}

/** Changes made while Desktop was running: file → name → change. Re-applied after it quits (if still recent). */
const pending = new Map<string, Map<string, PendingChange>>()
const PENDING_MAX_AGE_MS = 30 * 60 * 1000

function remember(files: string[], name: string, native: Record<string, unknown> | null): void {
  for (const file of files) {
    const entries = pending.get(file) ?? new Map<string, PendingChange>()
    entries.set(name, { native, at: Date.now() })
    pending.set(file, entries)
  }
}

/** True when changes made while Desktop was running are waiting for a restart. */
export function hasPendingDesktopChanges(): boolean {
  return pending.size > 0
}

/**
 * Re-apply changes Claude Desktop may have overwritten from memory (call after it has quit, before relaunch).
 * Backs the file up first; skips files that can't be read.
 */
export async function reapplyPendingDesktopChanges(ctx: CoreContext): Promise<void> {
  const work = [...pending.entries()]
  pending.clear()
  for (const [file, entries] of work) {
    const doc = await readConfigDoc(file, 'json')
    if (!doc.valid) continue
    const servers = getMap(doc.data, ['mcpServers'])
    const edits: DocEdit[] = []
    const remaining = new Set(Object.keys(servers))
    for (const [name, { native, at }] of entries) {
      if (Date.now() - at > PENDING_MAX_AGE_MS) continue
      const current = getAt(doc.data, ['mcpServers', name])
      if (native && !jsonEqual(current, native)) {
        edits.push({ path: ['mcpServers', name], value: native })
        remaining.add(name)
      } else if (!native && current !== undefined) {
        edits.push({ path: ['mcpServers', name], value: undefined })
        remaining.delete(name)
      }
    }
    if (!edits.length) continue
    try {
      await ctx.backups.snapshot('Re-apply MCP server changes after Claude Desktop quit', [file])
      await editConfigDoc(file, 'json', remaining.size ? edits : [{ path: ['mcpServers'], value: {} }], { createMode: 0o600 })
      ctx.log.info('targets', `Re-applied ${edits.length} Claude Desktop change(s) to ${file}`)
    } catch (err) {
      ctx.log.warn('targets', `Could not re-apply Claude Desktop changes to ${file}: ${(err as Error).message}`)
    }
  }
}

function invalidFileMessage(file: string, error: string): string {
  return (
    `Claude Desktop's settings file (${file}) has a mistake in it: ${error} ` +
    'Claude Desktop ignores all of its servers until this is fixed, so nothing was changed. Open the Doctor to repair it, or restore a backup.'
  )
}

/** The Claude Desktop TargetAdapter. */
export function createClaudeDesktopAdapter(ctx: CoreContext): TargetAdapter {
  const locations = async (): Promise<Location[]> => {
    const loc = await resolveDesktopConfig()
    const out: Location[] = [{ file: loc.configPath, format: 'json', mapPaths: [['mcpServers']], createMode: 0o600 }]
    if (loc.threePConfigPath) out.push({ file: loc.threePConfigPath, format: 'json', mapPaths: [['mcpServers']], createMode: 0o600 })
    return out
  }

  return createFileAdapter(ctx, {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    description: 'The Claude desktop app. Runs local servers; remote servers connect through a small bridge.',
    primary: true,
    supportsRemote: false,
    locations,
    toNative: desktopToNative,
    fromNative: desktopFromNative,
    prepare: (config) => prepareDesktopConfig(config),
    supports(config) {
      if (isRemoteConfig(config)) {
        return {
          ok: true,
          bridged: true,
          reason:
            "Claude Desktop's config file only runs local servers, " +
            'so this remote server connects through the mcp-remote bridge (needs Node.js).'
        }
      }
      if (config.cwd) {
        return { ok: true, reason: 'Claude Desktop ignores the working folder (cwd) setting, so the server starts in its default folder.' }
      }
      return { ok: true }
    },
    validateEntry(name, native) {
      if (!SERVER_NAME_RE.test(name)) return `"${name}" can't be used as a Claude Desktop server name. Use only letters, numbers, "-" and "_".`
      const problems = desktopEntryProblems(native)
      return problems.length ? `Claude Desktop would skip this server: ${problems.join('; ')}.` : null
    },
    async afterChange(change) {
      if (!(await isDesktopRunning())) return {}
      remember(change.files, change.name, change.kind === 'add' ? (change.native ?? null) : null)
      return {
        needsRestart: true,
        note: 'Claude Desktop is running, so restart it to load the change (changing Desktop settings before restarting can undo it).'
      }
    },
    invalidFileMessage,
    snippetWrapper: (_ref, name, native) => ({ mcpServers: { [name]: native } }),
    async info({ summarize }): Promise<TargetInfo> {
      const ref: NormalizedRef = { target: 'claude-desktop', scope: 'user' }
      const [install, loc, running, summary] = await Promise.all([
        detectDesktopInstall(),
        resolveDesktopConfig(),
        isDesktopRunning(),
        summarize(ref)
      ])
      const notes: string[] = []
      if (!install.installed) {
        notes.push("Claude Desktop isn't installed. Get it from claude.com/download — servers you add now are ready when you install it.")
      }
      if (!summary.configValid) {
        notes.push(
          `The settings file has a mistake (${summary.configError}), so Claude Desktop is ignoring all servers. Open the Doctor or restore a backup.`
        )
      }
      if (install.kind === 'msix' && /[\\/]LocalCache[\\/]/i.test(loc.configPath)) {
        notes.push('Installed as a Microsoft Store (MSIX) app: its real settings file is inside the app package folder shown above.')
      }
      for (const copy of loc.otherCopies) notes.push(`Another copy of the settings file exists at ${copy}. Claude Desktop ignores that copy.`)
      if (loc.threePConfigPath) notes.push(`Third-party inference (3P) mode is set up, so servers are also written to ${loc.threePConfigPath}.`)
      const invalid = invalidDesktopEntries(summary.servers)
      if (invalid.length) notes.push(`Claude Desktop skips these entries because they aren't valid: ${invalid.join(', ')}.`)
      if (running) notes.push('Claude Desktop is running. Restart it after making changes so it loads them.')
      notes.push('Remote servers are added through the mcp-remote bridge, which needs Node.js.')
      const info: TargetInfo = {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        description: 'The Claude desktop app. Runs local servers; remote servers connect through a small bridge.',
        installed: install.installed,
        configPath: loc.configPath,
        configExists: summary.configExists,
        configValid: summary.configValid,
        running,
        supportsRemote: false,
        scopes: ['user'],
        serverCount: Object.keys(summary.servers).length - invalid.length,
        notes,
        primary: true
      }
      if (install.version) info.version = install.version
      if (summary.configError) info.configError = summary.configError
      return info
    }
  })
}
