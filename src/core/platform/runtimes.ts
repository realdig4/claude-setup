/**
 * Runtime detection & installation. CONTRACT (owned by FOUNDATION).
 */
import type { RuntimesApi } from '@shared/api'
import type { OpResult, RuntimeInfo, RuntimeName } from '@shared/types'
import type { CoreContext } from '../context'

/** Detect one runtime (calls fixPath() first). Results cached for ~30 s unless `fresh`. */
export function detectRuntime(_id: RuntimeName, _opts?: { fresh?: boolean }): Promise<RuntimeInfo> {
  throw new Error('TODO(foundation): detectRuntime')
}

export function detectRuntimes(_opts?: { fresh?: boolean }): Promise<RuntimeInfo[]> {
  throw new Error('TODO(foundation): detectRuntimes')
}

/** Install a runtime with winget (Windows) / brew (macOS) / official script. */
export function installRuntime(_ctx: CoreContext, _id: RuntimeName): Promise<OpResult> {
  throw new Error('TODO(foundation): installRuntime')
}

/**
 * Locate the Claude Code CLI: PATH → ~/.local/bin/claude(.exe) → npm global →
 * ~/.claude/local → VS Code extension bundled binary (last resort). null if absent.
 */
export function findClaudeCli(): Promise<string | null> {
  throw new Error('TODO(foundation): findClaudeCli')
}

/** Locate the VS Code CLI (`code` / `code.cmd`) for installing extensions. */
export function findVsCodeCli(): Promise<string | null> {
  throw new Error('TODO(foundation): findVsCodeCli')
}

export function createRuntimesApi(_ctx: CoreContext): RuntimesApi {
  throw new Error('TODO(foundation): createRuntimesApi')
}
