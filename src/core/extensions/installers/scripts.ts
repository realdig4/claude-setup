/**
 * Scripts that hooks and status lines run, e.g. `python3 .claude/hooks/check.py`.
 * Where they come from (aitmpl conventions, verified against the repo):
 *   - `supportingFiles: [{ source, destination, executable }]` in the JSON (source is relative to the JSON's folder);
 *   - otherwise a file with the referenced name next to the JSON (".claude/scripts/context-monitor.py" ↔ settings/statusline/context-monitor.py).
 * Where they go: ".claude/…" → ~/.claude/… for user scope, <project>/.claude/… for project/local scope;
 * "~/.claude/…" / "$HOME/.claude/…" → always the home folder. For user scope the commands are pointed at ~/.claude.
 */
import { join, posix } from 'node:path'
import { isPlainObject } from '../../fs/json'
import { run, which } from '../../platform/exec'
import { claudeConfigDir, homeDir } from '../../platform/paths'
import { isSafeRelativePath } from '../ids'
import { lstatSafe, toPosix } from '../util'
import { joinWords, type Target } from './common'

export interface ScriptFile {
  /** Path of the source inside the repo. */
  repoPath: string
  /** Absolute destination. */
  dest: string
  /** "hooks/x.py" — the part after ".claude/". */
  rel: string
  /** Destination is in the home folder (~/.claude/…) regardless of scope. */
  home: boolean
  executable: boolean
  /** Listed in supportingFiles (must exist) vs guessed from a command (skipped when absent). */
  required: boolean
}

export interface ScriptPlan {
  files: ScriptFile[]
  /** Referenced scripts that nothing provides: shown as warnings. */
  unresolved: Array<{ rel: string; home: boolean }>
  warnings: string[]
}

const SCRIPT_REF_RE = /(~\/|\$HOME\/|\$\{HOME\}\/)?\.claude\/((?:[\w.-]+\/)*[\w.-]+\.(?:py|sh|bash|js|mjs|cjs|ts|ps1|rb|pl))\b/g

/** Script references in commands: { rel: "hooks/x.py", home: false }. */
export function scriptRefs(commands: string[]): Array<{ rel: string; home: boolean }> {
  const out = new Map<string, { rel: string; home: boolean }>()
  for (const c of commands) {
    for (const m of c.matchAll(SCRIPT_REF_RE)) {
      const rel = m[2]
      if (!isSafeRelativePath(rel)) continue
      const home = !!m[1]
      out.set(`${home ? '~' : ''}${rel}`, { rel, home })
    }
  }
  return [...out.values()]
}

/** Absolute destination of ".claude/<rel>" for a target. */
export function scriptDest(rel: string, home: boolean, target: Target): string {
  const parts = rel.split('/')
  if (home) return join(homeDir(), '.claude', ...parts)
  if (target.scope === 'user' || !target.projectPath) return join(claudeConfigDir(), ...parts)
  return join(target.projectPath, '.claude', ...parts)
}

