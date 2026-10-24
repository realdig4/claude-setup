/**
 * Runtime detection & installation. CONTRACT (owned by FOUNDATION).
 *
 * Detection: PATH (after fixPath()) plus well-known install locations, then `<tool> --version`
 * with a timeout. Results are cached for 30 s. Installation: winget (Windows), Homebrew
 * (macOS/Linux) or the official installer scripts (uv, Claude Code). Heavy installs that need
 * administrator rights (Docker Desktop) only return the command / download page.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimesApi } from '@shared/api'
import type { OpResult, OS, RuntimeInfo, RuntimeName } from '@shared/types'
import type { CoreContext } from '../context'
import { fixPath, isExecutable, refreshPath, run, runPowerShell, which, whichAll, type RunResult } from './exec'
import { currentOS, homeDir, localDir, roamingDir } from './paths'

const CACHE_TTL_MS = 30_000
const DETECT_TIMEOUT_MS = 8_000
/** claude.exe is ~300 MB and VS Code's CLI boots Electron: allow a little longer, still < 10 s overall. */
const SLOW_DETECT_TIMEOUT_MS = 9_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const MIN_NODE_MAJOR = 20
const MIN_PYTHON = '3.10.0'

interface RuntimeSpec {
  label: string
  purpose: string
}

const SPECS: Record<RuntimeName, RuntimeSpec> = {
  node: { label: 'Node.js', purpose: 'Runs most MCP servers (npx)' },
  npx: { label: 'npx', purpose: 'Starts Node.js MCP servers on demand (comes with Node.js)' },
  uv: { label: 'uv', purpose: 'Installs and runs Python-based MCP servers' },
  uvx: { label: 'uvx', purpose: 'Runs Python MCP servers on demand (comes with uv)' },
  python: { label: 'Python', purpose: 'Needed by some Python-based tools and MCP servers' },
  docker: { label: 'Docker', purpose: 'Runs MCP servers packaged as containers' },
  git: { label: 'Git', purpose: 'Downloads plugins, skills and marketplaces' },
  claude: { label: 'Claude Code', purpose: 'Claude in your terminal and VS Code; manages plugins and MCP servers' },
  code: { label: 'VS Code', purpose: 'Code editor that hosts the Claude Code extension' },
  winget: { label: 'winget', purpose: 'Windows package manager used for one-click installs' },
  brew: { label: 'Homebrew', purpose: 'Package manager used for one-click installs' }
}

const URLS = {
  node: 'https://nodejs.org/en/download',
  uv: 'https://docs.astral.sh/uv/getting-started/installation/',
  python: 'https://www.python.org/downloads/',
  dockerDesktop: 'https://www.docker.com/products/docker-desktop/',
  dockerEngine: 'https://docs.docker.com/engine/install/',
  git: 'https://git-scm.com/downloads',
  claude: 'https://code.claude.com/docs/en/setup',
  code: 'https://code.visualstudio.com/download',
  winget: 'https://aka.ms/getwinget',
  brew: 'https://brew.sh'
} as const

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']

/** Claude Desktop also ships a claude.exe (MSIX/WindowsApps or the old Squirrel install): never treat it as the CLI. */
const DESKTOP_BINARY = /[\\/](WindowsApps|AnthropicClaude)[\\/]|[\\/]Claude\.app[\\/]/i

function isRuntimeName(id: unknown): id is RuntimeName {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPECS, id)
}

