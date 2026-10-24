/**
 * Test sandbox: redirects every location the core reads (home, AppData, Claude dirs,
 * Claude Setup data dir) into a fresh temp directory, so tests can never touch the
 * developer's real Claude Desktop / Claude Code / VS Code configuration.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SETUP_DATA_DIR',
  'CLAUDE_USER_DATA_DIR'
] as const

export interface Sandbox {
  root: string
  home: string
  appData: string
  localAppData: string
  /** Same as process.env.CLAUDE_SETUP_DATA_DIR inside the sandbox. */
  dataDir: string
  cleanup(): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'claude-setup-test-'))
  const home = join(root, 'home')
  const appData = join(home, 'AppData', 'Roaming')
  const localAppData = join(home, 'AppData', 'Local')
  const dataDir = join(root, 'data')
  await Promise.all([home, appData, localAppData, dataDir].map((d) => mkdir(d, { recursive: true })))
  const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.APPDATA = appData
  process.env.LOCALAPPDATA = localAppData
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_USER_DATA_DIR
  process.env.CLAUDE_SETUP_DATA_DIR = dataDir
  return {
    root,
    home,
    appData,
    localAppData,
    dataDir,
    async cleanup() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Run `fn` inside a sandbox and always clean up. */
export async function withSandbox<T>(fn: (sb: Sandbox) => Promise<T>): Promise<T> {
  const sb = await createSandbox()
  try {
    return await fn(sb)
  } finally {
    await sb.cleanup()
  }
}
