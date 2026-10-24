/** Mock: DoctorApi + RuntimesApi — a realistic health report with fixable problems. */
import type { DoctorApi, RuntimesApi } from '@shared/api'
import type { CheckStatus, DoctorCheck, DoctorReport, OpResult, RuntimeInfo, RuntimeName } from '@shared/types'
import { clone, emit, env, homePath, log, sleep } from './runtime'

let runtimesState: RuntimeInfo[] | null = null

/** Built lazily so paths follow the configured fake OS. */
function runtimes(): RuntimeInfo[] {
  if (runtimesState) return runtimesState
  const win = env.platform === 'win32'
  const mac = env.platform === 'darwin'
  const bin = (winPath: string, macPath: string, linuxPath: string): string => (win ? winPath : mac ? macPath : linuxPath)
  const list: RuntimeInfo[] = [
    {
      id: 'node',
      label: 'Node.js',
      found: true,
      version: '24.11.1',
      path: bin('C:\\Program Files\\nodejs\\node.exe', '/opt/homebrew/bin/node', '/usr/bin/node'),
      purpose: 'Runs most tools (the ones installed with npx).'
    },
    {
      id: 'npx',
      label: 'npx',
      found: true,
      version: '11.6.2',
      path: bin('C:\\Program Files\\nodejs\\npx.cmd', '/opt/homebrew/bin/npx', '/usr/bin/npx'),
      purpose: 'Downloads and starts Node.js tools.'
    },
    {
      id: 'uv',
      label: 'uv',
      found: false,
      purpose: 'Runs tools written in Python (uvx).',
      install: {
        command: win ? 'winget install --id=astral-sh.uv -e' : mac ? 'brew install uv' : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        url: 'https://docs.astral.sh/uv/getting-started/installation/',
        canAutoInstall: true
      }
    },
    {
      id: 'uvx',
      label: 'uvx',
      found: false,
      purpose: 'Starts Python tools (comes with uv).',
      install: { url: 'https://docs.astral.sh/uv/getting-started/installation/', canAutoInstall: false }
    },
    {
      id: 'python',
      label: 'Python',
      found: true,
      version: '3.12.7',
      path: bin(homePath('AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'), '/usr/bin/python3', '/usr/bin/python3'),
      purpose: 'Needed by a few tools that are not packaged for uv.'
    },
    {
      id: 'docker',
      label: 'Docker',
      found: true,
      version: '28.5.1',
      running: false,
      path: bin('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', '/usr/local/bin/docker', '/usr/bin/docker'),
      purpose: 'Runs tools packaged as containers.',
      install: { url: 'https://www.docker.com/products/docker-desktop/', canAutoInstall: false }
    },
    {
      id: 'git',
      label: 'Git',
      found: true,
      version: '2.51.0',
      path: bin('C:\\Program Files\\Git\\cmd\\git.exe', '/usr/bin/git', '/usr/bin/git'),
      purpose: 'Needed to add plugin marketplaces.'
    },
    {
      id: 'claude',
      label: 'Claude Code',
      found: true,
      version: '2.1.309',
      path: homePath('.local', 'bin', win ? 'claude.exe' : 'claude'),
      purpose: 'The Claude Code command-line tool.'
    },
    {
      id: 'code',
      label: 'VS Code',
      found: true,
      version: '1.106.0',
      path: bin(homePath('AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        '/usr/local/bin/code',
        '/usr/bin/code'
      ),
      purpose: 'Installs the Claude Code extension for VS Code.'
    }
  ]
  if (win) {
    list.push({
      id: 'winget',
      label: 'winget',
      found: true,
      version: '1.12.340',
      path: homePath('AppData', 'Local', 'Microsoft', 'WindowsApps', 'winget.exe'),
      purpose: 'Installs missing runtimes automatically.'
    })
  } else if (mac) {
    list.push({
      id: 'brew',
      label: 'Homebrew',
      found: true,
      version: '4.7.2',
      path: '/opt/homebrew/bin/brew',
      purpose: 'Installs missing runtimes automatically.'
    })
  }
  runtimesState = list
  return list
}

/** Read-only copy for other mock modules (install previews, tests). */
export function runtimeSnapshot(): RuntimeInfo[] {
  return clone(runtimes())
}

function setRuntime(id: RuntimeName, patch: Partial<RuntimeInfo>): void {
  runtimesState = runtimes().map((r) => (r.id === id ? { ...r, ...patch } : r))
}

const fixed = new Set<string>()

function checks(): DoctorCheck[] {
  const rt = runtimes()
  const node = rt.find((r) => r.id === 'node')
  const uv = rt.find((r) => r.id === 'uv')
  const docker = rt.find((r) => r.id === 'docker')
  const list: DoctorCheck[] = [
    {
      id: 'node',
      category: 'runtimes',
      title: node?.found ? `Node.js ${node.version} is installed` : 'Node.js is missing',
      status: node?.found ? 'ok' : 'error',
      detail: 'Most tools need Node.js to run.'
    },
    uv?.found
      ? { id: 'uv', category: 'runtimes', title: `uv ${uv.version ?? ''} is installed`.trim(), status: 'ok', detail: 'Python tools can run.' }
      : {
          id: 'uv',
          category: 'runtimes',
          title: 'uv is not installed',
          status: 'warn',
          detail: 'Some tools are written in Python and need uv to run. It takes about a minute to install.',
          fix: { id: 'install-uv', label: 'Install uv', auto: true },
          docsUrl: 'https://docs.astral.sh/uv/'
        },
    docker?.running
      ? { id: 'docker', category: 'runtimes', title: 'Docker is running', status: 'ok' }
      : {
          id: 'docker',
          category: 'runtimes',
          title: 'Docker Desktop is not running',
          status: 'warn',
          detail: 'Tools that run in containers won’t start until Docker is running.',
          fix: { id: 'start-docker', label: 'Start Docker', auto: true }
        },
    { id: 'desktop-config', category: 'claude-desktop', title: 'Claude Desktop settings file is valid', status: 'ok' },
    fixed.has('restart-desktop')
      ? { id: 'desktop-restart', category: 'claude-desktop', title: 'Claude Desktop is up to date with your changes', status: 'ok' }
      : {
          id: 'desktop-restart',
          category: 'claude-desktop',
          title: 'Restart Claude Desktop to load 1 change',
          status: 'info',
          detail: 'Claude Desktop reads its tools when it starts.',
          fix: { id: 'restart-desktop', label: 'Restart now', auto: true }
        },
    fixed.has('fix-claude-path')
      ? { id: 'claude-path', category: 'claude-code', title: 'The claude command works in new terminals', status: 'ok' }
      : {
          id: 'claude-path',
          category: 'claude-code',
          title: 'The claude command isn’t on your PATH',
          status: 'warn',
          detail: `Claude Code is installed at ${homePath('.local', 'bin', env.platform === 'win32' ? 'claude.exe' : 'claude')}, but terminals can’t find it.`,
          fix: { id: 'fix-claude-path', label: 'Add to PATH', auto: true },
          docsUrl: 'https://code.claude.com/docs/en/setup'
        },
    { id: 'official-marketplace', category: 'claude-code', title: 'The official plugin marketplace is set up', status: 'ok' },
    { id: 'vscode-extension', category: 'vscode', title: 'Claude Code extension for VS Code is installed', status: 'ok', detail: 'Version 2.1.309' },
    { id: 'auth-conflict', category: 'models', title: 'No conflicting API keys', status: 'ok', detail: 'Only one sign-in method is set for Claude Code.' },
    fixed.has('remove-orphan')
      ? { id: 'orphan-project', category: 'mcp', title: 'All tool folders exist', status: 'ok' }
      : {
          id: 'orphan-project',
          category: 'mcp',
          title: 'A tool points to a folder that no longer exists',
          status: 'error',
          detail: `“sequential-thinking” is set up for ${homePath('Projects', 'old-prototype')}, which was deleted.`,
          fix: { id: 'remove-orphan', label: 'Remove it', auto: true }
        }
  ]
  if (env.platform === 'win32') {
    list.push(
      fixed.has('enable-longpaths')
        ? { id: 'git-longpaths', category: 'system', title: 'Long file paths are enabled for Git', status: 'ok' }
        : {
            id: 'git-longpaths',
            category: 'system',
            title: 'Long file paths are turned off for Git',
            status: 'warn',
            detail: 'Adding some plugin marketplaces can fail with “Filename too long”.',
            fix: { id: 'enable-longpaths', label: 'Turn on long paths', auto: true }
          }
    )
  }
  list.push({ id: 'telemetry', category: 'system', title: 'Claude Setup works offline', status: 'skip', detail: 'Network checks were skipped.' })
  return list
}

function summarize(list: DoctorCheck[]): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, error: 0, info: 0, skip: 0 }
  for (const check of list) summary[check.status]++
  return summary
}