/** Runtimes relevant on `os`, in display order (winget on Windows, Homebrew elsewhere). */
export function runtimeIdsFor(os: OS = currentOS()): RuntimeName[] {
  return ['node', 'npx', 'uv', 'uvx', 'python', 'docker', 'git', 'claude', 'code', os === 'win32' ? 'winget' : 'brew']
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function exe(name: string): string {
  return currentOS() === 'win32' ? `${name}.exe` : name
}

function programFiles(): string {
  return process.env.ProgramFiles || 'C:\\Program Files'
}

function parseVersion(text: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0]
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** First match on PATH, else the first fallback location that exists. */
async function locate(command: string, fallbacks: string[] = []): Promise<string | null> {
  const onPath = await which(command)
  if (onPath) return onPath
  for (const candidate of fallbacks) if (await isExecutable(candidate)) return candidate
  return null
}

/** Key that changes when PATH or HOME change, so cached lookups are redone. */
function locationKey(): string {
  return `${process.env.PATH ?? ''}|${homeDir()}`
}

type Detected = Pick<RuntimeInfo, 'found' | 'version' | 'path' | 'running' | 'outdated'>

/** Run `<path> --version`. A slow answer still counts as installed; a failing one does not. */
async function probe(path: string, args: string[] = ['--version'], timeoutMs = DETECT_TIMEOUT_MS): Promise<Detected> {
  const r = await run(path, args, { timeoutMs })
  if (r.timedOut) return { found: true, path }
  if (!r.ok) return { found: false, path }
  const version = parseVersion(r.stdout) ?? parseVersion(r.stderr)
  return version ? { found: true, path, version } : { found: true, path }
}

// ─────────────────────────────────────────────────────────────────────────────
// Locating binaries
// ─────────────────────────────────────────────────────────────────────────────

function nodeDirs(): string[] {
  if (currentOS() === 'win32') return [join(programFiles(), 'nodejs')]
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
}

function uvFallbacks(name: 'uv' | 'uvx'): string[] {
  const home = homeDir()
  const list = [join(home, '.local', 'bin', exe(name)), join(home, '.cargo', 'bin', exe(name))]
  if (currentOS() !== 'win32') list.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`)
  return list
}

function dockerFallbacks(): string[] {
  const os = currentOS()
  if (os === 'win32') return [join(programFiles(), 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
  if (os === 'darwin') {
    return [
      join(homeDir(), '.docker', 'bin', 'docker'),
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/Applications/Docker.app/Contents/Resources/bin/docker'
    ]
  }
  return ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker']
}

function gitFallbacks(): string[] {
  const os = currentOS()
  if (os === 'win32') return [join(programFiles(), 'Git', 'cmd', 'git.exe')]
  if (os === 'darwin') return ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
  return ['/usr/bin/git', '/usr/local/bin/git']
}

/** macOS: /usr/bin/git and /usr/bin/python3 are stubs that pop an "install developer tools" dialog. */
async function isMissingXcodeShim(path: string): Promise<boolean> {
  if (currentOS() !== 'darwin' || !/^\/usr\/bin\/(git|python3)$/.test(path)) return false
  const r = await run('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5_000 })
  return !(r.ok && r.stdout.trim().length > 0)
}

async function npmGlobalPrefix(): Promise<string | null> {
  const npm = await which('npm')
  if (!npm) return null
  const r = await run(npm, ['prefix', '-g'], { timeoutMs: 5_000 })
  if (!r.ok) return null
  const lines = r.stdout.trim().split(/\r?\n/)
  return lines[lines.length - 1]?.trim() || null
}

/** Newest Claude Code binary bundled with the VS Code (or fork) extension, e.g. anthropic.claude-code-2.1.309-win32-x64. */
async function newestBundledClaude(): Promise<string | null> {
  const home = homeDir()
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss'].map((d) => join(home, d, 'extensions'))
  const found: Array<{ version: string; path: string }> = []
  for (const root of roots) {
    const names = await readdir(root).catch(() => [] as string[])
    for (const name of names) {
      const match = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/i.exec(name)
      if (!match) continue
      const binary = join(root, name, 'resources', 'native-binary', exe('claude'))
      if (await isExecutable(binary)) found.push({ version: match[1], path: binary })
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version))
  return found[0]?.path ?? null
}

async function locateClaudeCli(): Promise<string | null> {
  const os = currentOS()
  const home = homeDir()
  for (const candidate of await whichAll('claude')) if (!DESKTOP_BINARY.test(candidate)) return candidate

  const fixed = [join(home, '.local', 'bin', exe('claude'))]
  if (os === 'win32') {
    fixed.push(join(localDir(), 'Microsoft', 'WinGet', 'Links', 'claude.exe'), join(roamingDir(), 'npm', 'claude.cmd'))
  } else {
    fixed.push(
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/home/linuxbrew/.linuxbrew/bin/claude',
      join(home, '.npm-global', 'bin', 'claude')
    )
  }
  for (const candidate of fixed) if (await isExecutable(candidate)) return candidate

  const prefix = await npmGlobalPrefix()
  if (prefix) {
    const candidate = os === 'win32' ? join(prefix, 'claude.cmd') : join(prefix, 'bin', 'claude')
    if (await isExecutable(candidate)) return candidate
  }

  const local = join(home, '.claude', 'local')
  const legacy =
    os === 'win32'
      ? [join(local, 'claude.cmd'), join(local, 'claude.exe'), join(local, 'node_modules', '.bin', 'claude.cmd')]
      : [join(local, 'claude'), join(local, 'node_modules', '.bin', 'claude')]
  for (const candidate of legacy) if (await isExecutable(candidate)) return candidate

  return newestBundledClaude()
}

async function locateVsCodeCli(): Promise<string | null> {
  const onPath = await which('code')
  if (onPath) return onPath
  const os = currentOS()
  const home = homeDir()
  const app = join('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')
  const candidates =
    os === 'win32'
      ? [
          join(localDir(), 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
          join(programFiles(), 'Microsoft VS Code', 'bin', 'code.cmd'),
          join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code', 'bin', 'code.cmd')
        ]
      : os === 'darwin'
        ? [join('/Applications', app), join(home, 'Applications', app), '/usr/local/bin/code', '/opt/homebrew/bin/code']
        : [
            '/usr/bin/code',
            '/snap/bin/code',
            '/usr/share/code/bin/code',
            '/usr/local/bin/code',
            '/var/lib/flatpak/exports/bin/com.visualstudio.code'
          ]
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate
  return null
}

interface PathCache {
  key: string
  at: number
  value: string | null
}

let claudeCache: PathCache | null = null
let vsCodeCache: PathCache | null = null

async function cachedLocate(cache: PathCache | null, fresh: boolean, locator: () => Promise<string | null>): Promise<PathCache> {
  const key = locationKey()
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache
  return { key, at: Date.now(), value: await locator() }
}

async function claudePath(fresh: boolean): Promise<string | null> {
  claudeCache = await cachedLocate(claudeCache, fresh, locateClaudeCli)
  return claudeCache.value
}

async function vsCodePath(fresh: boolean): Promise<string | null> {
  vsCodeCache = await cachedLocate(vsCodeCache, fresh, locateVsCodeCli)
  return vsCodeCache.value
}

/**
 * Locate the Claude Code CLI: PATH → ~/.local/bin/claude(.exe) → npm global →
 * ~/.claude/local → VS Code extension bundled binary (last resort). null if absent.
 * Claude Desktop's own claude.exe (WindowsApps\Claude_…, AnthropicClaude\app-…) is never returned.
 */
export async function findClaudeCli(): Promise<string | null> {
  await fixPath()
  return claudePath(false)
}

/** Locate the VS Code CLI (`code` / `code.cmd`) for installing extensions. */
export async function findVsCodeCli(): Promise<string | null> {
  await fixPath()
  return vsCodePath(false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

async function detectNode(): Promise<Detected> {
  const path = await locate('node', nodeDirs().map((d) => join(d, exe('node'))))
  if (!path) return { found: false }
  const d = await probe(path)
  if (d.found && d.version) d.outdated = (parseInt(d.version, 10) || 0) < MIN_NODE_MAJOR
  return d
}

async function detectNpx(): Promise<Detected> {
  const name = currentOS() === 'win32' ? 'npx.cmd' : 'npx'
  const path = await locate('npx', nodeDirs().map((d) => join(d, name)))
  return path ? probe(path) : { found: false }
}

async function detectUv(name: 'uv' | 'uvx'): Promise<Detected> {
  const path = await locate(name, uvFallbacks(name))
  return path ? probe(path) : { found: false }
}

async function probePython(name: string): Promise<Detected> {
  const path = await which(name)
  if (!path || (await isMissingXcodeShim(path))) return { found: false }
  const r = await run(path, ['--version'], { timeoutMs: DETECT_TIMEOUT_MS })
  const text = `${r.stdout}\n${r.stderr}`
  // Windows Store alias stubs print "Python was not found; run without arguments to install from the Microsoft Store…" (exit 9009).
  if (!r.ok || r.code === 9009 || /microsoft store/i.test(text) || !/python\s+\d+\.\d+/i.test(text)) return { found: false }
  const version = /python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text)?.[1]
  return version ? { found: true, path, version, outdated: compareVersions(version, MIN_PYTHON) < 0 } : { found: true, path }
}

async function detectPython(): Promise<Detected> {
  const names = currentOS() === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']
  const results = await Promise.all(names.map((n) => probePython(n)))
  return results.find((r) => r.found) ?? { found: false }
}

async function detectDocker(): Promise<Detected> {
  const path = await locate('docker', dockerFallbacks())
  if (!path) return { found: false }
  const [version, info] = await Promise.all([
    probe(path),
    run(path, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: DETECT_TIMEOUT_MS })
  ])
  if (version.found) version.running = info.ok && info.stdout.trim().length > 0
  return version
}

async function detectGit(): Promise<Detected> {
  const path = await locate('git', gitFallbacks())
  if (!path || (await isMissingXcodeShim(path))) return { found: false }
  return probe(path)
}

async function detectClaude(fresh: boolean): Promise<Detected> {
  const path = await claudePath(fresh)
  return path ? probe(path, ['--version'], SLOW_DETECT_TIMEOUT_MS) : { found: false }
}

async function detectVsCode(fresh: boolean): Promise<Detected> {
  const path = await vsCodePath(fresh)
  return path ? probe(path, ['--version'], SLOW_DETECT_TIMEOUT_MS) : { found: false }
}

async function detectWinget(): Promise<Detected> {
  if (currentOS() !== 'win32') return { found: false }
  const path = await locate('winget', [join(localDir(), 'Microsoft', 'WindowsApps', 'winget.exe')])
  return path ? probe(path) : { found: false }
}

async function detectBrew(): Promise<Detected> {
  if (currentOS() === 'win32') return { found: false }
  const path = await locate('brew', [...BREW_PATHS, join(homeDir(), '.linuxbrew', 'bin', 'brew')])
  return path ? probe(path, ['--version'], SLOW_DETECT_TIMEOUT_MS) : { found: false }
}

async function detect(id: RuntimeName, fresh: boolean): Promise<Detected> {
  try {
    switch (id) {
      case 'node':
        return await detectNode()
      case 'npx':
        return await detectNpx()
      case 'uv':
      case 'uvx':
        return await detectUv(id)
      case 'python':
        return await detectPython()
      case 'docker':
        return await detectDocker()
      case 'git':
        return await detectGit()
      case 'claude':
        return await detectClaude(fresh)
      case 'code':
        return await detectVsCode(fresh)
      case 'winget':
        return await detectWinget()
      case 'brew':
        return await detectBrew()
    }
  } catch {
    // Detection must never take the app down; treat as "not found".
  }
  return { found: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install plans
// ─────────────────────────────────────────────────────────────────────────────

type AutoInstall =
  | { kind: 'winget'; id: string }
  | { kind: 'brew'; name: string; cask?: boolean }
  /** Official PowerShell installer (`irm <url> | iex`). */
  | { kind: 'powershell'; url: string }
  /** Official `curl … | sh` installer, run with bash (pipefail) or sh. */
  | { kind: 'shell'; script: string }

interface InstallPlan {
  /** One-line command shown to the user. */
  command?: string
  url: string
  /** How to install automatically; absent → manual only. */
  auto?: AutoInstall
  /** Why there is no automatic install (shown to the user). */
  manualReason?: string
}

interface Tools {
  winget: string | null
  brew: string | null
  curl: string | null
  wget: string | null
  bash: string | null
  snap: boolean
  linuxPkg: 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | null
}

let toolsCache: { key: string; at: number; value: Tools } | null = null
let toolsInflight: { key: string; promise: Promise<Tools> } | null = null

async function linuxPackageManager(): Promise<Tools['linuxPkg']> {
  const managers = [
    ['apt', 'apt-get'],
    ['dnf', 'dnf'],
    ['pacman', 'pacman'],
    ['zypper', 'zypper'],
    ['apk', 'apk']
  ] as const
  for (const [id, command] of managers) if (await which(command)) return id
  return null
}

async function scanTools(os: OS): Promise<Tools> {
  if (os === 'win32') {
    const winget = await locate('winget', [join(localDir(), 'Microsoft', 'WindowsApps', 'winget.exe')])
    return { winget, brew: null, curl: null, wget: null, bash: null, snap: false, linuxPkg: null }
  }
  const [brew, curl, wget, bash, snap, linuxPkg] = await Promise.all([
    locate('brew', BREW_PATHS),
    which('curl'),
    which('wget'),
    locate('bash', ['/bin/bash', '/usr/bin/bash']),
    os === 'linux' ? which('snap') : Promise.resolve(null),
    os === 'linux' ? linuxPackageManager() : Promise.resolve(null)
  ])
  return { winget: null, brew, curl, wget, bash, snap: Boolean(snap), linuxPkg }
}

/** Package managers / downloaders available for installs (cached 30 s; concurrent callers share one scan). */
async function availableTools(os: OS, fresh: boolean): Promise<Tools> {
  const key = locationKey()
  if (!fresh && toolsCache && toolsCache.key === key && Date.now() - toolsCache.at < CACHE_TTL_MS) return toolsCache.value
  if (toolsInflight && toolsInflight.key === key) return toolsInflight.promise
  const promise = scanTools(os)
  toolsInflight = { key, promise }
  try {
    const value = await promise
    toolsCache = { key, at: Date.now(), value }
    return value
  } finally {
    if (toolsInflight?.promise === promise) toolsInflight = null
  }
}

function wingetPlan(id: string, url: string, tools: Tools): InstallPlan {
  const command = `winget install --id ${id} -e`
  if (tools.winget) return { command, url, auto: { kind: 'winget', id } }
  return { command, url, manualReason: 'winget (App Installer) is not available on this PC, so download the installer instead.' }
}

function brewPlan(name: string, url: string, cask = false): InstallPlan {
  return { command: `brew install ${cask ? '--cask ' : ''}${name}`, url, auto: { kind: 'brew', name, cask } }
}

function powershellPlan(scriptUrl: string, url: string): InstallPlan {
  return { command: `powershell -ExecutionPolicy ByPass -c "irm ${scriptUrl} | iex"`, url, auto: { kind: 'powershell', url: scriptUrl } }
}

/** `curl … | sh` style official installer (falls back to wget). */
function scriptPlan(scriptUrl: string, interpreter: 'bash' | 'sh', curlFlags: string, url: string, tools: Tools): InstallPlan {
  const fetcher = tools.curl ? `curl ${curlFlags} ${scriptUrl}` : tools.wget ? `wget -qO- ${scriptUrl}` : null
  const command = `${fetcher ?? `curl ${curlFlags} ${scriptUrl}`} | ${interpreter}`
  if (!fetcher) return { command, url, manualReason: 'curl or wget is needed to download the installer.' }
  if (interpreter === 'bash' && !tools.bash) return { command, url, manualReason: 'bash is needed to run the installer.' }
  return { command, url, auto: { kind: 'shell', script: command } }
}

function linuxPackageCommand(pkg: string, tools: Tools): string | undefined {
  switch (tools.linuxPkg) {
    case 'apt':
      return `sudo apt install -y ${pkg}`
    case 'dnf':
      return `sudo dnf install -y ${pkg}`
    case 'pacman':
      return `sudo pacman -S ${pkg}`
    case 'zypper':
      return `sudo zypper install ${pkg}`
    case 'apk':
      return `sudo apk add ${pkg}`
    default:
      return undefined
  }
}

function linuxManual(pkg: string, url: string, tools: Tools, what: string): InstallPlan {
  const command = linuxPackageCommand(pkg, tools)
  return command
    ? { command, url, manualReason: `Installing ${what} needs your administrator password, so run the command in a terminal.` }
    : { url, manualReason: `Install ${what} with your Linux distribution's package manager.` }
}

/** How `id` can be installed on `os` with the tools present (undefined: not applicable on this OS). */
function planFor(id: RuntimeName, os: OS, tools: Tools): InstallPlan | undefined {
  switch (id) {
    case 'node':
    case 'npx':
      if (os === 'win32') return wingetPlan('OpenJS.NodeJS.LTS', URLS.node, tools)
      if (tools.brew) return brewPlan('node', URLS.node)
      return {
        url: URLS.node,
        manualReason:
          os === 'darwin'
            ? 'Download the macOS installer from nodejs.org (or install Homebrew for one-click installs).'
            : 'Install Node.js 20 or newer from nodejs.org (it lists the right command for your Linux distribution).'
      }
    case 'uv':
    case 'uvx':
      if (os === 'win32') return powershellPlan('https://astral.sh/uv/install.ps1', URLS.uv)
      return scriptPlan('https://astral.sh/uv/install.sh', 'sh', '-LsSf', URLS.uv, tools)
    case 'python':
      if (os === 'win32') return wingetPlan('Python.Python.3.13', URLS.python, tools)
      if (tools.brew) return brewPlan('python@3.13', URLS.python)
      if (os === 'darwin') return { url: URLS.python, manualReason: 'Download the macOS installer from python.org.' }
      return linuxManual('python3', URLS.python, tools, 'Python')
    case 'docker': {
      const manualReason = 'Docker Desktop is a large install that needs administrator rights, so install it yourself and then start it.'
      if (os === 'win32') return { command: 'winget install --id Docker.DockerDesktop -e', url: URLS.dockerDesktop, manualReason }
      if (os === 'darwin') {
        return { ...(tools.brew ? { command: 'brew install --cask docker-desktop' } : {}), url: URLS.dockerDesktop, manualReason }
      }
      return {
        command: 'curl -fsSL https://get.docker.com | sh',
        url: URLS.dockerEngine,
        manualReason: 'Installing Docker needs your administrator password, so run the command in a terminal.'
      }
    }
    case 'git':
      if (os === 'win32') return wingetPlan('Git.Git', URLS.git, tools)
      if (tools.brew) return brewPlan('git', URLS.git)
      if (os === 'darwin') {
        return { command: 'xcode-select --install', url: URLS.git, manualReason: "Run the command and follow Apple's installer to get Git." }
      }
      return linuxManual('git', URLS.git, tools, 'Git')
    case 'claude':
      if (os === 'win32') return powershellPlan('https://claude.ai/install.ps1', URLS.claude)
      return scriptPlan('https://claude.ai/install.sh', 'bash', '-fsSL', URLS.claude, tools)
    case 'code':
      if (os === 'win32') return wingetPlan('Microsoft.VisualStudioCode', URLS.code, tools)
      if (tools.brew && os === 'darwin') return brewPlan('visual-studio-code', URLS.code, true)
      if (os === 'darwin') return { url: URLS.code, manualReason: 'Download VS Code for macOS from the website.' }
      return tools.snap
        ? { command: 'sudo snap install code --classic', url: URLS.code, manualReason: 'Installing VS Code needs your administrator password.' }
        : { url: URLS.code, manualReason: 'Download the .deb or .rpm package for your distribution from the website.' }
    case 'winget':
      return os === 'win32' ? { url: URLS.winget, manualReason: 'Install "App Installer" from the Microsoft Store to get winget.' } : undefined
    case 'brew':
      return os === 'win32'
        ? undefined
        : {
            command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
            url: URLS.brew,
            manualReason: 'The Homebrew installer asks for your password, so run it in Terminal.'
          }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// detectRuntime / detectRuntimes
// ─────────────────────────────────────────────────────────────────────────────

const runtimeCache = new Map<RuntimeName, { at: number; info: RuntimeInfo }>()
const inflight = new Map<RuntimeName, Promise<RuntimeInfo>>()
let generation = 0

/**
 * Forget cached detections and binary locations (after installs; tests).
 * @internal
 */
export function resetRuntimeCache(): void {
  generation++
  runtimeCache.clear()
  inflight.clear()
  claudeCache = null
  vsCodeCache = null
  toolsCache = null
  toolsInflight = null
}

async function buildInfo(id: RuntimeName, fresh: boolean): Promise<RuntimeInfo> {
  const os = currentOS()
  const [detected, tools] = await Promise.all([detect(id, fresh), availableTools(os, fresh)])
  const spec = SPECS[id]
  const info: RuntimeInfo = { id, label: spec.label, found: detected.found, purpose: spec.purpose }
  if (detected.version) info.version = detected.version
  if (detected.path) info.path = detected.path
  if (detected.running !== undefined) info.running = detected.running
  if (detected.outdated !== undefined) info.outdated = detected.outdated
  const plan = planFor(id, os, tools)
  if (plan) info.install = { ...(plan.command ? { command: plan.command } : {}), url: plan.url, canAutoInstall: Boolean(plan.auto) }
  return info
}

/** Detect one runtime (calls fixPath() first). Results cached for ~30 s unless `fresh`. */
export async function detectRuntime(id: RuntimeName, opts: { fresh?: boolean } = {}): Promise<RuntimeInfo> {
  if (!isRuntimeName(id)) return { id, label: String(id), found: false, purpose: 'Unknown tool' }
  await fixPath()
  const fresh = opts.fresh === true
  if (!fresh) {
    const hit = runtimeCache.get(id)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return structuredClone(hit.info)
    const pending = inflight.get(id)
    if (pending) return structuredClone(await pending)
  }
  const gen = generation
  const job: Promise<RuntimeInfo> = buildInfo(id, fresh)
    .then((info) => {
      if (gen === generation) runtimeCache.set(id, { at: Date.now(), info })
      return info
    })
    .finally(() => {
      if (inflight.get(id) === job) inflight.delete(id)
    })
  inflight.set(id, job)
  return structuredClone(await job)
}

/** Detect every runtime relevant on this OS, concurrently (each check has its own timeout). */
export async function detectRuntimes(opts: { fresh?: boolean } = {}): Promise<RuntimeInfo[]> {
  await fixPath()
  return Promise.all(runtimeIdsFor().map((id) => detectRuntime(id, opts)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Installation
// ─────────────────────────────────────────────────────────────────────────────

/** winget HRESULTs (AppInstallerErrors.h) seen as unsigned 32-bit exit codes. */
const WINGET = {
  ctrlSignal: 0x8a150005,
  shellExecFailed: 0x8a150006,
  downloadFailed: 0x8a150008,
  sourceDataMissing: 0x8a15000f,
  hashMismatch: 0x8a150011,
  noApplicationsFound: 0x8a150014,
  msstoreBlocked: 0x8a15001b,
  updateNotApplicable: 0x8a15002b,
  sourceOpenFailed: 0x8a150045,
  packageAlreadyInstalled: 0x8a150061,
  packageInUse: 0x8a150101,
  installInProgress: 0x8a150102,
  fileInUse: 0x8a150103,
  missingDependency: 0x8a150104,
  diskFull: 0x8a150105,
  noNetwork: 0x8a150107,
  rebootToFinish: 0x8a150109,
  rebootForInstall: 0x8a15010a,
  rebootInitiated: 0x8a15010b,
  cancelledByUser: 0x8a15010c,
  alreadyInstalled: 0x8a15010d,
  blockedByPolicy: 0x8a15010f
} as const

const WINGET_ALREADY_INSTALLED = new Set<number>([WINGET.packageAlreadyInstalled, WINGET.updateNotApplicable, WINGET.alreadyInstalled])
const WINGET_REBOOT = new Set<number>([WINGET.rebootToFinish, WINGET.rebootForInstall, WINGET.rebootInitiated])

function unsignedCode(code: number | null): number | null {
  return code === null ? null : code >>> 0
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/** Last readable line of installer output (progress bars and spinners removed). */
function lastMeaningfulLine(text: string): string | undefined {
  const lines = stripAnsi(text)
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[█▒░■▌▐▀▄]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => /[A-Za-z0-9].*[A-Za-z0-9].*[A-Za-z0-9]/.test(l))
  return lines[lines.length - 1]
}

function percentFrom(line: string): number | undefined {
  const units: Record<string, number> = { KB: 1, MB: 1024, GB: 1024 * 1024 }
  const sized = /([\d.]+)\s*(KB|MB|GB)\s*\/\s*([\d.]+)\s*(KB|MB|GB)/i.exec(line)
  if (sized) {
    const done = parseFloat(sized[1]) * units[sized[2].toUpperCase()]
    const total = parseFloat(sized[3]) * units[sized[4].toUpperCase()]
    if (total > 0) return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  }
  const pct = /(\d{1,3})\s?%/.exec(line)
  return pct ? Math.min(100, parseInt(pct[1], 10)) : undefined
}

function outputTail(r: RunResult, maxChars = 3_000): string | undefined {
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`)
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[█▒░■▌▐▀▄]+/g, '').trimEnd())
    .filter((l) => l.trim().length > 1)
    .join('\n')
    .trim()
  if (!text) return r.error
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
}

interface ProgressReporter {
  /** Emit a status message now (cancels any pending output line). */
  say(message: string, pct?: number): void
  /** Feed installer output; readable lines are emitted at most every 400 ms (latest line wins). */
  output(text: string): void
}

const PROGRESS_INTERVAL_MS = 400

function progressReporter(ctx: CoreContext, label: string): ProgressReporter {
  let lastOutputAt = 0
  let lastMessage = ''
  let pending: string | null = null
  let timer: NodeJS.Timeout | null = null
  const emit = (message: string, pct?: number): void => {
    lastMessage = message
    ctx.events.emitEvent('progress', pct === undefined ? { op: 'install-runtime', message } : { op: 'install-runtime', message, pct })
  }
  const flush = (): void => {
    timer = null
    if (pending === null) return
    const line = pending
    pending = null
    const message = `${label}: ${line.length > 160 ? `${line.slice(0, 157)}…` : line}`
    if (message === lastMessage) return
    lastOutputAt = Date.now()
    emit(message, percentFrom(line))
  }
  return {
    say(message, pct) {
      pending = null
      if (timer) clearTimeout(timer)
      timer = null
      emit(message, pct)
    },
    output(text) {
      const line = lastMeaningfulLine(text)
      if (!line) return
      pending = line
      const wait = lastOutputAt + PROGRESS_INTERVAL_MS - Date.now()
      if (wait <= 0) flush()
      else timer ??= setTimeout(flush, wait)
    }
  }
}

async function executeInstall(auto: AutoInstall, tools: Tools, progress: ProgressReporter): Promise<RunResult> {
  const onOutput = (text: string): void => progress.output(text)
  switch (auto.kind) {
    case 'winget': {
      const winget = tools.winget ?? 'winget'
      const args = [
        'install',
        '--id',
        auto.id,
        '-e',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity'
      ]
      const first = await run(winget, args, { timeoutMs: INSTALL_TIMEOUT_MS, onOutput })
      const text = `${first.stdout}\n${first.stderr}`
      // Very old winget (< 1.4) does not know --disable-interactivity.
      if (!first.ok && /disable-interactivity/i.test(text) && /(not recognized|unrecognized|invalid)/i.test(text)) {
        return run(winget, args.filter((a) => a !== '--disable-interactivity'), { timeoutMs: INSTALL_TIMEOUT_MS, onOutput })
      }
      return first
    }
    case 'brew':
      return run(tools.brew ?? 'brew', ['install', ...(auto.cask ? ['--cask'] : []), auto.name], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: { NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
        onOutput
      })
    case 'powershell':
      // Same as `irm <url> | iex`, but a failed download stops with an error instead of running nothing.
      return runPowerShell(
        [
          'try {',
          '  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
          '} catch {}',
          `try { $installer = Invoke-RestMethod -UseBasicParsing -Uri '${auto.url}' -ErrorAction Stop }`,
          "catch { [Console]::Error.WriteLine('Download failed: ' + $_.Exception.Message); exit 1 }",
          'Invoke-Expression $installer'
        ].join('\n'),
        { timeoutMs: INSTALL_TIMEOUT_MS, onOutput }
      )
    case 'shell':
      // pipefail only with bash: in dash an unknown `set -o` makes the whole script exit.
      return tools.bash
        ? run(tools.bash, ['-c', `set -o pipefail; ${auto.script}`], { timeoutMs: INSTALL_TIMEOUT_MS, onOutput })
        : run('/bin/sh', ['-c', auto.script], { timeoutMs: INSTALL_TIMEOUT_MS, onOutput })
  }
}

function wingetFailure(label: string, code: number | null, text: string): string {
  switch (code) {
    case WINGET.cancelledByUser:
    case WINGET.ctrlSignal:
      return `The ${label} installation was cancelled.`
    case WINGET.noNetwork:
    case WINGET.downloadFailed:
      return `Couldn't download ${label}. Check your internet connection and try again.`
    case WINGET.diskFull:
      return `There isn't enough free disk space to install ${label}.`
    case WINGET.installInProgress:
      return 'Another installation is already running. Wait for it to finish, then try again.'
    case WINGET.packageInUse:
    case WINGET.fileInUse:
      return `${label} is in use. Close it (and any terminals using it), then try again.`
    case WINGET.blockedByPolicy:
    case WINGET.msstoreBlocked:
      return `Your organization's policy blocks installing ${label}. Ask your IT department for help.`
    case WINGET.noApplicationsFound:
      return `winget couldn't find the ${label} package. Update "App Installer" from the Microsoft Store and try again.`
    case WINGET.sourceOpenFailed:
    case WINGET.sourceDataMissing:
      return `winget's package list isn't working. Run "winget source reset --force" in an administrator terminal, then try again.`
    case WINGET.hashMismatch:
      return `The ${label} download didn't pass its security check. Please try again later.`
    case WINGET.missingDependency:
      return `${label} needs another component that couldn't be installed.`
  }
  // Declined administrator prompt (ERROR_CANCELLED 1223) or MSI "user cancelled" (1602).
  if (/\b(1223|1602)\b/.test(text) || /cancel/i.test(text)) {
    return `The ${label} installation was cancelled (administrator permission is needed).`
  }
  return `Couldn't install ${label}${code !== null ? ` (winget error 0x${code.toString(16).toUpperCase()})` : ''}.`
}

function installFailure(label: string, auto: AutoInstall, r: RunResult): string {
  if (r.timedOut) return `Installing ${label} took longer than 10 minutes and was stopped.`
  if (r.error) return `Couldn't start the ${label} installer (${r.error}).`
  if (auto.kind === 'winget') return wingetFailure(label, unsignedCode(r.code), `${r.stdout}\n${r.stderr}`)
  const last = lastMeaningfulLine(r.stderr) ?? lastMeaningfulLine(r.stdout)
  if (auto.kind === 'brew') return `Homebrew couldn't install ${label}${last ? `: ${last}` : '.'}`
  return `The ${label} installer failed${last ? `: ${last}` : '.'}`
}

function interpretInstall(label: string, auto: AutoInstall, r: RunResult, info: RuntimeInfo): OpResult {
  const code = unsignedCode(r.code)
  const winget = auto.kind === 'winget'
  const installerOk = r.ok || (winget && code !== null && WINGET_ALREADY_INSTALLED.has(code))
  const details = outputTail(r)
  if (info.found && !info.outdated) {
    return {
      ok: true,
      message: `${label}${info.version ? ` ${info.version}` : ''} is installed and ready.`,
      details: 'Apps and terminals that were already open (like Claude Desktop) may need a restart to see it.'
    }
  }
  if (winget && code !== null && WINGET_REBOOT.has(code)) {
    return { ok: true, needsRestart: true, message: `${label} is almost ready. Restart your computer to finish the installation.`, details }
  }
  if (installerOk && info.found && info.outdated) {
    return {
      ok: true,
      needsRestart: true,
      message:
        `${label} was updated, but Claude Setup still sees version ${info.version ?? 'unknown'}. ` +
        "Restart Claude Setup; if that doesn't help, remove the older version.",
      details
    }
  }
  if (installerOk) {
    return {
      ok: true,
      needsRestart: true,
      message: `${label} was installed, but Claude Setup can't see it yet. Restart Claude Setup (or sign out and back in) to finish.`,
      details
    }
  }
  return { ok: false, message: installFailure(label, auto, r), details }
}

function manualResult(label: string, plan: InstallPlan): OpResult {
  const how = plan.command ? `Run this in a terminal:\n${plan.command}` : `Download it from ${plan.url}`
  return {
    ok: false,
    message: `${label} can't be installed automatically.${plan.manualReason ? ` ${plan.manualReason}` : ''}`,
    details: `${how}\nMore help: ${plan.url}`
  }
}

let installQueue: Promise<unknown> = Promise.resolve()

async function performInstall(ctx: CoreContext, id: RuntimeName): Promise<OpResult> {
  if (!isRuntimeName(id)) return { ok: false, message: `"${String(id)}" is not something Claude Setup can install.` }
  const os = currentOS()
  // npx comes with Node.js and uvx with uv.
  const target: RuntimeName = id === 'npx' ? 'node' : id === 'uvx' ? 'uv' : id
  const label = SPECS[target].label
  await fixPath()
  const tools = await availableTools(os, true)
  const plan = planFor(target, os, tools)
  if (!plan) return { ok: false, message: `${label} isn't available for this operating system.` }
  if (!plan.auto) return manualResult(label, plan)

  const progress = progressReporter(ctx, label)
  progress.say(`Installing ${label}… this can take a few minutes.`)
  ctx.log.info('runtimes', `Installing ${label} (${plan.command ?? plan.auto.kind})`)
  let result: RunResult
  try {
    result = await executeInstall(plan.auto, tools, progress)
  } catch (err) {
    ctx.log.error('runtimes', `${label} installer crashed: ${errorMessage(err)}`)
    return { ok: false, message: `Couldn't run the ${label} installer.`, details: errorMessage(err) }
  }
  const tail = outputTail(result)
  if (tail) ctx.log.debug('runtimes', `${label} installer output:\n${tail}`)

  progress.say(`Checking ${label}…`)
  await refreshPath()
  resetRuntimeCache()
  const info = await detectRuntime(id, { fresh: true })
  const outcome = interpretInstall(label, plan.auto, result, info)
  if (outcome.ok) ctx.log.info('runtimes', outcome.message)
  else ctx.log.warn('runtimes', `${outcome.message} (exit code ${result.code ?? 'none'})`)
  progress.say(outcome.message, outcome.ok ? 100 : undefined)
  return outcome
}

/** Install a runtime with winget (Windows) / brew (macOS) / official script. One install runs at a time. */
export function installRuntime(ctx: CoreContext, id: RuntimeName): Promise<OpResult> {
  const job = installQueue.then(() => performInstall(ctx, id))
  installQueue = job.catch(() => undefined)
  return job
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/** RuntimesApi: detect() is always fresh (re-reads PATH at most every 15 s); install() never throws. */
export function createRuntimesApi(ctx: CoreContext): RuntimesApi {
  let lastPathRefresh = 0
  return {
    async detect() {
      try {
        if (Date.now() - lastPathRefresh > 15_000) {
          lastPathRefresh = Date.now()
          await refreshPath()
        }
        return await detectRuntimes({ fresh: true })
      } catch (err) {
        ctx.log.error('runtimes', `Runtime detection failed: ${errorMessage(err)}`)
        return []
      }
    },
    async install(id) {
      try {
        return await installRuntime(ctx, id)
      } catch (err) {
        ctx.log.error('runtimes', `Installing ${String(id)} failed: ${errorMessage(err)}`)
        return { ok: false, message: `Couldn't install ${String(id)}.`, details: errorMessage(err) }
      }
    }
  }
}
