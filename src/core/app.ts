/** AppApi: info, settings, secrets. CONTRACT (owned by FOUNDATION). */
import type { AppApi } from '@shared/api'
import type { AppInfo, AppSettings, CatalogSource, OpResult, Scope, TargetId, TargetRef } from '@shared/types'
import type { CoreContext } from './context'
import { currentOS } from './platform/paths'
import { isValidSecretRef } from './secrets'
import { DEFAULT_SOURCES } from './state'

const TARGET_IDS: readonly TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']
const SCOPES: readonly Scope[] = ['user', 'project', 'local']
const SECRET_REF_KEYS = ['smitheryKeyRef', 'glamaKeyRef', 'pulsemcpKeyRef', 'githubTokenRef'] as const
const MAX_RECENT_PROJECTS = 20

type SecretRefKey = (typeof SECRET_REF_KEYS)[number]

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeTargetRef(raw: unknown): TargetRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!TARGET_IDS.includes(r.target as TargetId)) return null
  const ref: TargetRef = { target: r.target as TargetId }
  if (r.scope !== undefined) {
    if (!SCOPES.includes(r.scope as Scope)) return null
    ref.scope = r.scope as Scope
  }
  if (typeof r.projectPath === 'string' && r.projectPath.trim()) ref.projectPath = r.projectPath.trim()
  if ((ref.scope === 'project' || ref.scope === 'local') && !ref.projectPath) return null
  return ref
}

/**
 * Apply a settings patch onto `current`. Values of the wrong type are ignored (listed in `ignored`),
 * numbers are clamped to sane ranges, `sources` is merged per key, and secret-ref keys can be
 * cleared with null/undefined.
 */
function applySettingsPatch(current: AppSettings, patch: Partial<AppSettings>): { next: AppSettings; ignored: string[] } {
  const next: AppSettings = structuredClone(current)
  const ignored: string[] = []
  const p = patch as Record<string, unknown>
  for (const key of Object.keys(p)) {
    const value = p[key]
    switch (key) {
      case 'mode':
        if (value === 'simple' || value === 'advanced') next.mode = value
        else ignored.push(key)
        break
      case 'theme':
        if (value === 'system' || value === 'light' || value === 'dark') next.theme = value
        else ignored.push(key)
        break
      case 'defaultTargets':
        if (Array.isArray(value)) {
          const seen = new Set<string>()
          next.defaultTargets = value
            .map(sanitizeTargetRef)
            .filter((r): r is TargetRef => r !== null)
            .filter((r) => {
              const k = JSON.stringify([r.target, r.scope ?? null, r.projectPath ?? null])
              if (seen.has(k)) return false
              seen.add(k)
              return true
            })
        } else ignored.push(key)
        break
      case 'sources':
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [source, enabled] of Object.entries(value)) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_SOURCES, source) && typeof enabled === 'boolean') {
              next.sources[source as CatalogSource] = enabled
            } else ignored.push(`sources.${source}`)
          }
        } else ignored.push(key)
        break
      case 'catalogTtlHours':
        if (typeof value === 'number' && Number.isFinite(value)) next.catalogTtlHours = clamp(Math.round(value), 1, 720)
        else ignored.push(key)
        break
      case 'keepBackups':
        if (typeof value === 'number' && Number.isFinite(value)) next.keepBackups = clamp(Math.round(value), 1, 500)
        else ignored.push(key)
        break
      case 'autoRestartDesktop':
      case 'onboarded':
      case 'startAtLogin':
        if (typeof value === 'boolean') next[key] = value
        else ignored.push(key)
        break
      case 'pulsemcpTenantId':
        if (value === undefined || value === null || value === '') delete next.pulsemcpTenantId
        else if (typeof value === 'string' && /^[\w.:@-]{1,200}$/.test(value.trim())) next.pulsemcpTenantId = value.trim()
        else ignored.push(key)
        break
      case 'recentProjects':
        if (Array.isArray(value)) {
          const seen = new Set<string>()
          next.recentProjects = value
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map((v) => v.trim())
            .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
            .slice(0, MAX_RECENT_PROJECTS)
        } else ignored.push(key)
        break
      default:
        if ((SECRET_REF_KEYS as readonly string[]).includes(key)) {
          const refKey = key as SecretRefKey
          if (value === undefined || value === null || value === '') delete next[refKey]
          else if (isValidSecretRef(value)) next[refKey] = value
          else ignored.push(key)
        } else ignored.push(key)
    }
  }
  return { next, ignored }
}

/** AppApi implementation: app info, persisted settings and the secret store (values never leave the core). */
export function createAppApi(ctx: CoreContext): AppApi {
  return {
    async info(): Promise<AppInfo> {
      const info: AppInfo = {
        name: 'Claude Setup',
        version: ctx.options.appVersion,
        platform: currentOS(),
        arch: process.arch,
        dataDir: ctx.dataDir,
        surface: ctx.options.surface,
        packaged: ctx.options.packaged ?? false
      }
      if (ctx.options.selfMcpConfig) info.selfMcpConfig = structuredClone(ctx.options.selfMcpConfig)
      if (ctx.options.selfMcpUnavailableReason) info.selfMcpUnavailableReason = ctx.options.selfMcpUnavailableReason
      return info
    },

    async getSettings(): Promise<AppSettings> {
      return structuredClone(ctx.state.get().settings)
    },

    async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return structuredClone(ctx.state.get().settings)
      let ignored: string[] = []
      const state = await ctx.state.update((draft) => {
        const result = applySettingsPatch(draft.settings, patch)
        ignored = result.ignored
        draft.settings = result.next
      })
      if (ignored.length) ctx.log.warn('settings', `Ignored invalid settings: ${ignored.join(', ')}`)
      ctx.events.emitEvent('state', { key: 'settings' })
      return structuredClone(state.settings)
    },

    async setSecret(ref: string, value: string | null): Promise<OpResult> {
      if (!isValidSecretRef(ref)) return { ok: false, message: 'That secret name is not valid.' }
      if (value !== null && value !== undefined && typeof value !== 'string') return { ok: false, message: 'The secret must be text.' }
      const trimmed = typeof value === 'string' ? value.trim() : ''
      try {
        if (!trimmed) {
          await ctx.secrets.delete(ref)
          ctx.events.emitEvent('state', { key: 'secrets' })
          return { ok: true, message: 'Secret removed.' }
        }
        await ctx.secrets.set(ref, trimmed)
        ctx.events.emitEvent('state', { key: 'secrets' })
        const backend = ctx.secrets.backend()
        const message = backend.startsWith('Local file')
          ? "Saved. Your system's secure storage isn't available, so it's in a local file only your account can read."
          : `Saved securely (${backend}).`
        return { ok: true, message }
      } catch (err) {
        ctx.log.error('secrets', `Could not update secret "${ref}": ${errorMessage(err)}`)
        return { ok: false, message: 'Could not save the secret.', details: errorMessage(err) }
      }
    },

    async hasSecret(ref: string): Promise<boolean> {
      if (!isValidSecretRef(ref)) return false
      try {
        return await ctx.secrets.has(ref)
      } catch (err) {
        ctx.log.warn('secrets', `Could not check secret "${ref}": ${errorMessage(err)}`)
        return false
      }
    }
  }
}