const FIX_MESSAGES: Record<string, string> = {
  'install-uv': 'uv is installed. Python tools can now run.',
  'start-docker': 'Docker Desktop is starting — it can take a minute.',
  'restart-desktop': 'Claude Desktop restarted — your tools are ready.',
  'fix-claude-path': 'Added Claude Code to your PATH. Open a new terminal to use it.',
  'remove-orphan': 'Removed the broken tool. A backup was made first.',
  'enable-longpaths': 'Turned on long paths for Git.'
}

export const doctorApi: DoctorApi = {
  async run(): Promise<DoctorReport> {
    const steps = ['Checking runtimes…', 'Checking Claude Desktop…', 'Checking Claude Code…', 'Checking VS Code…', 'Checking your tools…']
    for (let i = 0; i < steps.length; i++) {
      emit('progress', { op: 'doctor', message: steps[i] ?? '', pct: Math.round(((i + 1) / steps.length) * 100) })
      await sleep(280)
    }
    const list = checks()
    return clone({ ranAt: new Date().toISOString(), checks: list, summary: summarize(list) })
  },

  async fix(fixId): Promise<OpResult> {
    const message = FIX_MESSAGES[fixId]
    if (!message) return { ok: false, message: 'This problem can’t be fixed automatically. Follow the steps in the details.' }
    emit('progress', { op: 'fix', message: 'Fixing…', pct: 30 })
    await sleep(fixId === 'install-uv' ? 1800 : 900)
    if (fixId === 'install-uv') {
      setRuntime('uv', { found: true, version: '0.9.4', path: homePath('.local', 'bin', env.platform === 'win32' ? 'uv.exe' : 'uv') })
      setRuntime('uvx', { found: true, version: '0.9.4', path: homePath('.local', 'bin', env.platform === 'win32' ? 'uvx.exe' : 'uvx') })
    }
    if (fixId === 'start-docker') setRuntime('docker', { running: true })
    fixed.add(fixId)
    emit('progress', { op: 'fix', message: 'Done', pct: 100 })
    log('info', 'doctor', `Applied fix ${fixId}`)
    return { ok: true, message, needsRestart: false, backupId: fixId === 'remove-orphan' ? 'auto' : undefined }
  }
}

