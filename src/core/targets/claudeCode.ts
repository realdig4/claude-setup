/**
 * Claude Code target — the CLI, and the Claude Code extensions for VS Code / JetBrains (they use the same files).
 *   user:    ~/.claude.json → mcpServers                                   (all projects)
 *   local:   ~/.claude.json → projects[<project key>].mcpServers           (only you, one project)
 *   project: <project>/.mcp.json → mcpServers                              (shared, committed)
 *
 * Project keys are absolute paths with forward slashes and the drive-letter case preserved; Claude Code's lookup
 * is case-sensitive and VS Code often opens folders as "c:/…", so on Windows both casings are written. Inside a
 * git repository Claude Code keys local servers by the repository root.
 * Claude Code rewrites ~/.claude.json often: writes are read-modify-write, verified and retried once.
 * An enterprise managed-mcp.json takes exclusive control of MCP — writes are refused then.
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ServerConfig, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, pathExists } from '../fs/json'
import { claudeJsonPath, homeDir, managedClaudeCodeDir, projectKey, projectKeyVariants } from '../platform/paths'
import type { NormalizedRef, TargetAdapter } from './adapter'
import { parseRemoteEntry, parseStdioEntry, stdioNative } from './entries'
import { createFileAdapter, type Location } from './fileAdapter'
import { compareVersions } from './desktopPaths'
import { safeDetectRuntime, safeFindClaudeCli } from './sys'
import { isClaudeCodeReserved, isRemoteConfig } from './validate'

/** Native Claude Code entry, matching what `claude mcp add-json` writes. */
export function claudeCodeToNative(config: ServerConfig): Record<string, unknown> {
  if (isRemoteConfig(config)) {
    const out: Record<string, unknown> = { type: config.type, url: config.url }
    if (config.headers && Object.keys(config.headers).length) out.headers = { ...config.headers }
    return out
  }
  return stdioNative(config, { withType: true, alwaysEnv: true, withCwd: true })
}

/** Claude Code entry → ServerConfig (ws / sdk / malformed entries → null). */
export function claudeCodeFromNative(entry: unknown): ServerConfig | null {
  if (!isPlainObject(entry)) return null
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined
  if (!type || type === 'stdio') return parseStdioEntry(entry)
  if (type === 'http' || type === 'streamable-http' || type === 'sse') return parseRemoteEntry(entry)
  return null
}

