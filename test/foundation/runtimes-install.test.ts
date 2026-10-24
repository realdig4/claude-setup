/**
 * Install flows with a simulated machine: exec (which/run/runPowerShell) and the OS are mocked, so the
 * winget / Homebrew / script paths of every platform are exercised without installing anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '../../src/core/platform/exec'
import type { CoreContext } from '../../src/core/context'
import type { OS } from '../../src/shared/types'

interface Call {
  cmd: string
  args: string[]
  opts?: RunOptions
}

const sim = vi.hoisted(() => ({
  os: 'win32' as OS,
  bins: new Map<string, string>(),
  calls: [] as Call[],
  scripts: [] as string[],
  respond: (_cmd: string, _args: string[], _opts?: RunOptions): RunResult | Promise<RunResult> => ({
    ok: false,
    code: 1,
    stdout: '',
    stderr: '',
    timedOut: false
  })
}))

vi.mock('../../src/core/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/paths')>()
  return { ...actual, currentOS: () => sim.os }
})

vi.mock('../../src/core/platform/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/exec')>()
  return {
    ...actual,
    fixPath: async () => {},
    refreshPath: async () => {},
    which: async (cmd: string) => sim.bins.get(cmd) ?? null,
    whichAll: async (cmd: string) => (sim.bins.has(cmd) ? [sim.bins.get(cmd) as string] : []),
    isExecutable: async () => false,
    run: async (cmd: string, args: string[], opts?: RunOptions) => {
      sim.calls.push({ cmd, args, opts })
      return sim.respond(cmd, args, opts)
    },
    runPowerShell: async (script: string, opts?: RunOptions) => {
      sim.scripts.push(script)
      return sim.respond('powershell', [script], opts)
    }
  }
})

const { createContext } = await import('../../src/core/context')
const { createMemorySecretStore } = await import('../../src/core/secrets')
const { detectRuntime, installRuntime, resetRuntimeCache } = await import('../../src/core/platform/runtimes')
const { withSandbox } = await import('../helpers/sandbox')

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

function ok(stdout = ''): RunResult {
  return { ok: true, code: 0, stdout, stderr: '', timedOut: false }
}

function fail(code: number, stdout = '', stderr = ''): RunResult {
  return { ok: false, code, stdout, stderr, timedOut: false }
}

async function withCtx<T>(fn: (ctx: CoreContext, progress: Array<{ message: string; pct?: number }>) => Promise<T>): Promise<T> {
  return withSandbox(async (sb) => {
    const ctx = await createContext({ surface: 'cli', appVersion: '0.0.0', dataDir: sb.dataDir, secretStore: createMemorySecretStore() })
    const progress: Array<{ message: string; pct?: number }> = []
    ctx.events.on('progress', (p) => {
      expect(p.op).toBe('install-runtime')
      progress.push({ message: p.message, pct: p.pct })
    })
    return fn(ctx, progress)
  })
}

beforeEach(() => {
  sim.os = 'win32'
  sim.bins.clear()
  sim.calls.length = 0
  sim.scripts.length = 0
  sim.respond = () => fail(1)
  resetRuntimeCache()
})

describe('Windows (winget)', () => {
  beforeEach(() => {
    sim.bins.set('winget', 'C:\\fake\\winget.exe')
  })

  it('installs Git silently with winget, reports progress and re-detects', async () => {
    sim.respond = (cmd, args, opts) => {
      if (cmd === 'C:\\fake\\winget.exe' && args[0] === 'install') {
        opts?.onOutput?.('Found Git [Git.Git] Version 2.55.0.5\r\n', 'stdout')
        sim.bins.set('git', 'C:\\fake\\git.exe')
        return ok('Successfully installed')
      }
      if (cmd === 'C:\\fake\\git.exe') return ok('git version 2.55.0.windows.1\n')
      return fail(1)
    }
    await withCtx(async (ctx, progress) => {
      const r = await installRuntime(ctx, 'git')
      expect(r).toMatchObject({ ok: true })
      expect(r.message).toContain('Git 2.55.0')
      const install = sim.calls.find((c) => c.args[0] === 'install')
      expect(install?.args).toEqual([
        'install',
        '--id',
        'Git.Git',
        '-e',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity'
      ])
      expect(install?.opts?.timeoutMs).toBe(10 * 60_000)
      expect(progress[0].message).toMatch(/Installing Git/)
      expect(progress.some((p) => p.message.includes('Found Git'))).toBe(true)
      expect(progress[progress.length - 1]).toEqual({ message: r.message, pct: 100 })
    })
  })

  it('installs Node.js when npx is requested', async () => {
    sim.respond = (cmd, args) => {
      if (args[0] === 'install') {
        sim.bins.set('npx', 'C:\\fake\\npx.cmd')
        return ok()
      }
      if (cmd === 'C:\\fake\\npx.cmd') return ok('11.6.2\n')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'npx')
      expect(r.ok).toBe(true)
      expect(sim.calls.find((c) => c.args[0] === 'install')?.args).toContain('OpenJS.NodeJS.LTS')
    })
  })

  it('maps winget failures to friendly messages', async () => {
    sim.respond = (_cmd, args) => (args[0] === 'install' ? fail(0x8a150107, 'Downloading…') : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'git')
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/internet connection/)
      expect(r.details).toContain('Downloading')
    })
  })

  it('explains a declined administrator prompt', async () => {
    sim.respond = (_cmd, args) => (args[0] === 'install' ? fail(0x8a150006, 'Installer failed with exit code: 1223') : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'git')
      expect(r.message).toMatch(/cancelled/)
    })
  })

  it('treats "already installed" as success when the tool is found', async () => {
    sim.bins.set('git', 'C:\\fake\\git.exe')
    sim.respond = (cmd, args) => {
      if (args[0] === 'install') return fail(0x8a150061, 'Package is already installed')
      if (cmd === 'C:\\fake\\git.exe') return ok('git version 2.50.1.windows.1')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'git')
      expect(r.ok).toBe(true)
      expect(r.message).toContain('2.50.1')
    })
  })

  it('asks for a restart when the installer succeeded but the tool is not visible yet', async () => {
    sim.respond = (_cmd, args) => (args[0] === 'install' ? ok('Successfully installed') : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'python')
      expect(r).toMatchObject({ ok: true, needsRestart: true })
      expect(r.message).toMatch(/Restart Claude Setup/)
    })
  })

  it('asks for a reboot when winget says so', async () => {
    sim.respond = (_cmd, args) => (args[0] === 'install' ? fail(0x8a150109) : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'git')
      expect(r).toMatchObject({ ok: true, needsRestart: true })
      expect(r.message).toMatch(/Restart your computer/)
    })
  })

  it('retries without --disable-interactivity on very old winget', async () => {
    let attempts = 0
    sim.respond = (cmd, args) => {
      if (args[0] === 'install') {
        attempts++
        if (args.includes('--disable-interactivity')) return fail(1, 'The argument provided is not recognized: --disable-interactivity')
        sim.bins.set('git', 'C:\\fake\\git.exe')
        return ok()
      }
      if (cmd === 'C:\\fake\\git.exe') return ok('git version 2.55.0')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      expect((await installRuntime(ctx, 'git')).ok).toBe(true)
      expect(attempts).toBe(2)
    })
  })

  it('installs Claude Code with the official PowerShell installer', async () => {
    sim.respond = (cmd) => {
      if (cmd === 'powershell') {
        sim.bins.set('claude', 'C:\\Users\\x\\.local\\bin\\claude.exe')
        return ok('Claude Code installed')
      }
      if (cmd === 'C:\\Users\\x\\.local\\bin\\claude.exe') return ok('2.1.309 (Claude Code)\n')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'claude')
      expect(r.ok).toBe(true)
      expect(r.message).toContain('Claude Code 2.1.309')
      expect(sim.scripts[0]).toContain("Invoke-RestMethod -UseBasicParsing -Uri 'https://claude.ai/install.ps1' -ErrorAction Stop")
      expect(sim.scripts[0]).toContain('Invoke-Expression $installer')
    })
  })

  it('installs uv with the official script', async () => {
    sim.respond = (cmd) => (cmd === 'powershell' ? ok() : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'uvx')
      expect(sim.scripts[0]).toContain("-Uri 'https://astral.sh/uv/install.ps1'")
      expect(r.message).toMatch(/uv/)
    })
  })

  it('never auto-installs Docker Desktop', async () => {
    await withCtx(async (ctx, progress) => {
      const r = await installRuntime(ctx, 'docker')
      expect(r.ok).toBe(false)
      expect(r.details).toContain('winget install --id Docker.DockerDesktop -e')
      expect(sim.calls.filter((c) => c.args[0] === 'install')).toEqual([])
      expect(progress).toEqual([])
    })
  })

  it('falls back to a manual download when winget is missing', async () => {
    sim.bins.delete('winget')
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'node')
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/winget/)
      expect(r.details).toContain('https://nodejs.org')
    })
  })

  it('runs one install at a time', async () => {
    let active = 0
    let maxActive = 0
    sim.respond = async (_cmd, args) => {
      if (args[0] !== 'install') return fail(1)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      return ok()
    }
    await withCtx(async (ctx) => {
      await Promise.all([installRuntime(ctx, 'git'), installRuntime(ctx, 'python'), installRuntime(ctx, 'code')])
      expect(maxActive).toBe(1)
      expect(sim.calls.filter((c) => c.args[0] === 'install').length).toBe(3)
    })
  })
})

describe('macOS (Homebrew)', () => {
  beforeEach(() => {
    sim.os = 'darwin'
    sim.bins.set('brew', '/opt/homebrew/bin/brew')
  })

  it('installs Node.js with brew non-interactively', async () => {
    sim.respond = (cmd, args) => {
      if (cmd === '/opt/homebrew/bin/brew' && args[0] === 'install') {
        sim.bins.set('node', '/opt/homebrew/bin/node')
        return ok()
      }
      if (cmd === '/opt/homebrew/bin/node') return ok('v26.1.0\n')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'node')
      expect(r.ok).toBe(true)
      const call = sim.calls.find((c) => c.args[0] === 'install')
      expect(call?.args).toEqual(['install', 'node'])
      expect(call?.opts?.env).toMatchObject({ NONINTERACTIVE: '1' })
    })
  })

  it('installs VS Code as a cask', async () => {
    sim.respond = () => ok()
    await withCtx(async (ctx) => {
      await installRuntime(ctx, 'code')
      expect(sim.calls.find((c) => c.args[0] === 'install')?.args).toEqual(['install', '--cask', 'visual-studio-code'])
    })
  })

  it('without Homebrew, explains how to get Node.js', async () => {
    sim.bins.delete('brew')
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'node')
      expect(r.ok).toBe(false)
      expect(r.details).toContain('nodejs.org')
    })
  })
})

describe('Linux (official scripts)', () => {
  beforeEach(() => {
    sim.os = 'linux'
    sim.bins.set('curl', '/usr/bin/curl')
    sim.bins.set('bash', '/bin/bash')
  })

  it('installs Claude Code with curl | bash and pipefail', async () => {
    sim.respond = (cmd) => {
      if (cmd === '/bin/bash') {
        sim.bins.set('claude', '/home/u/.local/bin/claude')
        return ok()
      }
      if (cmd === '/home/u/.local/bin/claude') return ok('2.1.309 (Claude Code)')
      return fail(1)
    }
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'claude')
      expect(r.ok).toBe(true)
      expect(sim.calls.find((c) => c.cmd === '/bin/bash')?.args).toEqual(['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'])
    })
  })

  it('uses wget when curl is missing', async () => {
    sim.bins.delete('curl')
    sim.bins.set('wget', '/usr/bin/wget')
    sim.respond = () => ok()
    await withCtx(async (ctx) => {
      await installRuntime(ctx, 'uv')
      expect(sim.calls.find((c) => c.cmd === '/bin/bash')?.args[1]).toContain('wget -qO- https://astral.sh/uv/install.sh | sh')
    })
  })

  it('cannot install uv without curl or wget', async () => {
    sim.bins.delete('curl')
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'uv')
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/curl or wget/)
    })
  })

  it('suggests the distribution package manager for Git', async () => {
    sim.bins.set('apt-get', '/usr/bin/apt-get')
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'git')
      expect(r.ok).toBe(false)
      expect(r.details).toContain('sudo apt install -y git')
    })
  })

  it('reports a failing installer with its last output line', async () => {
    sim.respond = (cmd) => (cmd === '/bin/bash' ? fail(1, '', 'curl: (6) Could not resolve host: claude.ai') : fail(1))
    await withCtx(async (ctx) => {
      const r = await installRuntime(ctx, 'claude')
      expect(r.ok).toBe(false)
      expect(r.message).toContain('Could not resolve host')
    })
  })
})

describe('detection details', () => {
  it('ignores the Windows Store python stub', async () => {
    sim.bins.set('python', 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe')
    sim.bins.set('python3', 'C:\\Python313\\python3.exe')
    sim.respond = (cmd) => {
      if (cmd.includes('WindowsApps')) {
        return fail(9009, '', 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut.')
      }
      if (cmd === 'C:\\Python313\\python3.exe') return ok('Python 3.13.15\n')
      return fail(1)
    }
    const info = await detectRuntime('python', { fresh: true })
    expect(info).toMatchObject({ found: true, version: '3.13.15', path: 'C:\\Python313\\python3.exe', outdated: false })
  })

  it('flags old Node.js versions as outdated', async () => {
    sim.bins.set('node', 'C:\\node\\node.exe')
    sim.respond = () => ok('v18.19.1\n')
    expect(await detectRuntime('node', { fresh: true })).toMatchObject({ found: true, version: '18.19.1', outdated: true })
  })

  it('reports whether the Docker daemon is running', async () => {
    sim.bins.set('docker', 'C:\\docker\\docker.exe')
    sim.respond = (_cmd, args) => (args[0] === 'info' ? fail(1, '', 'error during connect') : ok('Docker version 28.4.0, build abc\n'))
    expect(await detectRuntime('docker', { fresh: true })).toMatchObject({ found: true, version: '28.4.0', running: false })
    sim.respond = (_cmd, args) => (args[0] === 'info' ? ok('28.4.0\n') : ok('Docker version 28.4.0, build abc\n'))
    expect(await detectRuntime('docker', { fresh: true })).toMatchObject({ running: true })
  })

  it('counts a slow --version answer as installed', async () => {
    sim.bins.set('git', 'C:\\git\\git.exe')
    sim.respond = () => ({ ok: false, code: null, stdout: '', stderr: '', timedOut: true })
    expect(await detectRuntime('git', { fresh: true })).toMatchObject({ found: true, path: 'C:\\git\\git.exe' })
  })

  it('checks winget only on Windows and Homebrew only elsewhere', async () => {
    sim.os = 'darwin'
    expect((await detectRuntime('winget', { fresh: true })).found).toBe(false)
    sim.os = 'win32'
    expect((await detectRuntime('brew', { fresh: true })).found).toBe(false)
    expect(sim.calls).toEqual([])
  })
})