export const runtimesApi: RuntimesApi = {
  async detect() {
    await sleep(300)
    return clone(runtimes())
  },

  async install(id): Promise<OpResult> {
    const runtime = runtimes().find((r) => r.id === id)
    if (!runtime) return { ok: false, message: 'Unknown runtime.' }
    if (runtime.found) return { ok: true, message: `${runtime.label} is already installed.` }
    if (!runtime.install?.canAutoInstall) {
      return { ok: false, message: `${runtime.label} can’t be installed automatically. Download it from ${runtime.install?.url ?? 'its website'}.` }
    }
    emit('progress', { op: `install-${id}`, message: `Downloading ${runtime.label}…`, pct: 25 })
    await sleep(900)
    emit('progress', { op: `install-${id}`, message: `Installing ${runtime.label}…`, pct: 75 })
    await sleep(900)
    setRuntime(id, { found: true, version: id === 'uv' ? '0.9.4' : '1.0.0', path: homePath('.local', 'bin', env.platform === 'win32' ? `${id}.exe` : id) })
    if (id === 'uv') setRuntime('uvx', { found: true, version: '0.9.4' })
    emit('progress', { op: `install-${id}`, message: `${runtime.label} is ready`, pct: 100 })
    return { ok: true, message: `${runtime.label} is installed.` }
  }
}
