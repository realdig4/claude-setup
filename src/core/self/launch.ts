/**
 * How this installation of Claude Setup starts its own MCP server (and CLI).
 * Pure helpers — no Electron imports — shared by the GUI, CLI and MCP entry points.
 *
 * Strategy (research_stack §5 option A): run the app's own executable as plain Node with
 * ELECTRON_RUN_AS_NODE=1 and point it at out/main/mcp.js (or cli.js) inside app.asar.
 * Copies whose location changes between launches (portable exe, macOS App Translocation,
 * disk image, AppImage, npx cache) must never be registered.
 */
import { posix, win32 } from 'node:path'
import type { StdioServerConfig, TargetId } from '@shared/types'

/** Config key used for Claude Setup's own MCP server in every target. */
export const SELF_SERVER_NAME = 'claude-setup'

/** Every app Claude Setup can register itself in. */
export const ALL_TARGETS: TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']

/** Launch config for this copy, or the reason there is none. */
export interface SelfLaunch {
  /** Set when this copy can be registered. */
  config?: StdioServerConfig
  /** Friendly explanation when it cannot. */
  unavailableReason?: string
}

/** Inputs for selfLaunchFromEntry(). */
export interface EntryLaunchInput {
  platform: NodeJS.Platform
  /** Absolute path of the running executable (Electron binary or node). */
  execPath: string
  /** Folder that contains mcp.js and cli.js (…/out/main). */
  entryDir: string
  /** execPath is the Electron binary → the child needs ELECTRON_RUN_AS_NODE=1. */
  electron: boolean
  env: Record<string, string | undefined>
}

/** Inputs for guiSelfLaunch(). */
export interface GuiLaunchInput {
  platform: NodeJS.Platform
  packaged: boolean
  execPath: string
  /** process.resourcesPath (packaged builds). */
  resourcesPath: string
  /** app.getAppPath() (project root in development). */
  appPath: string
  env: Record<string, string | undefined>
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * Why this copy of Claude Setup cannot be registered with Claude apps, or undefined when it can.
 * The answer is written for non-technical users.
 */
export function unstableLocationReason(input: {
  platform: NodeJS.Platform
  execPath: string
  entryDir?: string
  env: Record<string, string | undefined>
}): string | undefined {
  const { platform, execPath, env } = input
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_FILE) {
    return (
      'You are using the portable version of Claude Setup. It unpacks itself into a new temporary folder every time it ' +
      'starts, so Claude apps could not find it later. Install Claude Setup with the regular installer to use it from Claude.'
    )
  }
  if (platform === 'darwin' && execPath.includes('/AppTranslocation/')) {
    return (
      'macOS is running Claude Setup from a temporary, read-only location. Move Claude Setup into your Applications ' +
      'folder, open it from there, and try again.'
    )
  }
  if (platform === 'darwin' && execPath.startsWith('/Volumes/')) {
    return (
      'Claude Setup is running straight from the disk image. Drag it into your Applications folder, open it from there, ' +
      'and try again.'
    )
  }
  if (platform === 'linux' && (env.APPIMAGE || execPath.startsWith('/tmp/.mount_'))) {
    return (
      'You are using the AppImage version of Claude Setup. Its files move to a new temporary folder on every launch, so ' +
      'Claude apps could not find it later. Install the .deb package to use Claude Setup from Claude.'
    )
  }
  const dir = (input.entryDir ?? '').replace(/\\/g, '/')
  if (dir.includes('/_npx/')) {
    return (
      'This copy of Claude Setup is running from a temporary npx folder that can be deleted at any time. Install it ' +
      'permanently (npm install -g claude-setup) and register it from there.'
    )
  }
  return undefined
}

/** Launch config for the copy whose bundled entry points live in `entryDir`. */
export function selfLaunchFromEntry(input: EntryLaunchInput): SelfLaunch {
  const reason = unstableLocationReason(input)
  if (reason) return { unavailableReason: reason }
  const config: StdioServerConfig = {
    type: 'stdio',
    command: input.execPath,
    args: [pathApi(input.platform).join(input.entryDir, 'mcp.js')]
  }
  if (input.electron) config.env = { ELECTRON_RUN_AS_NODE: '1' }
  return { config }
}

/** Launch config for the Electron GUI process (packaged: inside app.asar; dev: the project's out/ folder). */
export function guiSelfLaunch(input: GuiLaunchInput): SelfLaunch {
  const p = pathApi(input.platform)
  const entryDir = input.packaged
    ? p.join(input.resourcesPath, 'app.asar', 'out', 'main')
    : p.resolve(input.appPath, 'out', 'main')
  return selfLaunchFromEntry({ platform: input.platform, execPath: input.execPath, entryDir, electron: true, env: input.env })
}

/** How to start the CLI of this copy. */
export interface CliLaunch {
  /** Executable to run (Electron binary or node). */
  exe: string
  /** Absolute path of cli.js. */
  script: string
  /** Needs ELECTRON_RUN_AS_NODE=1. */
  electron: boolean
}

/** Derive how to start the CLI from the MCP launch config (same executable, cli.js next to mcp.js). */
export function cliLaunchFromConfig(config: StdioServerConfig | undefined, platform: NodeJS.Platform): CliLaunch | undefined {
  const mcpScript = config?.args?.[0]
  if (!config?.command || !mcpScript || !/mcp\.js$/i.test(mcpScript)) return undefined
  const p = pathApi(platform)
  return {
    exe: config.command,
    script: p.join(p.dirname(mcpScript), 'cli.js'),
    electron: config.env?.ELECTRON_RUN_AS_NODE === '1'
  }
}

/** True when two launch configs start the same thing (command + args + env). */
export function sameLaunch(a: StdioServerConfig, b: StdioServerConfig): boolean {
  const norm = (c: StdioServerConfig) =>
    JSON.stringify({ command: c.command, args: c.args ?? [], env: Object.entries(c.env ?? {}).sort(([x], [y]) => x.localeCompare(y)) })
  return norm(a) === norm(b)
}
