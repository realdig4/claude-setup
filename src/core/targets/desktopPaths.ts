/**
 * Where Claude Desktop keeps claude_desktop_config.json, whether it is installed, and its version.
 *
 * Windows is the hard case: the MSIX build virtualizes %APPDATA%\Claude into
 * %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude, an upcoming rollout moves data to
 * %LOCALAPPDATA%\Claude-Data\…, and old Squirrel installs use %APPDATA%\Claude. The most reliable signal is the
 * newest "Reading claude_desktop_config.json from <physical path>" line in Desktop's main.log.
 *
 * Third-party-inference (3P) mode keeps a separate profile (…/Claude-3p) with its own config. 3P is active only
 * when that profile's own claude_desktop_config.json says `"deploymentMode": "3p"` (folder existence means nothing:
 * the installer pre-creates empty folders). Then Claude Setup writes servers to BOTH files so they work in either mode.
 */
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { currentOS, homeDir, localDir, roamingDir } from '../platform/paths'
import { safeRun, safeWhich } from './sys'

export const DESKTOP_CONFIG_FILE = 'claude_desktop_config.json'
/** MSIX package family names hard-coded in the app (standard build + Store build). */
export const DESKTOP_MSIX_FAMILIES = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'] as const
export const DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop'

export type DesktopConfigSource = 'override' | 'log' | 'msix' | 'data-dir' | 'roaming' | 'default'

export interface DesktopLocation {
  /** Physical config file Claude Desktop reads. */
  configPath: string
  source: DesktopConfigSource
  /** Other existing copies Claude Desktop does NOT read (stale MSIX / roaming duplicates). */
  otherCopies: string[]
  /** Config of the 3P (third-party inference) profile when that profile is in use. */
  threePConfigPath?: string
}

export interface DesktopInstall {
  installed: boolean
  kind?: 'msix' | 'squirrel' | 'mac' | 'linux'
  /** MSIX package family name. */
  packageFamily?: string
  /** App execution alias (MSIX) usable to launch the app. */
  aliasPath?: string
  /** Squirrel Update.exe. */
  updateExe?: string
  /** App bundle (macOS) / binary (Linux, Squirrel). */
  appPath?: string
  version?: string
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** App execution aliases are reparse points that stat() cannot open — lstat sees them. */
async function aliasExists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

async function mtime(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return 0
  }
}

/** True when the 3P profile config exists and selects 3P mode (`deploymentMode: "3p"`). */
async function isThreePConfig(file: string): Promise<boolean> {
  try {
    const text = await readFile(file, 'utf8')
    const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as { deploymentMode?: unknown }
    return data?.deploymentMode === '3p'
  } catch {
    return false
  }
}

/** %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude */
export function msixDataDir(family: string): string {
  return join(localDir(), 'Packages', family, 'LocalCache', 'Roaming', 'Claude')
}

/** Default (non-virtualized) user-data folder for the current OS. */
export function defaultDesktopDataDir(): string {
  const os = currentOS()
  if (os === 'darwin') return join(homeDir(), 'Library', 'Application Support', 'Claude')
  return join(roamingDir(), 'Claude')
}

/** The 3P profile folder for the current OS. */
export function desktopThreePDir(): string {
  const os = currentOS()
  if (os === 'win32') return join(localDir(), 'Claude-3p')
  if (os === 'darwin') return join(homeDir(), 'Library', 'Application Support', 'Claude-3p')
  return join(roamingDir(), 'Claude-3p')
}

/** Folders that may contain Desktop's main.log, most likely first. */
export function desktopLogDirs(): string[] {
  const os = currentOS()
  const dirs: string[] = []
  const override = process.env.CLAUDE_USER_DATA_DIR
  if (override) dirs.push(join(override, 'Logs'), join(override, 'logs'))
  if (os === 'win32') {
    dirs.push(join(localDir(), 'Claude', 'logs'), join(roamingDir(), 'Claude', 'logs'))
    for (const fam of DESKTOP_MSIX_FAMILIES) dirs.push(join(msixDataDir(fam), 'logs'))
  } else if (os === 'darwin') {
    dirs.push(join(homeDir(), 'Library', 'Logs', 'Claude'))
  } else {
    dirs.push(join(roamingDir(), 'Claude', 'logs'))
  }
  return dirs
}

const MAX_LOG_BYTES = 8 * 1024 * 1024

/** Whole file when small, otherwise its last MAX_LOG_BYTES. */
async function readLogTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, MAX_LOG_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

