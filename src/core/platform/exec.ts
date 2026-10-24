/**
 * Process helpers. CONTRACT (owned by FOUNDATION) — implement the bodies, keep the signatures.
 * - Always spawn through cross-spawn (handles npx/.cmd shims on Windows), never a shell.
 * - Strip ELECTRON_RUN_AS_NODE and NODE_OPTIONS from child environments.
 */

export interface RunOptions {
  cwd?: string
  /** Merged over cleanEnv(); a value of undefined removes the variable. */
  env?: Record<string, string | undefined>
  /** Default 30000 ms. Kills the process tree on timeout. */
  timeoutMs?: number
  /** Written to stdin, then stdin is closed. */
  input?: string
}

export interface RunResult {
  /** code === 0 and not timed out */
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn error (e.g. ENOENT) */
  error?: string
}

export function run(_command: string, _args: string[], _opts?: RunOptions): Promise<RunResult> {
  throw new Error('TODO(foundation): run')
}

/** Windows only: run a PowerShell script (-NoProfile -NonInteractive). */
export function runPowerShell(_script: string, _opts?: RunOptions): Promise<RunResult> {
  throw new Error('TODO(foundation): runPowerShell')
}

/** Resolve an executable on PATH (PATHEXT-aware on Windows). Returns absolute path or null. */
export function which(_command: string): Promise<string | null> {
  throw new Error('TODO(foundation): which')
}

/**
 * Make process.env.PATH complete for GUI-launched apps. Idempotent (runs once).
 * - macOS/Linux: read the login shell env ($SHELL -ilc env) with a 5 s timeout, then
 *   union well-known dirs (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.volta/bin, newest ~/.nvm/versions/node/x/bin, ~/.docker/bin, …).
 * - Windows: re-read Machine+User PATH from the registry (stale after winget installs)
 *   and add %USERPROFILE%\.local\bin, %APPDATA%\npm, C:\Program Files\nodejs, Docker bin.
 */
export function fixPath(): Promise<void> {
  throw new Error('TODO(foundation): fixPath')
}

/** process.env copy without ELECTRON_RUN_AS_NODE / NODE_OPTIONS, plus `extra`. */
export function cleanEnv(_extra?: Record<string, string | undefined>): Record<string, string> {
  throw new Error('TODO(foundation): cleanEnv')
}

/** Fire-and-forget launch of a GUI program (detached, ignored stdio, cleanEnv). */
export function spawnDetached(_command: string, _args: string[], _opts?: { cwd?: string }): void {
  throw new Error('TODO(foundation): spawnDetached')
}
