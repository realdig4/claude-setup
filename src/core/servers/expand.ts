/**
 * Resolve the variable syntax each app supports inside server configs, so "Test" runs the server the way that app
 * would. Unresolvable references (e.g. VS Code ${input:…} prompts) are reported.
 *   claude-code: ${VAR}, ${VAR:-default}, ${CLAUDE_PROJECT_DIR}
 *   cursor / vscode: ${env:VAR}, ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename}, ${pathSeparator}, ${/}
 *   windsurf / Devin: ${env:VAR}, ${file:/path}
 *   claude-desktop: only ${PATH} inside env.PATH (handled by the tester)
 */
import { readFile } from 'node:fs/promises'
import { basename, sep } from 'node:path'
import type { ServerConfig, TargetId } from '@shared/types'
import { expandHome, homeDir } from '../platform/paths'
import { isRemoteConfig } from '../targets/validate'

export interface ExpandResult {
  config: ServerConfig
  /** References that could not be resolved (left as written). */
  unresolved: string[]
}

type Replacer = (text: string) => Promise<string>

const VSCODE_VARS = /\$\{(env:([A-Za-z_][A-Za-z0-9_]*)|userHome|workspaceFolder|workspaceFolderBasename|pathSeparator|\/|input:([^}]+))\}/g

/** String.replace with an async replacer; a null result keeps the original text. */
async function replaceAsync(text: string, re: RegExp, fn: (...m: string[]) => Promise<string | null>): Promise<string> {
  const matches = [...text.matchAll(re)]
  if (!matches.length) return text
  const values = await Promise.all(matches.map((m) => fn(...(m as unknown as string[]))))
  let out = ''
  let last = 0
  matches.forEach((m, i) => {
    out += text.slice(last, m.index) + (values[i] ?? m[0])
    last = (m.index ?? 0) + m[0].length
  })
  return out + text.slice(last)
}

/** Expand a config for the given target. */
export async function expandForTarget(config: ServerConfig, target: TargetId, projectPath?: string): Promise<ExpandResult> {
  const unresolved = new Set<string>()
  const workspace = projectPath ?? process.cwd()
  const env = process.env

  const vscodeLike: Replacer = (text) =>
    replaceAsync(text, VSCODE_VARS, async (whole, kind, envName, inputId) => {
      if (envName) return env[envName] ?? ''
      if (inputId) {
        unresolved.add(whole)
        return null
      }
      if (kind === 'userHome') return homeDir()
      if (kind === 'workspaceFolder') return workspace
      if (kind === 'workspaceFolderBasename') return basename(workspace)
      return sep
    })

  const windsurf: Replacer = (text) =>
    replaceAsync(text, /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|file:([^}]+))\}/g, async (whole, envName, file) => {
      if (envName) return env[envName] ?? ''
      try {
        return (await readFile(expandHome(file.trim()), 'utf8')).trim()
      } catch {
        unresolved.add(whole)
        return null
      }
    })

  const claudeCode: Replacer = (text) =>
    replaceAsync(text, /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, async (whole, name, fallback) => {
      if (name === 'CLAUDE_PROJECT_DIR') return env.CLAUDE_PROJECT_DIR ?? workspace
      const v = env[name]
      if (v !== undefined && v !== '') return v
      if (fallback !== undefined) return fallback
      unresolved.add(whole)
      return null
    })

  const replacers: Partial<Record<TargetId, Replacer>> = { 'claude-code': claudeCode, cursor: vscodeLike, vscode: vscodeLike, windsurf }
  const replacer = replacers[target]
  if (!replacer) return { config, unresolved: [] }

  const mapRecord = async (rec?: Record<string, string>) => {
    if (!rec) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = await replacer(v)
    return out
  }
  if (isRemoteConfig(config)) {
    const out: ServerConfig = { type: config.type, url: await replacer(config.url) }
    const headers = await mapRecord(config.headers)
    if (headers) out.headers = headers
    return { config: out, unresolved: [...unresolved] }
  }
  const out: ServerConfig = { type: 'stdio', command: await replacer(config.command) }
  if (config.args) out.args = await Promise.all(config.args.map(replacer))
  const envOut = await mapRecord(config.env)
  if (envOut) out.env = envOut
  if (config.cwd) out.cwd = await replacer(config.cwd)
  return { config: out, unresolved: [...unresolved] }
}