export interface DesktopLogInfo {
  /** Physical config path from the newest "Reading … from" line (3P profile lines ignored). */
  configPath?: string
  configTime?: string
  /** appVersion from the newest "Starting app {…}" block. */
  version?: string
  versionTime?: string
}

const READING_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})[^\n]*?Reading claude_desktop_config\.json from (.+?)\s*$/gm
const VERSION_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})[^\n]*?Starting app \{[\s\S]{0,600}?appVersion: ['"]([^'"]+)['"]/gm

/** Parse the interesting lines out of main.log text. */
export function parseDesktopLog(text: string): DesktopLogInfo {
  const info: DesktopLogInfo = {}
  for (const m of text.matchAll(READING_RE)) {
    const path = m[2].trim()
    if (/[\\/]Claude-3p[\\/]/i.test(path)) continue
    if (!info.configTime || m[1] >= info.configTime) {
      info.configTime = m[1]
      info.configPath = path
    }
  }
  for (const m of text.matchAll(VERSION_RE)) {
    if (!info.versionTime || m[1] >= info.versionTime) {
      info.versionTime = m[1]
      info.version = m[2]
    }
  }
  return info
}

/** Newest config path + version across every Desktop log folder. */
export async function readDesktopLogs(): Promise<DesktopLogInfo> {
  const best: DesktopLogInfo = {}
  for (const dir of desktopLogDirs()) {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /^main(\.old|[.-]?\d+)?\.log$/i.test(n))
    } catch {
      continue
    }
    for (const name of names) {
      let text: string
      try {
        text = await readLogTail(join(dir, name))
      } catch {
        continue
      }
      const info = parseDesktopLog(text)
      if (info.configPath && (!best.configTime || info.configTime! > best.configTime)) {
        best.configPath = info.configPath
        best.configTime = info.configTime
      }
      if (info.version && (!best.versionTime || info.versionTime! > best.versionTime)) {
        best.version = info.version
        best.versionTime = info.versionTime
      }
    }
  }
  return best
}

/** claude_desktop_config.json files under %LOCALAPPDATA%\Claude-Data (layout of the upcoming rollout), newest first. */
async function dataDirConfigs(): Promise<string[]> {
  const root = join(localDir(), 'Claude-Data')
  const found: string[] = []
  if (await isFile(join(root, DESKTOP_CONFIG_FILE))) found.push(join(root, DESKTOP_CONFIG_FILE))
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const candidate of [join(root, entry.name, DESKTOP_CONFIG_FILE), join(root, entry.name, 'Claude', DESKTOP_CONFIG_FILE)]) {
        if (await isFile(candidate)) found.push(candidate)
      }
    }
  } catch {
    // no Claude-Data folder
  }
  const withTimes = await Promise.all(found.map(async (p) => ({ p, t: await mtime(p) })))
  return withTimes.sort((a, b) => b.t - a.t).map((x) => x.p)
}

/** The 3P profile config path when the 3P profile is in use. */
export async function threePConfigPath(): Promise<string | undefined> {
  if (process.env.CLAUDE_USER_DATA_DIR) return undefined
  const file = join(desktopThreePDir(), DESKTOP_CONFIG_FILE)
  return (await isThreePConfig(file)) ? file : undefined
}

/** Resolve the physical config file Claude Desktop reads on this machine (see module docs for the order). */
export async function resolveDesktopConfig(): Promise<DesktopLocation> {
  const os = currentOS()
  const threeP = await threePConfigPath()
  const finish = async (configPath: string, source: DesktopConfigSource): Promise<DesktopLocation> => {
    const loc: DesktopLocation = { configPath, source, otherCopies: os === 'win32' ? await otherWindowsCopies(configPath) : [] }
    if (threeP) loc.threePConfigPath = threeP
    return loc
  }

  const override = process.env.CLAUDE_USER_DATA_DIR
  if (override) return finish(join(override, DESKTOP_CONFIG_FILE), 'override')
  if (os !== 'win32') return finish(join(defaultDesktopDataDir(), DESKTOP_CONFIG_FILE), 'default')

  const logs = await readDesktopLogs()
  if (logs.configPath && basename(logs.configPath).toLowerCase() === DESKTOP_CONFIG_FILE && (await isDir(dirname(logs.configPath)))) {
    return finish(logs.configPath, 'log')
  }
  for (const fam of DESKTOP_MSIX_FAMILIES) {
    const dir = msixDataDir(fam)
    if (await isDir(dir)) return finish(join(dir, DESKTOP_CONFIG_FILE), 'msix')
  }
  const data = await dataDirConfigs()
  if (data.length) return finish(data[0], 'data-dir')
  return finish(join(roamingDir(), 'Claude', DESKTOP_CONFIG_FILE), 'roaming')
}

