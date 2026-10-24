import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sys = vi.hoisted(() => ({
  processes: [] as Array<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }>,
  alive: new Set<number>(),
  /** pids that exit when the Restart Manager script runs. */
  gracefulExits: true,
  scripts: [] as string[],
  runs: [] as Array<{ cmd: string; args: string[] }>,
  spawned: [] as Array<{ cmd: string; args: string[] }>
}))

vi.mock('@core/platform/exec', () => ({
  run: vi.fn(async (cmd: string, args: string[]) => {
    sys.runs.push({ cmd, args })
    if (cmd === 'taskkill') {
      const pid = Number(args[args.indexOf('/PID') + 1])
      sys.alive.delete(pid)
      sys.processes = sys.processes.filter((p) => p.ProcessId !== pid)
    }
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false }
  }),
  runPowerShell: vi.fn(async (script: string) => {
    sys.scripts.push(script)
    if (script.includes('RmShutdown') && sys.gracefulExits) {
      for (const p of sys.processes) sys.alive.delete(p.ProcessId)
      sys.processes = []
      return { ok: true, code: 0, stdout: '0', stderr: '', timedOut: false }
    }
    return { ok: true, code: 0, stdout: script.includes('Get-CimInstance') ? JSON.stringify(sys.processes.length === 1 ? sys.processes[0] : sys.processes) : '', stderr: '', timedOut: false }
  }),
  which: vi.fn(async () => null),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({})),
  spawnDetached: vi.fn((cmd: string, args: string[]) => void sys.spawned.push({ cmd, args }))
}))

import { findDesktopProcesses, isWindowsDesktopMain, launchDesktop, quitDesktop, restartDesktop } from '@core/targets/desktopProcess'
import { withSandbox } from '../helpers/sandbox'

const win = process.platform === 'win32'
const MSIX_EXE = 'C:\\Program Files\\WindowsApps\\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'

afterEach(() => {
  sys.processes = []
  sys.alive.clear()
  sys.gracefulExits = true
  sys.scripts = []
  sys.runs = []
  sys.spawned = []
  vi.restoreAllMocks()
})

function fakeAlive() {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      if (sys.alive.has(pid)) return true
      const err = new Error('ESRCH') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    }
    sys.alive.delete(pid)
    return true
  }) as typeof process.kill)
}

describe('Claude Desktop process matching', () => {
  it('matches only the main Desktop process, never Claude Code or helper processes', () => {
    expect(isWindowsDesktopMain(MSIX_EXE, `"${MSIX_EXE}"`)).toBe(true)
    expect(isWindowsDesktopMain(MSIX_EXE, `"${MSIX_EXE}" --type=gpu-process`)).toBe(false)
    expect(isWindowsDesktopMain('C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_3.1.0.0_x64__fnn82j28hfe8t\\app\\Claude.exe', 'x')).toBe(true)
    expect(isWindowsDesktopMain('C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-0.10.1\\claude.exe', 'claude.exe')).toBe(true)
    expect(isWindowsDesktopMain('C:\\Users\\me\\.local\\bin\\claude.exe', 'claude')).toBe(false)
    expect(isWindowsDesktopMain('C:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code-2.1.309-win32-x64\\resources\\native-binary\\claude.exe', 'claude')).toBe(false)
    expect(isWindowsDesktopMain(null, null)).toBe(false)
  })

  it.runIf(win)('parses the process list (single object or array)', async () => {
    sys.processes = [{ ProcessId: 10, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}"` }]
    expect(await findDesktopProcesses()).toEqual([{ pid: 10, path: MSIX_EXE }])
    sys.processes = [
      { ProcessId: 10, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}"` },
      { ProcessId: 11, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}" --type=renderer` },
      { ProcessId: 12, ExecutablePath: 'C:\\Users\\me\\.local\\bin\\claude.exe', CommandLine: 'claude' }
    ]
    expect((await findDesktopProcesses()).map((p) => p.pid)).toEqual([10])
  })
})

describe.runIf(win)('Claude Desktop quit / launch / restart (Windows)', () => {
  it('quits gracefully through the Restart Manager', async () => {
    fakeAlive()
    sys.processes = [{ ProcessId: 10, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}"` }]
    sys.alive.add(10)
    const r = await quitDesktop({ gracefulMs: 1000 })
    expect(r).toMatchObject({ ok: true, message: 'Claude Desktop was closed.' })
    expect(sys.scripts.some((s) => s.includes('RmShutdown') && s.includes('@(10)'))).toBe(true)
    expect(sys.runs.some((r) => r.cmd === 'taskkill')).toBe(false)
  })

  it('forces it to quit when it does not close in time', async () => {
    fakeAlive()
    sys.gracefulExits = false
    sys.processes = [{ ProcessId: 20, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}"` }]
    sys.alive.add(20)
    const r = await quitDesktop({ gracefulMs: 300 })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/forced/)
    expect(sys.runs).toContainEqual({ cmd: 'taskkill', args: ['/PID', '20', '/T', '/F'] })
  })

  it('says so when it is not running', async () => {
    expect(await quitDesktop()).toMatchObject({ ok: true, message: "Claude Desktop isn't running." })
  })

  it('launches the MSIX app through the shell and Squirrel through Update.exe', async () => {
    expect((await launchDesktop({ installed: true, kind: 'msix', packageFamily: 'Claude_pzs8sxrjxfjjc', aliasPath: 'C:\\x\\claude-desktop.exe' })).ok).toBe(true)
    expect(sys.spawned[0].cmd).toMatch(/explorer\.exe$/i)
    expect(sys.spawned[0].args).toEqual(['shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'])
    await launchDesktop({ installed: true, kind: 'msix', packageFamily: 'AnthropicPBC.Claude_fnn82j28hfe8t', aliasPath: 'C:\\x\\claude-desktop-msstore.exe' })
    expect(sys.spawned[1]).toEqual({ cmd: 'C:\\x\\claude-desktop-msstore.exe', args: [] })
    await launchDesktop({ installed: true, kind: 'squirrel', updateExe: 'C:\\a\\Update.exe' })
    expect(sys.spawned[2]).toEqual({ cmd: 'C:\\a\\Update.exe', args: ['--processStart', 'claude.exe'] })
    expect((await launchDesktop({ installed: false })).ok).toBe(false)
  })

  it('restart: quits, runs the hook after exit, then launches', () =>
    withSandbox(async (sb) => {
      fakeAlive()
      await mkdir(join(sb.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
      await mkdir(join(sb.localAppData, 'Microsoft', 'WindowsApps'), { recursive: true })
      await writeFile(join(sb.localAppData, 'Microsoft', 'WindowsApps', 'claude-desktop.exe'), '')
      sys.processes = [{ ProcessId: 30, ExecutablePath: MSIX_EXE, CommandLine: `"${MSIX_EXE}"` }]
      sys.alive.add(30)
      const order: string[] = []
      const r = await restartDesktop({
        gracefulMs: 1000,
        beforeLaunch: async () => {
          order.push(sys.alive.has(30) ? 'hook-while-running' : 'hook-after-exit')
        }
      })
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/restarted/)
      expect(order).toEqual(['hook-after-exit'])
      expect(sys.spawned).toHaveLength(1)
      expect(sys.spawned[0].args).toEqual(['shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'])
    }))

  it('restart reports when Desktop is not installed', () =>
    withSandbox(async () => {
      expect(await restartDesktop()).toEqual({ ok: false, message: "Claude Desktop isn't installed on this computer." })
    }))
})
