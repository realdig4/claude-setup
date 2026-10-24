/**
 * Never-throwing wrappers around the platform helpers (process spawning, PATH lookup, runtime detection),
 * so a failing helper degrades a feature instead of crashing a whole API call.
 */
import type { RuntimeInfo, RuntimeName } from '@shared/types'
import { fixPath, run, runPowerShell, spawnDetached, which, type RunOptions, type RunResult } from '../platform/exec'
import { detectRuntime, findClaudeCli } from '../platform/runtimes'

function failed(err: unknown): RunResult {
  return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: (err as Error)?.message ?? String(err) }
}

export async function safeFixPath(): Promise<void> {
  try {
    await fixPath()
  } catch {
    // PATH stays as it is
  }
}

export async function safeWhich(command: string): Promise<string | null> {
  try {
    return await which(command)
  } catch {
    return null
  }
}

/** PATH lookup that tells "not found" (null) apart from "lookup failed" (undefined). */
export async function tryWhich(command: string): Promise<string | null | undefined> {
  try {
    return await which(command)
  } catch {
    return undefined
  }
}

export async function safeRun(command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  try {
    return await run(command, args, opts)
  } catch (err) {
    return failed(err)
  }
}

export async function safeRunPowerShell(script: string, opts?: RunOptions): Promise<RunResult> {
  try {
    return await runPowerShell(script, opts)
  } catch (err) {
    return failed(err)
  }
}

/** Fire-and-forget GUI launch; false when it could not even be started. */
export function safeSpawnDetached(command: string, args: string[], opts?: { cwd?: string }): boolean {
  try {
    spawnDetached(command, args, opts)
    return true
  } catch {
    return false
  }
}

export async function safeDetectRuntime(id: RuntimeName, opts?: { fresh?: boolean }): Promise<RuntimeInfo | null> {
  try {
    return await detectRuntime(id, opts)
  } catch {
    return null
  }
}

export async function safeFindClaudeCli(): Promise<string | null> {
  try {
    return await findClaudeCli()
  } catch {
    return null
  }
}