/** Existing Windows config copies other than the one in use (the Doctor warns about drift). */
async function otherWindowsCopies(inUse: string): Promise<string[]> {
  const candidates = [
    join(roamingDir(), 'Claude', DESKTOP_CONFIG_FILE),
    ...DESKTOP_MSIX_FAMILIES.map((f) => join(msixDataDir(f), DESKTOP_CONFIG_FILE))
  ]
  candidates.push(...(await dataDirConfigs()))
  const out: string[] = []
  for (const c of candidates) {
    if (c.toLowerCase() === inUse.toLowerCase() || out.some((o) => o.toLowerCase() === c.toLowerCase())) continue
    if (await isFile(c)) out.push(c)
  }
  return out
}

/** Newest Squirrel app-<version> folder. */
async function newestSquirrelApp(root: string): Promise<{ dir: string; version: string } | null> {
  try {
    const versions = (await readdir(root))
      .map((n) => /^app-(\d+(?:\.\d+)*)$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ dir: join(root, m[0]), version: m[1] }))
    versions.sort((a, b) => compareVersions(b.version, a.version))
    return versions[0] ?? null
  } catch {
    return null
  }
}

/** Numeric dotted-version comparison. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Detect the installed Claude Desktop flavour (cheap file checks; version from logs/plist/package dirs). */
export async function detectDesktopInstall(): Promise<DesktopInstall> {
  const os = currentOS()
  const logs = await readDesktopLogs().catch((): DesktopLogInfo => ({}))
  if (os === 'win32') {
    const apps = join(localDir(), 'Microsoft', 'WindowsApps')
    for (const fam of DESKTOP_MSIX_FAMILIES) {
      if (!(await isDir(join(localDir(), 'Packages', fam)))) continue
      const install: DesktopInstall = { installed: true, kind: 'msix', packageFamily: fam }
      for (const alias of fam.startsWith('AnthropicPBC') ? ['claude-desktop-msstore.exe', 'claude-desktop.exe'] : ['claude-desktop.exe']) {
        if (await aliasExists(join(apps, alias))) {
          install.aliasPath = join(apps, alias)
          break
        }
      }
      if (logs.version) install.version = logs.version
      return install
    }
    const squirrelRoot = join(localDir(), 'AnthropicClaude')
    const updateExe = join(squirrelRoot, 'Update.exe')
    const app = await newestSquirrelApp(squirrelRoot)
    const hasUpdateExe = await isFile(updateExe)
    if (app || hasUpdateExe) {
      const install: DesktopInstall = { installed: true, kind: 'squirrel' }
      if (hasUpdateExe) install.updateExe = updateExe
      if (app) install.appPath = join(app.dir, 'claude.exe')
      const version = logs.version ?? app?.version
      if (version) install.version = version
      return install
    }
    if (await aliasExists(join(apps, 'claude-desktop.exe'))) {
      const install: DesktopInstall = { installed: true, kind: 'msix', aliasPath: join(apps, 'claude-desktop.exe') }
      if (logs.version) install.version = logs.version
      return install
    }
    return { installed: false }
  }
  if (os === 'darwin') {
    for (const bundle of ['/Applications/Claude.app', join(homeDir(), 'Applications', 'Claude.app')]) {
      if (!(await isDir(bundle))) continue
      const install: DesktopInstall = { installed: true, kind: 'mac', appPath: bundle }
      const version = (await plistVersion(join(bundle, 'Contents', 'Info.plist'))) ?? logs.version
      if (version) install.version = version
      return install
    }
    return { installed: false }
  }
  const debBinary = '/usr/lib/claude-desktop/claude-desktop'
  const binary = (await isFile(debBinary)) ? debBinary : await safeWhich('claude-desktop')
  if (!binary) return { installed: false }
  const install: DesktopInstall = { installed: true, kind: 'linux', appPath: binary }
  let version = logs.version
  if (!version) {
    const r = await safeRun('dpkg-query', ['-W', '-f=${Version}', 'claude-desktop'], { timeoutMs: 4000 })
    if (r.ok && r.stdout.trim()) version = r.stdout.trim()
  }
  if (version) install.version = version
  return install
}

/** CFBundleShortVersionString from an XML Info.plist. */
async function plistVersion(plist: string): Promise<string | undefined> {
  try {
    const text = await readFile(plist, 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
  } catch {
    return undefined
  }
}
