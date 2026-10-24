import { lstatSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanEnv,
  fixPath,
  isExecutable,
  mergePathLists,
  refreshPath,
  run,
  runPowerShell,
  spawnDetached,
  which,
  whichAll
} from '../../src/core/platform/exec'
import { withSandbox } from '../helpers/sandbox'

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

const isWin = process.platform === 'win32'
const node = process.execPath

/** existsSync() is false for App Execution Aliases (they can't be stat()ed); lstat works. */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

/** Create an executable `name` in `dir` (a .cmd on Windows, a sh script elsewhere). Returns its path. */
async function makeTool(dir: string, name: string, output = 'tool-ok'): Promise<string> {
  await mkdir(dir, { recursive: true })
  if (isWin) {
    const file = join(dir, `${name}.cmd`)
    await writeFile(file, `@echo off\r\necho ${output}\r\n`)
    return file
  }
  const file = join(dir, name)
  await writeFile(file, `#!/bin/sh\necho ${output}\n`)
  await chmod(file, 0o755)
  return file
}

describe('run()', () => {
  it('collects stdout and stderr of a successful process', async () => {
    const r = await run(node, ['-e', "process.stdout.write('hello'); process.stderr.write('oops')"])
    expect(r).toMatchObject({ ok: true, code: 0, stdout: 'hello', stderr: 'oops', timedOut: false })
    expect(r.error).toBeUndefined()
  })

  it('writes input to stdin and closes it', async () => {
    const script = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))"
    const r = await run(node, ['-e', script], { input: 'abc ✓ é' })
    expect(r.ok).toBe(true)
    expect(r.stdout).toBe('ABC ✓ É')
  })

  it('closes stdin when there is no input, so readers do not hang', async () => {
    const r = await run(node, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('eof'))"], { timeoutMs: 10_000 })
    expect(r).toMatchObject({ ok: true, stdout: 'eof', timedOut: false })
  })

  it('reports non-zero exit codes without an error', async () => {
    const r = await run(node, ['-e', 'process.exit(3)'])
    expect(r).toMatchObject({ ok: false, code: 3, timedOut: false })
    expect(r.error).toBeUndefined()
  })

  it('kills the whole process tree on timeout', async () => {
    const script = [
      "const { spawn } = require('child_process')",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(c.pid) + '\\n')",
      'setTimeout(() => {}, 60000)'
    ].join('\n')
    const started = Date.now()
    const r = await run(node, ['-e', script], { timeoutMs: 1_500 })
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
    const grandchild = Number(r.stdout.trim())
    expect(grandchild).toBeGreaterThan(0)
    expect(await waitFor(() => !isAlive(grandchild), 5_000)).toBe(true)
  })

  it('does not wait for background grandchildren that keep the output pipe open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-grace-'))
    try {
      // The script starts a background process that inherits stdout, prints "done" and exits.
      let script: string
      if (isWin) {
        script = join(dir, 'bg.cmd')
        await writeFile(script, `@echo off\r\nstart /b "" "${node}" -e "setTimeout(()=>{},8000)"\r\necho done\r\n`)
      } else {
        script = join(dir, 'bg.sh')
        await writeFile(script, `#!/bin/sh\n"${node}" -e "setTimeout(()=>{},8000)" &\necho done\n`)
        await chmod(script, 0o755)
      }
      const started = Date.now()
      const r = await run(script, [], { timeoutMs: 20_000 })
      expect(r).toMatchObject({ ok: true, code: 0, timedOut: false })
      expect(r.stdout.trim()).toBe('done')
      expect(Date.now() - started).toBeLessThan(6_000)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('returns an ENOENT error for unknown commands', async () => {
    const r = await run('definitely-not-a-real-command-xyz', ['--version'])
    expect(r.ok).toBe(false)
    expect(r.code).toBeNull()
    expect(r.error).toBe('ENOENT: definitely-not-a-real-command-xyz not found')
  })

  it('reports a missing working directory', async () => {
    const r = await run(node, ['-e', '1'], { cwd: join(tmpdir(), 'claude-setup-no-such-dir-xyz') })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Folder not found/)
  })

  it('runs in the given working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-cwd-'))
    try {
      const r = await run(node, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir })
      expect(r.stdout.toLowerCase()).toBe(dir.toLowerCase())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes env overrides and strips Electron/Node injection variables', async () => {
    const saved = { e: process.env.ELECTRON_RUN_AS_NODE, n: process.env.NODE_OPTIONS }
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--no-warnings'
    try {
      const script = 'process.stdout.write(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE ?? null, process.env.NODE_OPTIONS ?? null, process.env.CS_TEST_VAR ?? null]))'
      const r = await run(node, ['-e', script], { env: { CS_TEST_VAR: 'yes' } })
      expect(JSON.parse(r.stdout)).toEqual([null, null, 'yes'])
    } finally {
      if (saved.e === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = saved.e
      if (saved.n === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = saved.n
    }
  })

  it('streams output through onOutput while still collecting it', async () => {
    const chunks: string[] = []
    const r = await run(node, ['-e', "console.log('line one'); console.error('line two')"], {
      onOutput: (text, stream) => chunks.push(`${stream}:${text.trim()}`)
    })
    expect(r.stdout.trim()).toBe('line one')
    expect(chunks).toContain('stdout:line one')
    expect(chunks).toContain('stderr:line two')
  })

  it('handles large output', async () => {
    const r = await run(node, ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024))"])
    expect(r.ok).toBe(true)
    expect(r.stdout.length).toBe(3 * 1024 * 1024)
  })

  it.runIf(isWin)('passes tricky arguments intact through a %*-forwarding .cmd shim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-shim-'))
    try {
      await writeFile(join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      const shim = join(dir, 'my tool.cmd') // space in the path, like C:\Program Files\nodejs\npx.cmd
      await writeFile(shim, `@echo off\r\n"${node}" "%~dp0\\print.js" %*\r\n`)
      const json = '{"type":"stdio","command":"npx","args":["-y","@x/y"],"env":{"A":"b & c","P":"%PATH%","Q":"x^y|z<w>!","U":"https://h/?a=1&b=2"}}'
      const args = ['mcp', 'add-json', 'github', json, 'with space', '', 'back\\slash\\', 'quote"inside', '(paren)']
      const r = await run(shim, args)
      expect(r.ok).toBe(true)
      expect(JSON.parse(r.stdout)).toEqual(args)

      // Same when the shim is found on PATH by name.
      const savedPath = process.env.PATH
      process.env.PATH = [dir, savedPath].join(delimiter)
      try {
        const byName = await run('my tool', ['a&b'])
        expect(JSON.parse(byName.stdout)).toEqual(['a&b'])
      } finally {
        process.env.PATH = savedPath
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const wingetAlias = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'winget.exe')
  it.runIf(isWin && lstatExists(wingetAlias))(
    'reports real exit codes of App Execution Aliases (no false ENOENT)',
    async () => {
      const alias = wingetAlias
      const okRun = await run(alias, ['--version'])
      expect(okRun.ok).toBe(true)
      expect(okRun.stdout).toMatch(/\d+\.\d+/)
      const bad = await run(alias, ['--definitely-not-a-winget-flag'])
      expect(bad.error).toBeUndefined()
      expect(bad.ok).toBe(false)
      expect(bad.code).not.toBeNull()
    }
  )

  it('runs .cmd shims / scripts found on PATH (cross-spawn)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-tool-'))
    try {
      const tool = await makeTool(dir, 'cs-fake-tool', 'hello-from-tool')
      const r = await run(tool, [])
      expect(r.ok).toBe(true)
      expect(r.stdout.trim()).toBe('hello-from-tool')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('which()', () => {
  let savedPath: string | undefined
  let dir: string

  beforeEach(async () => {
    savedPath = process.env.PATH
    dir = await mkdtemp(join(tmpdir(), 'claude-setup-which-'))
  })

  afterEach(async () => {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  })

  it('finds node on PATH as an absolute path', async () => {
    const found = await which('node')
    expect(found).not.toBeNull()
    expect(await isExecutable(found as string)).toBe(true)
  })

  it('returns null for unknown commands and empty input', async () => {
    expect(await which('definitely-not-a-real-command-xyz')).toBeNull()
    expect(await which('')).toBeNull()
  })

  it('finds tools in PATH directories (PATHEXT-aware on Windows)', async () => {
    const tool = await makeTool(join(dir, 'bin'), 'cs-fake-tool')
    process.env.PATH = [join(dir, 'empty'), join(dir, 'bin'), savedPath].join(delimiter)
    expect((await which('cs-fake-tool'))?.toLowerCase()).toBe(tool.toLowerCase())
  })

  it('accepts absolute paths', async () => {
    const tool = await makeTool(dir, 'cs-fake-tool')
    expect((await which(tool))?.toLowerCase()).toBe(tool.toLowerCase())
  })

  it('ignores files that cannot be executed', async () => {
    if (isWin) {
      // .js is in PATHEXT, but cross-spawn cannot launch it: must not match.
      await writeFile(join(dir, 'cs-js-only.js'), 'console.log(1)')
    } else {
      await writeFile(join(dir, 'cs-js-only'), '#!/bin/sh\necho 1\n')
      await chmod(join(dir, 'cs-js-only'), 0o644)
    }
    process.env.PATH = dir
    expect(await which('cs-js-only')).toBeNull()
  })

  it('whichAll() lists every match in PATH order', async () => {
    const first = await makeTool(join(dir, 'a'), 'cs-dup-tool')
    const second = await makeTool(join(dir, 'b'), 'cs-dup-tool')
    process.env.PATH = [join(dir, 'a'), join(dir, 'b'), join(dir, 'a')].join(delimiter)
    const all = (await whichAll('cs-dup-tool')).map((p) => p.toLowerCase())
    expect(all).toEqual([first.toLowerCase(), second.toLowerCase()])
  })
})

describe('cleanEnv()', () => {
  it('removes ELECTRON_RUN_AS_NODE, NODE_OPTIONS and ELECTRON_NO_ATTACH_CONSOLE', () => {
    const saved = { ...process.env }
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--inspect'
    process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'
    try {
      const env = cleanEnv()
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(env.NODE_OPTIONS).toBeUndefined()
      expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined()
      expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true)
    } finally {
      for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  it('applies extra variables and removes the ones set to undefined', () => {
    process.env.CS_REMOVE_ME = 'x'
    try {
      const env = cleanEnv({ CS_ADDED: 'added', CS_REMOVE_ME: undefined })
      expect(env.CS_ADDED).toBe('added')
      expect('CS_REMOVE_ME' in env).toBe(false)
      expect(process.env.CS_REMOVE_ME).toBe('x')
    } finally {
      delete process.env.CS_REMOVE_ME
    }
  })

  it('keeps a single PATH key when overriding it with different casing', () => {
    const env = cleanEnv({ PATH: 'C:\\custom' })
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
    expect(keys).toEqual(['PATH'])
    expect(env.PATH).toBe('C:\\custom')
  })
})

describe('PATH helpers', () => {
  it('mergePathLists() keeps the first occurrence of each directory', () => {
    if (isWin) {
      expect(mergePathLists(['C:\\A', 'c:\\b\\'], ['c:\\a\\', 'C:\\B', 'C:\\C', ''])).toEqual(['C:\\A', 'c:\\b\\', 'C:\\C'])
    } else {
      expect(mergePathLists(['/a', '/b/'], ['/a/', '/b', '/c', ''])).toEqual(['/a', '/b/', '/c'])
      expect(mergePathLists(['/A'], ['/a'])).toEqual(['/A', '/a'])
    }
  })

  it('fixPath() is a no-op when CLAUDE_SETUP_SKIP_FIXPATH=1', async () => {
    const before = process.env.PATH
    await fixPath()
    expect(process.env.PATH).toBe(before)
  })

  it('refreshPath() repairs PATH: keeps existing entries and adds well-known folders', async () => {
    await withSandbox(async (sb) => {
      const savedPath = process.env.PATH
      const localBin = join(sb.home, '.local', 'bin')
      await mkdir(localBin, { recursive: true })
      delete process.env.CLAUDE_SETUP_SKIP_FIXPATH
      try {
        await refreshPath()
        const entries = (process.env.PATH ?? '').split(delimiter)
        const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
        expect(entries.map(norm)).toContain(norm(localBin))
        for (const original of (savedPath ?? '').split(delimiter).filter(Boolean)) {
          expect(entries.map(norm)).toContain(norm(original.replace(/^"(.*)"$/, '$1')))
        }
        // Idempotent: a second call reuses the first run.
        expect(fixPath()).toBe(fixPath())
      } finally {
        process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'
        process.env.PATH = savedPath
      }
    })
  }, 20_000)
})

describe.runIf(isWin)('runPowerShell()', () => {
  it('runs a script with UTF-8 output, stdin input and exit codes', async () => {
    const script = [
      "Write-Output 'héllo ✓'",
      '$in = [Console]::In.ReadToEnd()',
      'Write-Output ("got:" + $in)',
      'exit 7'
    ].join('\n')
    const r = await runPowerShell(script, { input: 'sécret "quoted"' })
    expect(r.code).toBe(7)
    const lines = r.stdout.split(/\r?\n/)
    expect(lines[0]).toBe('héllo ✓')
    expect(lines[1]).toBe('got:sécret "quoted"')
  })
})

describe('spawnDetached()', () => {
  it('launches a detached process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-setup-detached-'))
    const marker = join(dir, 'marker.txt')
    try {
      spawnDetached(node, ['-e', "require('fs').writeFileSync(process.argv[1], 'started')", marker])
      expect(await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'started', 10_000)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never throws for unknown programs', () => {
    expect(() => spawnDetached('definitely-not-a-real-command-xyz', [])).not.toThrow()
  })
})
