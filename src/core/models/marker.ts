/**
 * The apply marker: what Claude Setup wrote into Claude Code / VS Code settings, so later cleanups remove exactly
 * that and nothing the user owns. Stored in state.json under `modelApply` (values are tags, never secrets).
 */
import type { AppState } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject } from '../fs/json'

/** One settings file Claude Setup changed. */
export interface WrittenFile {
  /** Absolute path of the file. */
  path: string
  /** Env names we wrote that are not always-owned → valueTag() of the value we wrote. */
  env: Record<string, string>
  /** Top-level settings keys we wrote (apiKeyHelper, skipWebFetchPreflight, claudeCode.disableLoginPrompt…) → value tag. */
  settings: Record<string, string>
}

export interface ModelApplyMarker {
  /** Profile last applied to any target. */
  profileId?: string
  claudeCode?: WrittenFile
  vscode?: WrittenFile[]
  /** We set hasCompletedOnboarding in ~/.claude.json. */
  onboardingSet?: boolean
  updatedAt: string
}

type StateWithMarker = AppState & { modelApply?: unknown }

function isWrittenFile(value: unknown): value is WrittenFile {
  return isPlainObject(value) && typeof value.path === 'string' && isPlainObject(value.env) && isPlainObject(value.settings)
}

/** Current marker (validated; a damaged marker is treated as absent). */
export function readMarker(ctx: CoreContext): ModelApplyMarker {
  const raw = (ctx.state.get() as StateWithMarker).modelApply
  if (!isPlainObject(raw)) return { updatedAt: new Date(0).toISOString() }
  return {
    profileId: typeof raw.profileId === 'string' ? raw.profileId : undefined,
    claudeCode: isWrittenFile(raw.claudeCode) ? raw.claudeCode : undefined,
    vscode: Array.isArray(raw.vscode) ? raw.vscode.filter(isWrittenFile) : undefined,
    onboardingSet: raw.onboardingSet === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString()
  }
}

/** Marker entry for one VS Code settings file. */
export function vscodeMarkerFor(marker: ModelApplyMarker, path: string): WrittenFile | undefined {
  return marker.vscode?.find((f) => samePath(f.path, path))
}

/** Case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Update the marker (and optionally other state) in one persisted write.
 * `fn` receives a mutable copy of the marker.
 */
export async function updateMarker(
  ctx: CoreContext,
  fn: (marker: ModelApplyMarker) => void,
  alsoState?: (draft: AppState) => void
): Promise<void> {
  const next = readMarker(ctx)
  fn(next)
  next.updatedAt = new Date().toISOString()
  await ctx.state.update((draft) => {
    const withMarker = draft as StateWithMarker
    withMarker.modelApply = JSON.parse(JSON.stringify(next))
    alsoState?.(draft)
  })
}