/** Nearest folder at or above `dir` containing .git (a folder, or a file for worktrees/submodules). */
export async function findGitRoot(dir: string): Promise<string | null> {
  let cur = dir
  for (;;) {
    if (await pathExists(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

export function managedMcpPath(): string {
  return join(managedClaudeCodeDir(), 'managed-mcp.json')
}

export interface ClaudeCodeExtension {
  editor: string
  version: string
  dir: string
}

const EXTENSION_ROOTS: Array<{ editor: string; dir: string[] }> = [
  { editor: 'VS Code', dir: ['.vscode', 'extensions'] },
  { editor: 'VS Code Insiders', dir: ['.vscode-insiders', 'extensions'] },
  { editor: 'Cursor', dir: ['.cursor', 'extensions'] },
  { editor: 'Windsurf', dir: ['.windsurf', 'extensions'] },
  { editor: 'Devin Desktop', dir: ['.devin', 'extensions'] },
  { editor: 'VSCodium', dir: ['.vscode-oss', 'extensions'] }
]

/** Installed copies of the Claude Code editor extension (newest per editor). */
export async function findClaudeCodeExtensions(): Promise<ClaudeCodeExtension[]> {
  const out: ClaudeCodeExtension[] = []
  for (const root of EXTENSION_ROOTS) {
    const base = join(homeDir(), ...root.dir)
    let names: string[]
    try {
      names = await readdir(base)
    } catch {
      continue
    }
    const versions = names
      .map((n) => ({ n, m: /^anthropic\.claude-code-(\d+\.\d+\.\d+)/i.exec(n) }))
      .filter((x): x is { n: string; m: RegExpExecArray } => !!x.m)
      .sort((a, b) => compareVersions(b.m[1], a.m[1]))
    for (const v of versions) {
      try {
        if ((await stat(join(base, v.n))).isDirectory()) {
          out.push({ editor: root.editor, version: v.m[1], dir: join(base, v.n) })
          break
        }
      } catch {
        // ignore
      }
    }
  }
  return out
}

async function locations(ref: NormalizedRef): Promise<Location[]> {
  if (ref.scope === 'project' && ref.projectPath) {
    return [{ file: join(ref.projectPath, '.mcp.json'), format: 'json', mapPaths: [['mcpServers']] }]
  }
  if (ref.scope === 'local' && ref.projectPath) {
    const root = (await findGitRoot(ref.projectPath)) ?? ref.projectPath
    const writeKeys = projectKeyVariants(root)
    const readKeys = [...new Set([...writeKeys, ...projectKeyVariants(ref.projectPath)])]
    return [
      {
        file: claudeJsonPath(),
        format: 'json',
        mapPaths: readKeys.map((k) => ['projects', k, 'mcpServers']),
        writeMapPaths: writeKeys.map((k) => ['projects', k, 'mcpServers']),
        createMode: 0o600
      }
    ]
  }
  return [{ file: claudeJsonPath(), format: 'json', mapPaths: [['mcpServers']], createMode: 0o600 }]
}

const DESCRIPTION = 'Claude Code in the terminal. The Claude Code extensions for VS Code and JetBrains use the same servers.'

/** The Claude Code TargetAdapter. */
export function createClaudeCodeAdapter(ctx: CoreContext): TargetAdapter {
  return createFileAdapter(ctx, {
    id: 'claude-code',
    label: 'Claude Code',
    description: DESCRIPTION,
    primary: true,
    supportsRemote: true,
    verifyWrites: true,
    locations,
    toNative: claudeCodeToNative,
    fromNative: claudeCodeFromNative,
    supports: () => ({ ok: true }),
    validateEntry: (name) =>
      isClaudeCodeReserved(name) ? `Claude Code reserves the name "${name}" for a built-in server. Choose another name.` : null,
    async writeBlocker() {
      if (await pathExists(managedMcpPath())) {
        return (
          `Your organization manages Claude Code's MCP servers (${managedMcpPath()}), ` +
          "so servers can't be added or removed here. Ask your IT admin."
        )
      }
      return null
    },
    invalidFileMessage: (file, error) =>
      `Claude Code's settings file (${file}) can't be read: ${error} Nothing was changed. ` +
      'Claude Code keeps automatic backups in ~/.claude/backups — open the Doctor or restore a backup.',
    addedHint: (ref) =>
      ref.scope === 'project'
        ? 'Claude Code asks you to approve it the first time you open this project.'
        : 'Start a new Claude Code session (or run /mcp) to use it.',
    snippetWrapper(ref, name, native) {
      if (ref.scope === 'local' && ref.projectPath) return { projects: { [projectKey(ref.projectPath)]: { mcpServers: { [name]: native } } } }
      return { mcpServers: { [name]: native } }
    },
    async info({ summarize }): Promise<TargetInfo> {
      const [runtime, extensions, managed, summary] = await Promise.all([
        safeDetectRuntime('claude'),
        findClaudeCodeExtensions(),
        pathExists(managedMcpPath()),
        summarize({ target: 'claude-code', scope: 'user' })
      ])
      const cliPath = runtime?.found ? runtime.path : runtime ? null : await safeFindClaudeCli()
      const cliFound = !!(runtime?.found || cliPath)
      const notes: string[] = []
      if (!cliFound && extensions.length) {
        notes.push(`The Claude Code extension for ${extensions[0].editor} includes its own copy of Claude Code, so these servers work there.`)
      } else if (!cliFound) {
        notes.push("Claude Code isn't installed yet. Servers you add now are ready when you install it.")
      }
      for (const ext of extensions) notes.push(`Also used by the Claude Code extension for ${ext.editor} (${ext.version}).`)
      notes.push('Also used by the Claude Code extensions for VS Code and JetBrains.')
      if (managed) notes.push(`Your organization manages Claude Code's MCP servers (${managedMcpPath()}), so they can't be changed here.`)
      if (!summary.configValid) {
        notes.push(`The settings file can't be read (${summary.configError}). Claude Code keeps backups in ~/.claude/backups.`)
      }
      notes.push('Project servers (.mcp.json) are shared with everyone using the project; Claude Code asks before it uses them.')
      const info: TargetInfo = {
        id: 'claude-code',
        label: 'Claude Code',
        description: DESCRIPTION,
        installed: cliFound || extensions.length > 0,
        configPath: summary.configPath,
        configExists: summary.configExists,
        configValid: summary.configValid,
        supportsRemote: true,
        scopes: ['user', 'project', 'local'],
        serverCount: summary.serverCount,
        notes,
        primary: true
      }
      const version = runtime?.found ? runtime.version : extensions[0]?.version
      if (version) info.version = version
      if (summary.configError) info.configError = summary.configError
      return info
    }
  })
}