/** Work out which script files to download and where they go. */
export function planScripts(fragment: Record<string, unknown>, commands: string[], jsonRepoPath: string, target: Target): ScriptPlan {
  const jsonDir = posix.dirname(jsonRepoPath)
  const files: ScriptFile[] = []
  const warnings: string[] = []
  const byDest = new Set<string>()
  const add = (f: ScriptFile) => {
    const k = f.dest.toLowerCase()
    if (byDest.has(k)) return
    byDest.add(k)
    files.push(f)
  }
  const supporting = Array.isArray(fragment.supportingFiles) ? fragment.supportingFiles : []
  for (const entry of supporting) {
    if (!isPlainObject(entry) || typeof entry.source !== 'string' || typeof entry.destination !== 'string') continue
    const source = entry.source.replace(/^\.\/+/, '')
    const m = /^(~\/|\$HOME\/|\$\{HOME\}\/)?(?:\.\/)?\.claude\/(.+)$/.exec(entry.destination.trim())
    if (!isSafeRelativePath(source) || !m || !isSafeRelativePath(m[2])) {
      warnings.push(`Skipped the extra file "${entry.destination}" because it would be saved outside a .claude folder.`)
      continue
    }
    const repoPath = posix.normalize(`${jsonDir}/${source}`)
    if (!isSafeRelativePath(repoPath)) continue
    add({ repoPath, dest: scriptDest(m[2], !!m[1], target), rel: m[2], home: !!m[1], executable: entry.executable === true, required: true })
  }
  const unresolved: Array<{ rel: string; home: boolean }> = []
  for (const ref of scriptRefs(commands)) {
    const dest = scriptDest(ref.rel, ref.home, target)
    if (byDest.has(dest.toLowerCase())) continue
    const name = ref.rel.slice(ref.rel.lastIndexOf('/') + 1)
    if (!name) {
      unresolved.push(ref)
      continue
    }
    add({ repoPath: `${jsonDir}/${name}`, dest, rel: ref.rel, home: ref.home, executable: /\.(sh|bash|py|rb|pl)$/.test(name), required: false })
  }
  return { files, unresolved, warnings }
}

type QuoteState = 'none' | 'single' | 'double'

