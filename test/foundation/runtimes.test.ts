import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../../src/core/context'
import {
  createRuntimesApi,
  detectRuntime,
  detectRuntimes,
  findClaudeCli,
  findVsCodeCli,
  installRuntime,
  resetRuntimeCache,
  runtimeIdsFor
} from '../../src/core/platform/runtimes'
import { createMemorySecretStore } from '../../src/core/secrets'
import type { RuntimeName } from '../../src/shared/types'
import { withSandbox } from '../helpers/sandbox'

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

const isWin = process.platform === 'win32'
const exe = (name: string) => (isWin ? `${name}.exe` : name)
/** POSIX machines may have a real claude in a fixed system location the sandbox cannot hide. */
const systemClaude = !isWin && ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/home/linuxbrew/.linuxbrew/bin/claude'].some((p) => existsSync(p))

async function fakeBinary(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, isWin ? 'MZ' : '#!/bin/sh\necho fake\n')
  if (!isWin) await chmod(path, 0o755)
  return path
}

describe('findClaudeCli()', () => {
  let savedPath: string | undefined
  let pathDir: string

  beforeEach(async () => {
    savedPath = process.env.PATH
    pathDir = await mkdtemp(join(tmpdir(), 'claude-setup-path-'))
    process.env.PATH = pathDir // nothing on PATH unless a test puts it there
    resetRuntimeCache()
  })

  afterEach(async () => {
    process.env.PATH = savedPath
    resetRuntimeCache()
    await rm(pathDir, { recursive: true, force: true })
  })

  it.skipIf(systemClaude)('returns null when Claude Code is not installed', async () => {
    await withSandbox(async () => {
      expect(await findClaudeCli()).toBeNull()
    })
  })

  it('finds the native install in ~/.local/bin', async () => {
    await withSandbox(async (sb) => {
      const native = await fakeBinary(join(sb.home, '.local', 'bin', exe('claude')))
      expect(await findClaudeCli()).toBe(native)
    })
  })

  it('prefers a claude on PATH', async () => {
    await withSandbox(async (sb) => {
      await fakeBinary(join(sb.home, '.local', 'bin', exe('claude')))
      const onPath = await fakeBinary(join(pathDir, exe('claude')))
      expect((await findClaudeCli())?.toLowerCase()).toBe(onPath.toLowerCase())
    })
  })

  it.skipIf(systemClaude)("skips Claude Desktop's own claude.exe on PATH", async () => {
    await withSandbox(async (sb) => {
      const desktopDir = join(sb.root, 'WindowsApps', 'Claude_3.6556.1.0_x64__pzs8sxrjxfjjc', 'app')
      await fakeBinary(join(desktopDir, exe('claude')))
      const squirrelDir = join(sb.root, 'AnthropicClaude', 'app-1.0.0')
      await fakeBinary(join(squirrelDir, exe('claude')))
      process.env.PATH = [desktopDir, squirrelDir].join(isWin ? ';' : ':')
      expect(await findClaudeCli()).toBeNull()

      const native = await fakeBinary(join(sb.home, '.local', 'bin', exe('claude')))
      resetRuntimeCache()
      expect(await findClaudeCli()).toBe(native)
    })
  })

  it.skipIf(systemClaude)('falls back to the newest binary bundled with the VS Code extension', async () => {
    await withSandbox(async (sb) => {
      const ext = (v: string) => join(sb.home, '.vscode', 'extensions', `anthropic.claude-code-${v}-win32-x64`, 'resources', 'native-binary', exe('claude'))
      await fakeBinary(ext('2.1.9'))
      const newest = await fakeBinary(ext('2.1.10'))
      await mkdir(join(sb.home, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9-win32-x64'), { recursive: true }) // no binary inside
      expect(await findClaudeCli()).toBe(newest)
    })
  })
})

describe('findVsCodeCli()', () => {
  it('finds code on PATH', async () => {
    const savedPath = process.env.PATH
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-code-'))
    try {
      const file = join(dir, isWin ? 'code.cmd' : 'code')
      await writeFile(file, isWin ? '@echo 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n')
      if (!isWin) await chmod(file, 0o755)
      process.env.PATH = dir
      resetRuntimeCache()
      expect((await findVsCodeCli())?.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      process.env.PATH = savedPath
      resetRuntimeCache()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('detectRuntime()', () => {
  it('detects the Node.js that runs these tests', async () => {
    const node = await detectRuntime('node', { fresh: true })
    expect(node).toMatchObject({ id: 'node', label: 'Node.js', found: true, outdated: false })
    expect(node.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(node.path).toBeTruthy()
    expect(node.purpose).toMatch(/MCP/)
    expect(node.install?.url).toMatch(/^https:\/\//)
  })

  it('caches results for a while and returns copies', async () => {
    const a = await detectRuntime('node')
    const b = await detectRuntime('node')
    expect(b).toEqual(a)
    a.found = false
    expect((await detectRuntime('node')).found).toBe(true)
  })

  it('handles unknown ids without throwing', async () => {
    const info = await detectRuntime('dotnet' as RuntimeName)
    expect(info.found).toBe(false)
  })

  it('reports tools that are not installed', async () => {
    const savedPath = process.env.PATH
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-empty-'))
    try {
      process.env.PATH = dir
      await withSandbox(async () => {
        const uv = await detectRuntime('uv', { fresh: true })
        expect(uv.found).toBe(false)
        expect(uv.install?.command).toMatch(/astral\.sh\/uv\/install/)
        // Windows always has PowerShell for the official script; elsewhere curl/wget must be on PATH.
        if (isWin) expect(uv.install?.canAutoInstall).toBe(true)
      })
    } finally {
      process.env.PATH = savedPath
      resetRuntimeCache()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('detectRuntimes()', () => {
  it('detects every runtime for this OS concurrently and quickly', async () => {
    const savedConfig = process.env.CLAUDE_CONFIG_DIR
    const configDir = await mkdtemp(join(tmpdir(), 'claude-setup-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = configDir // never let a real `claude --version` touch the user's config
    try {
      const started = Date.now()
      const all = await detectRuntimes({ fresh: true })
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(all.map((r) => r.id)).toEqual(runtimeIdsFor())
      for (const r of all) {
        expect(r.label).toBeTruthy()
        expect(r.purpose).toBeTruthy()
        expect(typeof r.found).toBe('boolean')
        if (r.install) expect(typeof r.install.canAutoInstall).toBe('boolean')
      }
      const docker = all.find((r) => r.id === 'docker')
      expect(docker?.install?.canAutoInstall).toBe(false)
      if (isWin) expect(all.some((r) => r.id === 'winget')).toBe(true)
      else expect(all.some((r) => r.id === 'brew')).toBe(true)
    } finally {
      if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = savedConfig
      await rm(configDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('installRuntime()', () => {
  it('only explains how to install Docker Desktop (heavy, needs admin)', async () => {
    await withSandbox(async (sb) => {
      const ctx = await createContext({ surface: 'cli', appVersion: '0.0.0', dataDir: sb.dataDir, secretStore: createMemorySecretStore() })
      const progress: string[] = []
      ctx.events.on('progress', (p) => progress.push(p.message))
      const r = await installRuntime(ctx, 'docker')
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/Docker/)
      expect(r.details).toMatch(/https:\/\//)
      expect(progress).toEqual([])
    })
  })

  it('rejects unknown tools with a friendly message', async () => {
    await withSandbox(async (sb) => {
      const ctx = await createContext({ surface: 'cli', appVersion: '0.0.0', dataDir: sb.dataDir, secretStore: createMemorySecretStore() })
      const r = await createRuntimesApi(ctx).install('bogus' as RuntimeName)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/bogus/)
    })
  })
})
