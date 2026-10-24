/** TargetsApi: detect Claude Desktop / Claude Code / VS Code / Cursor / Windsurf. CONTRACT (owned by TARGETS). */
import { readFile } from 'node:fs/promises'
import type { TargetsApi } from '@shared/api'
import type { OpResult, TargetId, TargetInfo, TargetRef } from '@shared/types'
import type { CoreContext } from '../context'
import { reapplyPendingDesktopChanges } from './claudeDesktop'
import { restartDesktop } from './desktopProcess'
import { normalizeRef, TARGET_LABELS, TARGET_ORDER, TARGET_SCOPES } from './refs'
import { getAdapters } from './registry'

export type { TargetAdapter, NormalizedRef, SupportResult } from './adapter'
export { getAdapter, getAdapters } from './registry'
export { normalizeRef, normalizeLoose, publicRef, sameRef, refLabel, TARGET_LABELS, TARGET_ORDER, TARGET_SCOPES } from './refs'
export { findDesktopProcesses, isDesktopRunning, launchDesktop, quitDesktop } from './desktopProcess'
export { detectDesktopInstall, resolveDesktopConfig, readDesktopLogs, desktopLogDirs } from './desktopPaths'
export { findClaudeCodeExtensions, managedMcpPath } from './claudeCode'
export { serverNameProblem, SERVER_NAME_RE } from './validate'

/** Minimal info when a target's detection itself failed, so the list still renders. */
function fallbackInfo(id: TargetId, err: unknown): TargetInfo {
  return {
    id,
    label: TARGET_LABELS[id],
    description: '',
    installed: false,
    configExists: false,
    configValid: false,
    configError: `Couldn't check ${TARGET_LABELS[id]}: ${(err as Error)?.message ?? String(err)}`,
    supportsRemote: id !== 'claude-desktop',
    scopes: TARGET_SCOPES[id],
    serverCount: 0,
    notes: [],
    primary: id === 'claude-desktop' || id === 'claude-code'
  }
}

/** Build the TargetsApi on top of the per-target adapters. */
export function createTargetsApi(ctx: CoreContext): TargetsApi {
  const adapters = getAdapters(ctx)

  return {
    async list(): Promise<TargetInfo[]> {
      return Promise.all(TARGET_ORDER.map((id) => adapters.get(id)!.info().catch((err) => fallbackInfo(id, err))))
    },

    async restartDesktop(): Promise<OpResult> {
      ctx.events.emitEvent('progress', { op: 'restart-desktop', message: 'Restarting Claude Desktop…' })
      const result = await restartDesktop({ beforeLaunch: () => reapplyPendingDesktopChanges(ctx) })
      ctx.log[result.ok ? 'info' : 'warn']('targets', result.message)
      ctx.events.emitEvent('progress', { op: 'restart-desktop', message: result.message, pct: 100 })
      return result
    },

    async configPath(ref: TargetRef): Promise<string | null> {
      const check = await normalizeRef(ref)
      if (!check.ok) return null
      try {
        return await adapters.get(check.ref.target)!.configFile(check.ref)
      } catch {
        return null
      }
    },

    async readRaw(ref: TargetRef): Promise<{ path: string; exists: boolean; text: string } | null> {
      const check = await normalizeRef(ref)
      if (!check.ok) return null
      let path: string
      try {
        path = await adapters.get(check.ref.target)!.configFile(check.ref)
      } catch {
        return null
      }
      try {
        return { path, exists: true, text: await readFile(path, 'utf8') }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { path, exists: false, text: '' }
        return { path, exists: true, text: `Couldn't read this file: ${(err as Error).message}` }
      }
    }
  }
}