/** Shell quoting state at `index` of a command string. */
export function quoteStateAt(command: string, index: number): QuoteState {
  let state: QuoteState = 'none'
  for (let i = 0; i < index && i < command.length; i++) {
    const ch = command[i]
    if (state !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (state === 'none' && ch === "'") state = 'single'
    else if (state === 'single' && ch === "'") state = 'none'
    else if (state === 'none' && ch === '"') state = 'double'
    else if (state === 'double' && ch === '"') state = 'none'
  }
  return state
}

/**
 * Base folder written into user-scope commands: "$HOME/.claude" (works in Git Bash, bash/zsh and PowerShell),
 * or the absolute $CLAUDE_CONFIG_DIR when that is set (escaped for use inside double quotes).
 */
export function userScriptBase(): string {
  if (!process.env.CLAUDE_CONFIG_DIR) return '$HOME/.claude'
  return toPosix(claudeConfigDir()).replace(/(["$`\\])/g, '\\$1')
}

const PROJECT_REF_RE = /("\$\{?CLAUDE_PROJECT_DIR\}?"\/|\$\{?CLAUDE_PROJECT_DIR\}?\/|(?<![\w~$}./-]))\.claude\/((?:[\w.-]+\/)*[\w.-]+)/g

/**
 * Point project-relative script paths (".claude/hooks/x.py", "$CLAUDE_PROJECT_DIR/.claude/…") at `base`
 * for the scripts listed in `rels`. The result is always one fully quoted word ("$HOME/.claude/hooks/x.py"):
 * paths with spaces keep working, and PowerShell (Claude Code's fallback shell on Windows) does not split it
 * the way it splits "a"/b.
 */
export function rewriteForUserScope(command: string, base: string, rels: ReadonlySet<string>): string {
  return command.replace(PROJECT_REF_RE, (match: string, prefix: string, rel: string, offset: number) => {
    if (!rels.has(rel)) return match
    if (prefix.startsWith('"')) return `"${base}/${rel}"`
    return quoteStateAt(command, offset) === 'double' ? `${base}/${rel}` : `"${base}/${rel}"`
  })
}

/** "python" / "python3" used as a command word (not inside a path such as /usr/bin/python3). */
const PYTHON_WORD_RE = /(?<![\w./\\-])python3?(?=\s)/g

/** True when a command runs Python. */
export function usesPython(commands: string[]): boolean {
  return commands.some((c) => new RegExp(PYTHON_WORD_RE.source).test(c))
}

/**
 * Windows: "python3 …" usually opens the Microsoft Store stub instead of Python, so it is replaced with the
 * command that really starts Python 3 here (`python`, or the `py -3` launcher when that is all there is).
 */
export function adaptForPlatform(command: string, platform: string = process.platform, python = 'python'): string {
  if (platform !== 'win32') return command
  return command.replace(PYTHON_WORD_RE, (word) => (python === 'python' && word === 'python' ? word : python))
}

let pythonProbe: { at: number; result: Promise<string | null> } | undefined

/** Windows: "python" or "py -3" — whichever really starts Python 3 — or null when neither does (cached 5 minutes). */
export function windowsPython(): Promise<string | null> {
  if (pythonProbe && Date.now() - pythonProbe.at < 5 * 60 * 1000) return pythonProbe.result
  const result = (async () => {
    for (const [cmd, args] of [
      ['python', []],
      ['py', ['-3']]
    ] as const) {
      try {
        const r = await run(cmd, [...args, '--version'], { timeoutMs: 8000 })
        // The Store stub prints "Python was not found…" and exits with 9009.
        if (r?.ok && /Python\s+3\.\d+/i.test(`${r.stdout}\n${r.stderr}`)) return [cmd, ...args].join(' ')
      } catch {
        // try the next one
      }
    }
    return null
  })()
  pythonProbe = { at: Date.now(), result }
  return result
}

const TOOL_PATTERNS: Array<{ tool: string; re: RegExp }> = [
  { tool: 'jq', re: /(^|[\s|;&(`'"])jq\s/ },
  { tool: 'python', re: /(^|[\s|;&(`'"])python3?\s/ },
  { tool: 'node', re: /(^|[\s|;&(`'"])node\s/ },
  { tool: 'npx', re: /(^|[\s|;&(`'"])npx\s/ },
  { tool: 'bun', re: /(^|[\s|;&(`'"])bunx?\s/ },
  { tool: 'uv', re: /(^|[\s|;&(`'"])uvx?\s/ },
  { tool: 'curl', re: /(^|[\s|;&(`'"])curl\s/ }
]

/** which() that never throws (also when it fails synchronously). */
async function safeWhich(command: string): Promise<string | null> {
  try {
    return await which(command)
  } catch {
    return null
  }
}

/** Tools the commands call that are not on PATH (best effort), as a warning sentence list. */
export async function missingToolWarnings(commands: string[], platform: string = process.platform): Promise<string[]> {
  const needed = new Set<string>()
  for (const c of commands) for (const { tool, re } of TOOL_PATTERNS) if (re.test(c)) needed.add(tool)
  const missing: string[] = []
  for (const tool of needed) {
    if (tool === 'python' && platform === 'win32') {
      // which() would happily find the Microsoft Store stub; ask Python itself.
      if (!(await windowsPython())) missing.push('Python')
      continue
    }
    const candidates = tool === 'python' ? ['python3', 'python'] : [tool]
    let found = false
    for (const c of candidates) {
      if (await safeWhich(c)) {
        found = true
        break
      }
    }
    if (!found) missing.push(tool === 'python' ? 'Python' : tool)
  }
  const out: string[] = []
  if (missing.length) {
    const one = missing.length === 1
    out.push(`It uses ${joinWords(missing)}, which ${one ? "isn't" : "aren't"} installed (or not on PATH) — it won't work until ${one ? 'it is' : 'they are'} installed.`)
  }
  if (platform === 'win32' && commands.length && !(await safeWhich('git'))) {
    out.push('On Windows, Claude Code runs these commands with Git Bash. Install Git for Windows (git-scm.com) so they can run.')
  }
  return out
}

/** Warnings for referenced scripts nobody provides (and that don't already exist). */
export async function unresolvedWarnings(unresolved: Array<{ rel: string; home: boolean }>, target: Target): Promise<string[]> {
  const out: string[] = []
  for (const u of unresolved) {
    const dest = scriptDest(u.rel, u.home, target)
    if (await lstatSafe(dest)) continue
    out.push(`It runs ${u.home ? '~/' : ''}.claude/${u.rel}, which isn't included — you need to create that script yourself.`)
  }
  return out
}
