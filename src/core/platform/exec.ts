/**
 * Process helpers. CONTRACT (owned by FOUNDATION) — implement the bodies, keep the signatures.
 * - Always spawn through cross-spawn (handles npx/.cmd shims on Windows), never a shell.
 * - Strip ELECTRON_RUN_AS_NODE and NODE_OPTIONS from child environments.
 *
 * Windows details: commands are resolved here first (PATH + PATHEXT of the child environment).
 * - .exe/.com (including App Execution Aliases such as WindowsApps\winget.exe) are started directly:
 *   cross-spawn cannot stat() aliases and would report a false ENOENT when they exit with code 1.
 * - .cmd/.bat shims (npx.cmd, npm globals, code.cmd) run through cmd.exe with cross-spawn's escaping
 *   applied twice, because the shim re-parses its arguments when it forwards them with %*.
 * - Anything else (not found, extensionless scripts) is left to cross-spawn.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { access, constants as fsConstants, lstat, readdir, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { delimiter, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import crossSpawn from 'cross-spawn'
import { homeDir, localDir, roamingDir } from './paths'

export interface RunOptions {
  cwd?: string
  /** Merged over cleanEnv(); a value of undefined removes the variable. */
  env?: Record<string, string | undefined>
  /** Default 30000 ms. Kills the process tree on timeout. 0 disables the timeout. */
  timeoutMs?: number
  /** Written to stdin, then stdin is closed. */
  input?: string
  /** Live output as decoded UTF-8 chunks (e.g. for progress messages). Output is still collected in the result. */
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
}

