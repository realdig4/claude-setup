/**
 * Claude Desktop process control: detect, quit (graceful, then forced), launch, restart.
 *
 * Claude Desktop reads its config once at launch and rewrites the file from memory, so config changes need a
 * full quit + relaunch (closing the window only hides it to the tray). Matching is by executable path because
 * Claude Code's CLI is also called claude.exe.
 */
import { join } from 'node:path'
import type { OpResult } from '@shared/types'
import { currentOS } from '../platform/paths'
import { DESKTOP_BUNDLE_ID, detectDesktopInstall, type DesktopInstall } from './desktopPaths'
import { safeRun, safeRunPowerShell, safeSpawnDetached } from './sys'

export interface DesktopProcess {
  pid: number
  path?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const MSIX_EXE = /\\WindowsApps\\(?:Claude|AnthropicPBC\.Claude)_[^\\]+\\(?:app\\)?claude\.exe$/i
const SQUIRREL_EXE = /\\AnthropicClaude\\app-[^\\]+\\claude\.exe$/i

/** True for Claude Desktop's main (browser) process on Windows — not its helpers, not Claude Code's claude.exe. */
export function isWindowsDesktopMain(path: string | null | undefined, commandLine: string | null | undefined): boolean {
  if (!path || !(MSIX_EXE.test(path) || SQUIRREL_EXE.test(path))) return false
  return !(commandLine ?? '').includes('--type=')
}

const LIST_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId, ExecutablePath, CommandLine)",
  'ConvertTo-Json -InputObject $p -Compress'
].join('\n')

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** Main Claude Desktop processes currently running (empty when it is not running or detection failed). */
export async function findDesktopProcesses(): Promise<DesktopProcess[]> {
  const os = currentOS()
  if (os === 'win32') {
    const r = await safeRunPowerShell(LIST_SCRIPT, { timeoutMs: 15000 })
    if (!r.ok || !r.stdout.trim()) return []
    try {
      const parsed: unknown = JSON.parse(r.stdout.trim())
      type Row = { ProcessId?: number; ExecutablePath?: string | null; CommandLine?: string | null }
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Row[]
      return rows
        .filter((row) => typeof row?.ProcessId === 'number' && isWindowsDesktopMain(row.ExecutablePath, row.CommandLine))
        .map((row) => ({ pid: row.ProcessId as number, path: row.ExecutablePath ?? undefined }))
    } catch {
      return []
    }
  }
  // macOS: the app process is "Claude" (pgrep -x is case-sensitive, so the "claude" CLI never matches).
  const args = os === 'darwin' ? ['-x', 'Claude'] : ['-o', '-x', 'claude-desktop']
  const r = await safeRun('pgrep', args, { timeoutMs: 5000 })
  return r.ok ? parsePids(r.stdout).map((pid) => ({ pid })) : []
}

export async function isDesktopRunning(): Promise<boolean> {
  return (await findDesktopProcesses()).length > 0
}

/** Process still exists (EPERM means it exists but belongs to someone else). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return true
    await sleep(250)
  }
  return !pids.some(alive)
}

/**
 * Windows graceful quit through the Restart Manager: RmShutdown sends the session-end messages Electron handles
 * by quitting cleanly (Desktop logs "Windows session ending (close-app) - quitting the app").
 */
function restartManagerScript(pids: number[]): string {
  return `$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClaudeSetupRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmShutdown(uint pSessionHandle, uint lActionFlags, IntPtr fnStatus);
  public static int Quit(int pid, long startTime) {
    uint session;
    int rc = RmStartSession(out session, 0, new StringBuilder(64));
    if (rc != 0) return rc;
    try {
      RM_UNIQUE_PROCESS p = new RM_UNIQUE_PROCESS();
      p.dwProcessId = pid;
      p.ProcessStartTime.dwLowDateTime = (int)(startTime & 0xFFFFFFFF);
      p.ProcessStartTime.dwHighDateTime = (int)(startTime >> 32);
      rc = RmRegisterResources(session, 0, null, 1, new RM_UNIQUE_PROCESS[] { p }, 0, null);
      if (rc != 0) return rc;
      return RmShutdown(session, 0, IntPtr.Zero);
    } finally { RmEndSession(session); }
  }
}
'@
if (-not ('ClaudeSetupRestartManager' -as [type])) { Add-Type -TypeDefinition $code }
$out = foreach ($id in @(${pids.join(',')})) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc) { [ClaudeSetupRestartManager]::Quit($proc.Id, $proc.StartTime.ToFileTime()) }
}
$out -join ','`
}

