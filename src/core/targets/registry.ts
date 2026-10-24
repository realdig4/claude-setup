/** One adapter instance per target per CoreContext. */
import type { TargetId } from '@shared/types'
import type { CoreContext } from '../context'
import type { TargetAdapter } from './adapter'
import { createClaudeCodeAdapter } from './claudeCode'
import { createClaudeDesktopAdapter } from './claudeDesktop'
import { createCursorAdapter } from './cursor'
import { TARGET_ORDER } from './refs'
import { createVsCodeAdapter } from './vscode'
import { createWindsurfAdapter } from './windsurf'

const cache = new WeakMap<CoreContext, Map<TargetId, TargetAdapter>>()

/** All target adapters for this context, in display order. */
export function getAdapters(ctx: CoreContext): Map<TargetId, TargetAdapter> {
  let map = cache.get(ctx)
  if (!map) {
    const created: Record<TargetId, TargetAdapter> = {
      'claude-desktop': createClaudeDesktopAdapter(ctx),
      'claude-code': createClaudeCodeAdapter(ctx),
      vscode: createVsCodeAdapter(ctx),
      cursor: createCursorAdapter(ctx),
      windsurf: createWindsurfAdapter(ctx)
    }
    map = new Map(TARGET_ORDER.map((id) => [id, created[id]]))
    cache.set(ctx, map)
  }
  return map
}

/** The adapter for one target. */
export function getAdapter(ctx: CoreContext, id: TargetId): TargetAdapter {
  const adapter = getAdapters(ctx).get(id)
  if (!adapter) throw new Error(`Unknown target: ${id}`)
  return adapter
}