export interface RunResult {
  /** code === 0 and not timed out */
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn error (e.g. ENOENT) */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
/** Bytes kept per output stream; anything beyond is dropped. */
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024
/** After the process exits, how long to wait for its pipes to close (grandchildren may keep them open). */
const CLOSE_GRACE_MS = 2_000
/** Variables that make Electron binaries behave as plain Node, or inject flags into every Node child. */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']
/** Extensions that can be launched on Windows (PATHEXT also lists .js/.vbs/… which must not match). */
const WINDOWS_EXECUTABLE_EXTS = ['.com', '.exe', '.bat', '.cmd']
const WINDOWS_BATCH_EXTS = ['.bat', '.cmd']
/** cmd.exe metacharacters (same set as cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
const SHELL_ENV_DELIMITER = '__CLAUDE_SETUP_SHELL_ENV__'

type Env = Record<string, string | undefined>

const isWindows = (): boolean => process.platform === 'win32'

// ─────────────────────────────────────────────────────────────────────────────
// Resolving executables
// ─────────────────────────────────────────────────────────────────────────────

/** Name of the PATH variable in `env` (Windows GUI processes use "Path"). */
function pathKey(env: Env = process.env): string {
  if (!isWindows()) return 'PATH'
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
}

/** Value of `name` in `env`, case-insensitively on Windows. */
function envValue(env: Env, name: string): string | undefined {
  if (!isWindows()) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

function splitPathList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(delimiter)
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function windowsExtensions(env: Env): string[] {
  const listed = (envValue(env, 'PATHEXT') ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => WINDOWS_EXECUTABLE_EXTS.includes(e))
  return listed.length ? [...new Set(listed)] : WINDOWS_EXECUTABLE_EXTS
}

/** File names to try for `command` (PATHEXT-aware on Windows). */
function candidateNames(command: string, env: Env): string[] {
  if (!isWindows()) return [command]
  if (WINDOWS_EXECUTABLE_EXTS.includes(extname(command).toLowerCase())) return [command]
  return windowsExtensions(env).map((ext) => command + ext)
}

function looksLikePath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || (isWindows() && command.includes('\\'))
}

/**
 * True when `path` is an existing file that can be executed (POSIX: X_OK). Windows App Execution
 * Aliases (…\WindowsApps\winget.exe, python.exe) cannot be stat()ed but are reported as present.
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (isWindows()) return true
    await access(path, fsConstants.X_OK)
    return true
  } catch (err) {
    if (isWindows() && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        const link = await lstat(path)
        return link.isSymbolicLink() || link.isFile()
      } catch {
        return false
      }
    }
    return false
  }
}

/** All matches for `command` in the PATH of `env` (path-like commands: resolved against `cwd`). */
async function searchExecutables(command: string, env: Env, cwd: string | undefined, firstOnly: boolean): Promise<string[]> {
  if (typeof command !== 'string' || !command.trim()) return []
  const cmd = command.trim()
  const base = cwd ?? process.cwd()
  const names = candidateNames(cmd, env)
  if (looksLikePath(cmd)) {
    for (const name of names) {
      const full = resolve(base, name)
      if (await isExecutable(full)) return [full]
    }
    return []
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const dir of splitPathList(env[pathKey(env)])) {
    for (const name of names) {
      const full = resolve(base, dir, name)
      const key = isWindows() ? full.toLowerCase() : full
      if (seen.has(key)) continue
      seen.add(key)
      if (await isExecutable(full)) {
        found.push(full)
        if (firstOnly) return found
      }
    }
  }
  return found
}

/** Every match for `command` on PATH, in PATH order (useful to spot shadowed binaries). */
export async function whichAll(command: string): Promise<string[]> {
  return searchExecutables(command, process.env, undefined, false)
}

/** Resolve an executable on PATH (PATHEXT-aware on Windows). Returns absolute path or null. */
export async function which(command: string): Promise<string | null> {
  return (await searchExecutables(command, process.env, undefined, true))[0] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawning
// ─────────────────────────────────────────────────────────────────────────────

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1')
}

/** cross-spawn's argument quoting for cmd.exe (https://qntm.org/cmd), escaped twice for %*-forwarding shims. */
function escapeCmdArgument(arg: string): string {
  let escaped = `${arg}`
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1')
  escaped = `"${escaped}"`
  escaped = escaped.replace(CMD_META, '^$1')
  return escaped.replace(CMD_META, '^$1')
}

function comspec(env: Env): string {
  return envValue(env, 'ComSpec') || join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe')
}

interface LaunchPlan {
  file: string
  args: string[]
  options: SpawnOptions
  /** true: child_process.spawn as-is; false: let cross-spawn resolve and wrap the command. */
  direct: boolean
}

/** Decide how to start `command` (see the file header for the Windows rules). Never throws. */
async function planLaunch(command: string, args: string[], options: SpawnOptions & { env: Record<string, string> }): Promise<LaunchPlan> {
  if (isWindows()) {
    const cwd = typeof options.cwd === 'string' ? options.cwd : undefined
    const [resolved] = await searchExecutables(command, options.env, cwd, true)
    if (resolved && WINDOWS_BATCH_EXTS.includes(extname(resolved).toLowerCase())) {
      const line = [escapeCmdCommand(normalize(resolved)), ...args.map(escapeCmdArgument)].join(' ')
      const shellOptions = { ...options, windowsVerbatimArguments: true }
      return { file: comspec(options.env), args: ['/d', '/s', '/c', `"${line}"`], options: shellOptions, direct: true }
    }
    if (resolved) return { file: resolved, args, options, direct: true }
  }
  return { file: command, args, options, direct: false }
}

/**
 * Spawn synchronously, so the caller attaches its 'error' listener in the same tick (spawn errors
 * are emitted on the next tick). Throws for invalid arguments, like child_process.spawn.
 */
function launch(plan: LaunchPlan): ChildProcess {
  return plan.direct ? nodeSpawn(plan.file, plan.args, plan.options) : crossSpawn(plan.file, plan.args, plan.options)
}

function failedRun(error: string): RunResult {
  return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error }
}