async function forceKill(pids: number[]): Promise<void> {
  if (currentOS() === 'win32') {
    for (const pid of pids) await safeRun('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
    return
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * Quit Claude Desktop: ask nicely first, force it after `gracefulMs` (default ~6 s).
 * Never call this without the user asking (directly or through the auto-restart setting).
 */
export async function quitDesktop(opts: { gracefulMs?: number } = {}): Promise<OpResult> {
  const gracefulMs = opts.gracefulMs ?? 6000
  const procs = await findDesktopProcesses()
  if (!procs.length) return { ok: true, message: "Claude Desktop isn't running." }
  const pids = procs.map((p) => p.pid)
  const os = currentOS()
  if (os === 'win32') {
    await safeRunPowerShell(restartManagerScript(pids), { timeoutMs: 30000 })
  } else if (os === 'darwin') {
    await safeRun('osascript', ['-e', `tell application id "${DESKTOP_BUNDLE_ID}" to quit`], { timeoutMs: 10000 })
  } else {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }
  if (await waitForExit(pids, gracefulMs)) return { ok: true, message: 'Claude Desktop was closed.' }
  await forceKill(pids)
  if (await waitForExit(pids, 5000)) return { ok: true, message: 'Claude Desktop was closed (it had to be forced to quit).' }
  return { ok: false, message: "Claude Desktop didn't close. Quit it from its tray / menu bar icon (File → Quit) and try again." }
}

/** Start Claude Desktop the way the OS would (fresh environment where possible). */
export async function launchDesktop(install?: DesktopInstall): Promise<OpResult> {
  const det = install ?? (await detectDesktopInstall())
  if (!det.installed) return { ok: false, message: "Claude Desktop isn't installed on this computer." }
  const fail: OpResult = { ok: false, message: "Couldn't start Claude Desktop. Open it from the Start menu / Applications folder." }
  const starting: OpResult = { ok: true, message: 'Claude Desktop is starting.' }
  if (det.kind === 'msix') {
    const explorer = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'explorer.exe')
    const viaAlias = () => !!det.aliasPath && safeSpawnDetached(det.aliasPath, [])
    const viaShell = () => !!det.packageFamily && safeSpawnDetached(explorer, [`shell:AppsFolder\\${det.packageFamily}!Claude`])
    const started = det.packageFamily?.startsWith('AnthropicPBC') ? viaAlias() || viaShell() : viaShell() || viaAlias()
    return started ? starting : fail
  }
  if (det.kind === 'squirrel') {
    const viaUpdate = () => !!det.updateExe && safeSpawnDetached(det.updateExe, ['--processStart', 'claude.exe'])
    const viaExe = () => !!det.appPath && safeSpawnDetached(det.appPath, [])
    return viaUpdate() || viaExe() ? starting : fail
  }
  if (det.kind === 'mac') return safeSpawnDetached('open', ['-b', DESKTOP_BUNDLE_ID]) ? starting : fail
  return safeSpawnDetached(det.appPath ?? 'claude-desktop', []) ? starting : fail
}

/**
 * Quit (if running) and relaunch Claude Desktop so it reloads its config.
 * `beforeLaunch` runs after the app is gone (used to re-apply config changes the app overwrote on exit).
 */
export async function restartDesktop(opts: { beforeLaunch?: () => Promise<void>; gracefulMs?: number } = {}): Promise<OpResult> {
  const install = await detectDesktopInstall()
  if (!install.installed) return { ok: false, message: "Claude Desktop isn't installed on this computer." }
  const wasRunning = (await findDesktopProcesses()).length > 0
  if (wasRunning) {
    const quit = await quitDesktop({ gracefulMs: opts.gracefulMs })
    if (!quit.ok) return quit
    // Give the single-instance lock a moment to be released before starting again.
    await sleep(700)
  }
  if (opts.beforeLaunch) await opts.beforeLaunch().catch(() => {})
  const launched = await launchDesktop(install)
  if (!launched.ok) return launched
  return {
    ok: true,
    message: `${wasRunning ? 'Claude Desktop restarted.' : 'Claude Desktop is starting.'} Your servers will be ready in a few seconds.`
  }
}
