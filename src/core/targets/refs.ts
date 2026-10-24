/** TargetRef helpers: defaults, validation, comparison and friendly labels. */
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Scope, TargetId, TargetRef } from '@shared/types'
import type { NormalizedRef } from './adapter'

/** Display order of targets everywhere in the app. */
export const TARGET_ORDER: TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']

export const TARGET_LABELS: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

/** Scopes each target supports (first one is the default). */
export const TARGET_SCOPES: Record<TargetId, Scope[]> = {
  'claude-desktop': ['user'],
  'claude-code': ['user', 'project', 'local'],
  vscode: ['user', 'project'],
  cursor: ['user', 'project'],
  windsurf: ['user']
}

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && (TARGET_ORDER as string[]).includes(value)
}

/** Compare two file-system paths the way the OS does (case-insensitive on Windows/macOS). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** Fill in the default scope and resolve the project path without validating anything. */
export function normalizeLoose(ref: TargetRef): NormalizedRef {
  const scope: Scope = ref.scope ?? TARGET_SCOPES[ref.target]?.[0] ?? 'user'
  const needsProject = scope === 'project' || scope === 'local'
  return needsProject && ref.projectPath ? { target: ref.target, scope, projectPath: resolve(ref.projectPath) } : { target: ref.target, scope }
}

export type RefCheck = { ok: true; ref: NormalizedRef } | { ok: false; message: string }

/**
 * Validate a ref: known target, supported scope, absolute existing project folder when needed.
 * Returns a friendly message instead of throwing.
 */
export async function normalizeRef(ref: TargetRef | undefined | null): Promise<RefCheck> {
  if (!ref || !isTargetId(ref.target)) {
    return { ok: false, message: 'Unknown app. Choose Claude Desktop, Claude Code, VS Code, Cursor or Windsurf.' }
  }
  const label = TARGET_LABELS[ref.target]
  const scopes = TARGET_SCOPES[ref.target]
  const scope: Scope = ref.scope ?? scopes[0]
  if (!scopes.includes(scope)) {
    return { ok: false, message: `${label} doesn't support ${scopeName(scope)} servers. Use ${scopes.map(scopeName).join(' or ')} instead.` }
  }
  if (scope === 'user') return { ok: true, ref: { target: ref.target, scope } }
  if (!ref.projectPath) return { ok: false, message: `Choose a project folder to add ${scopeName(scope)} servers to ${label}.` }
  if (!isAbsolute(ref.projectPath)) return { ok: false, message: `The project folder must be a full path (got "${ref.projectPath}").` }
  const projectPath = resolve(ref.projectPath)
  try {
    const st = await stat(projectPath)
    if (!st.isDirectory()) return { ok: false, message: `${projectPath} is a file, not a folder.` }
  } catch {
    return { ok: false, message: `The folder ${projectPath} doesn't exist.` }
  }
  return { ok: true, ref: { target: ref.target, scope, projectPath } }
}

/** The ref shape handed back to callers: single-scope apps (Claude Desktop, Windsurf) omit the scope. */
export function publicRef(ref: NormalizedRef): TargetRef {
  if (TARGET_SCOPES[ref.target].length === 1) return { target: ref.target }
  return ref.projectPath ? { target: ref.target, scope: ref.scope, projectPath: ref.projectPath } : { target: ref.target, scope: ref.scope }
}

/** True when both refs point at the same config location. */
export function sameRef(a: TargetRef, b: TargetRef): boolean {
  const x = normalizeLoose(a)
  const y = normalizeLoose(b)
  if (x.target !== y.target || x.scope !== y.scope) return false
  if (!x.projectPath && !y.projectPath) return true
  return !!x.projectPath && !!y.projectPath && samePath(x.projectPath, y.projectPath)
}

export function scopeName(scope: Scope): string {
  return scope === 'user' ? 'user-wide' : scope === 'project' ? 'project (shared)' : 'local (private, per project)'
}

/** e.g. "Claude Code (all projects)", "VS Code (my-app/.vscode/mcp.json)". */
export function refLabel(ref: NormalizedRef): string {
  const label = TARGET_LABELS[ref.target]
  if (TARGET_SCOPES[ref.target].length === 1) return label
  const project = ref.projectPath ? basename(ref.projectPath) || ref.projectPath : 'project'
  if (ref.scope === 'user') return ref.target === 'claude-code' ? `${label} (all projects)` : `${label} (user settings)`
  if (ref.scope === 'local') return `${label} (just you, in ${project})`
  if (ref.target === 'claude-code') return `${label} (shared in ${project}/.mcp.json)`
  if (ref.target === 'vscode') return `${label} (${project}/.vscode/mcp.json)`
  if (ref.target === 'cursor') return `${label} (${project}/.cursor/mcp.json)`
  return `${label} (${project})`
}