function describeSpawnError(command: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined
  const code = e?.code
  if (code === 'ENOENT') return `ENOENT: ${command} not found`
  if (code === 'EACCES' || code === 'EPERM') return `${code}: permission denied running ${command}`
  if (code === 'EINVAL') return `EINVAL: ${command} cannot be started (${e?.message ?? 'invalid argument'})`
  return `${code ?? 'ERROR'}: ${e?.message ?? String(err)}`
}

/** Collects one output stream (capped) and forwards decoded chunks to `onOutput`. */
class OutputCollector {
  private readonly chunks: Buffer[] = []
  private size = 0
  private readonly decoder = new StringDecoder('utf8')

  constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly onOutput?: RunOptions['onOutput']
  ) {}

  push(chunk: Buffer): void {
    if (this.size < MAX_OUTPUT_BYTES) {
      const room = MAX_OUTPUT_BYTES - this.size
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      this.chunks.push(part)
      this.size += part.length
    }
    if (this.onOutput) {
      const text = this.decoder.write(chunk)
      if (text) {
        try {
          this.onOutput(text, this.stream)
        } catch {
          // A faulty listener must never break the process run.
        }
      }
    }
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Kill a process and everything it started (Windows: taskkill /T; POSIX: the whole process group). */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (isWindows()) {
    const taskkill = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = nodeSpawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => killChild(child))
      killer.on('exit', (code) => {
        if (code !== 0) killChild(child)
      })
    } catch {
      killChild(child)
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    killChild(child)
  }
}

/**
 * Run a program and collect its output. Never throws for process failures: spawn errors are
 * reported in `error` (e.g. "ENOENT: foo not found"), timeouts in `timedOut` (the whole process
 * tree is killed). Output is decoded as UTF-8 and capped at ~20 MB per stream.
 */
