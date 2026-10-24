/**
 * claude-setup: terminal command. Runs as
 *   <Claude Setup executable> <…>/out/main/cli.js …   with ELECTRON_RUN_AS_NODE=1 (installed shim), or
 *   node bin/claude-setup.js …                        (npm / development).
 */
import { createCore } from '@core/index'
import { appDataDir } from '@core/platform/paths'
import { createSecretStore } from '@core/secrets'
import { selfLaunchFromEntry } from '@core/self/launch'
import { version } from '../../package.json'
import { runCli } from './run'

// In the bundle this file is out/main/cli.js; mcp.js sits next to it.
const entryDir = typeof __dirname === 'string' ? __dirname : process.cwd()

function exit(code: number): void {
  // Let piped stdout drain before exiting (process.exit can truncate pending writes).
  const timer = setTimeout(() => process.exit(code), 1500)
  timer.unref()
  process.stdout.write('', () => process.exit(code))
}

// `claude-setup list | head -1` closes the pipe early: exit quietly instead of crashing.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
})

const launch = selfLaunchFromEntry({
  platform: process.platform,
  execPath: process.execPath,
  entryDir,
  electron: !!process.versions.electron,
  env: process.env
})

void runCli(process.argv.slice(2), {
  io: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, platform: process.platform },
  version,
  createCore: () => createCore({ surface: 'cli', appVersion: version, packaged: entryDir.includes('app.asar'), selfMcpConfig: launch.config }),
  secrets: () => createSecretStore(appDataDir()),
  cwd: () => process.cwd()
}).then(exit, (err: unknown) => {
  process.stderr.write(`claude-setup: ${err instanceof Error ? err.message : String(err)}\n`)
  exit(1)
})