export async function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.cwd !== undefined) {
    const dir = await stat(opts.cwd).catch(() => null)
    if (!dir?.isDirectory()) return failedRun(`Folder not found: ${opts.cwd}`)
  }
  const plan = await planLaunch(command, args, {
    cwd: opts.cwd,
    env: cleanEnv(opts.env),
    shell: false,
    windowsHide: true,
    // Own process group on POSIX so a timeout can kill grandchildren too.
    detached: !isWindows(),
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return new Promise<RunResult>((resolveRun) => {
    let child: ChildProcess
    try {
      child = launch(plan)
    } catch (err) {
      resolveRun(failedRun(describeSpawnError(command, err)))
      return
    }
    const stdout = new OutputCollector('stdout', opts.onOutput)
    const stderr = new OutputCollector('stderr', opts.onOutput)
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let settled = false
    let timedOut = false
    let spawnError: string | undefined
    let exitCode: number | null = null
    let timer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      // Release our end of the pipes so a lingering grandchild cannot keep this process busy.
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      const result: RunResult = {
        ok: !timedOut && !spawnError && code === 0,
        code: spawnError ? null : code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut
      }
      if (spawnError) result.error = spawnError
      resolveRun(result)
    }

    const armGrace = (ms: number): void => {
      if (settled || graceTimer) return
      graceTimer = setTimeout(() => finish(exitCode), ms)
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    // EPIPE when the program exits without reading its input.
    child.stdin?.on('error', () => {})

    child.on('error', (err: NodeJS.ErrnoException) => {
      const isSpawnFailure = typeof err.syscall === 'string' ? err.syscall.startsWith('spawn') : child.pid === undefined
      if (!isSpawnFailure) return // e.g. a failed kill(): the process itself is still running
      spawnError = describeSpawnError(command, err)
      if (child.pid === undefined || exitCode !== null) finish(null)
      else armGrace(CLOSE_GRACE_MS)
    })
    child.on('exit', (code) => {
      exitCode = code
      armGrace(CLOSE_GRACE_MS)
    })
    child.on('close', (code) => finish(code ?? exitCode))

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killTree(child)
        armGrace(CLOSE_GRACE_MS + 1_000)
      }, timeoutMs)
    }

    try {
      if (opts.input !== undefined) child.stdin?.end(opts.input, 'utf8')
      else child.stdin?.end()
    } catch {
      // The process may already have exited.
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell
// ─────────────────────────────────────────────────────────────────────────────

/** Quiet progress, UTF-8 in/out without BOM, no ANSI colors (pwsh 7.2+). Each line is safe on PS 5.1 and 7. */
const POWERSHELL_PREAMBLE = [
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
  'try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
  "try { $PSStyle.OutputRendering = 'PlainText' } catch {}",
  '$OutputEncoding = New-Object System.Text.UTF8Encoding $false'
].join('\n')

async function powerShellExecutable(): Promise<string | null> {
  const pwsh = await which('pwsh')
  if (pwsh) return pwsh
  if (!isWindows()) return null
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const builtIn = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (await isExecutable(builtIn)) return builtIn
  return which('powershell')
}

/**
 * Windows only: run a PowerShell script (-NoProfile -NonInteractive -ExecutionPolicy Bypass).
 * Prefers pwsh.exe (PowerShell 7) when it is on PATH, else Windows PowerShell 5.1.
 * Output is UTF-8. Pass secrets through `opts.input` (read with [Console]::In), never inside the script.
 */
export async function runPowerShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  const exe = await powerShellExecutable()
  if (!exe) return failedRun('ENOENT: PowerShell not found')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${POWERSHELL_PREAMBLE}\n${script}`]
  return run(exe, args, opts)
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH repair
// ─────────────────────────────────────────────────────────────────────────────

function normalizeDirKey(dir: string): string {
  if (isWindows()) return dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir
}

/**
 * Merge PATH lists keeping the first occurrence of every directory (case-insensitive and
 * trailing-slash-insensitive on Windows). Exported for tests.
 * @internal
 */
export function mergePathLists(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const raw of list) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1')
      if (!dir) continue
      const key = normalizeDirKey(dir)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(dir)
    }
  }
  return out
}

async function existingDirs(dirs: string[]): Promise<string[]> {
  const checks = await Promise.all(dirs.map(async (d) => ((await stat(d).catch(() => null))?.isDirectory() ? d : null)))
  return checks.filter((d): d is string => d !== null)
}

function windowsKnownDirs(): string[] {
  const home = homeDir()
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  return [
    join(home, '.local', 'bin'),
    join(roamingDir(), 'npm'),
    join(programFiles, 'nodejs'),
    ...(process.env.NVM_SYMLINK ? [process.env.NVM_SYMLINK] : []),
    join(localDir(), 'Volta', 'bin'),
    join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
    join(localDir(), 'Programs', 'Microsoft VS Code', 'bin'),
    join(localDir(), 'Microsoft', 'WinGet', 'Links'),
    join(localDir(), 'Microsoft', 'WindowsApps'),
    join(programFiles, 'Git', 'cmd'),
    join(home, 'scoop', 'shims'),
    join(home, '.cargo', 'bin')
  ]
}

function compareVersionNames(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** ~/.nvm/versions/node/<newest>/bin, when nvm is installed. */
async function newestNvmBin(): Promise<string[]> {
  const root = join(homeDir(), '.nvm', 'versions', 'node')
  const names = await readdir(root).catch(() => [] as string[])
  const versions = names.filter((n) => /^v?\d+\.\d+\.\d+$/.test(n)).sort(compareVersionNames)
  const newest = versions[versions.length - 1]
  return newest ? [join(root, newest, 'bin')] : []
}

async function posixKnownDirs(): Promise<string[]> {
  const home = homeDir()
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.docker', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/snap/bin',
    ...(await newestNvmBin())
  ]
}

/** Machine + User PATH as stored in the registry (process PATH is stale after installs). */
async function windowsRegistryPath(): Promise<string[]> {
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')"
  const r = await runPowerShell(script, { timeoutMs: 8_000 })
  if (!r.ok) return []
  return r.stdout.split(/\r?\n/).flatMap((line) => splitPathList(line))
}

function loginShell(): string {
  if (process.env.SHELL) return process.env.SHELL
  try {
    const shell = userInfo().shell
    if (shell) return shell
  } catch {
    // No passwd entry.
  }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** PATH of an interactive login shell ($SHELL -ilc env), bounded by a 5 s timeout. */
async function loginShellPath(): Promise<string[]> {
  const d = SHELL_ENV_DELIMITER
  const r = await run(loginShell(), ['-ilc', `echo -n "${d}"; command env; echo -n "${d}"; exit`], {
    timeoutMs: 5_000,
    env: { DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' }
  })
  const body = r.stdout.split(d)[1]
  if (!body) return []
  const line = body.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').find((l) => l.startsWith('PATH='))
  return line ? line.slice(5).trim().split(':').filter(Boolean) : []
}

async function repairPath(): Promise<void> {
  const key = pathKey()
  const current = splitPathList(process.env[key])
  let merged: string[]
  if (isWindows()) {
    const [registry, known] = await Promise.all([windowsRegistryPath(), existingDirs(windowsKnownDirs())])
    merged = mergePathLists(current, registry, known)
  } else {
    const [shellPath, known] = await Promise.all([loginShellPath(), posixKnownDirs().then(existingDirs)])
    // The login shell's order is what the user gets in a terminal, so it wins.
    merged = mergePathLists(shellPath, current, known)
  }
  if (merged.length) process.env[key] = merged.join(delimiter)
}

let fixPathPromise: Promise<void> | null = null

/**
 * Make process.env.PATH complete for GUI-launched apps. Idempotent (runs once).
 * - macOS/Linux: read the login shell env ($SHELL -ilc env) with a 5 s timeout, then
 *   union well-known dirs (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.volta/bin, newest ~/.nvm/versions/node/x/bin, ~/.docker/bin, …).
 * - Windows: re-read Machine+User PATH from the registry (stale after winget installs)
 *   and add %USERPROFILE%\.local\bin, %APPDATA%\npm, C:\Program Files\nodejs, Docker bin.
 * Never throws. CLAUDE_SETUP_SKIP_FIXPATH=1 turns it into a no-op (tests).
 */
export function fixPath(): Promise<void> {
  if (process.env.CLAUDE_SETUP_SKIP_FIXPATH === '1') return Promise.resolve()
  fixPathPromise ??= repairPath().catch(() => {})
  return fixPathPromise
}

/**
 * Run fixPath() again (after installing a runtime, PATH changed in the registry / rc files).
 * @internal
 */
export function refreshPath(): Promise<void> {
  fixPathPromise = null
  return fixPath()
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment & detached launches
// ─────────────────────────────────────────────────────────────────────────────

function removeEnvKey(env: Record<string, string>, name: string): void {
  if (!isWindows()) {
    delete env[name]
    return
  }
  const upper = name.toUpperCase()
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) delete env[key]
}

/**
 * process.env copy (string values only) without ELECTRON_RUN_AS_NODE / NODE_OPTIONS /
 * ELECTRON_NO_ATTACH_CONSOLE, plus `extra` (undefined removes a variable). Keys are matched
 * case-insensitively on Windows so PATH/Path never ends up duplicated.
 */
export function cleanEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
  for (const name of STRIPPED_ENV) removeEnvKey(env, name)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      removeEnvKey(env, key)
      if (typeof value === 'string') env[key] = value
    }
  }
  return env
}

/**
 * Fire-and-forget launch of a GUI program (detached, ignored stdio, cleanEnv). Failures are ignored.
 * The process is started asynchronously, right after this returns.
 */
export function spawnDetached(command: string, args: string[], opts: { cwd?: string } = {}): void {
  planLaunch(command, args, { cwd: opts.cwd, env: cleanEnv(), detached: true, stdio: 'ignore', shell: false })
    .then((plan) => {
      const child = launch(plan)
      child.on('error', () => {})
      child.unref()
    })
    .catch(() => {})
}
