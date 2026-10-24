/**
 * ModelsApi: third-party model providers & profiles for Claude Code / VS Code. CONTRACT (owned by MODELS).
 *
 * - providers(): curated presets (providers.ts)          - profiles()/saveProfile()/deleteProfile(): profiles.ts
 * - apply()/reset(): settings.json env + VS Code settings - status(): what Claude Code uses now + problems
 * - listModels(): live model lists                         - testConnection(): one tiny request → verdict
 */
import type { ModelsApi, ProxyApi } from '@shared/api'
import type { CoreContext } from '../context'
import { applyProfile, resetModels } from './apply'
import { testConnection } from './connection'
import { listModels } from './listModels'
import { deleteProfile, listProfiles, saveProfile } from './profiles'
import { listProviders } from './providers'
import { inspectModels, toModelStatus } from './status'

export { ANTHROPIC_CAVEAT, findProvider, listProviders } from './providers'
export { inspectModels, toModelStatus, type ModelInspection, type ModelIssue, type ModelIssueCode } from './status'
export { resolveAuthConflict, syncVsCodeWithClaudeCode } from './repair'
export { ALWAYS_OWNED_ENV, keyHelperCommand } from './ownedKeys'

export interface ModelsDeps {
  proxy: ProxyApi
}

/** Build the ModelsApi on top of the core context and the proxy (used for OpenAI-only providers). */
export function createModelsApi(ctx: CoreContext, deps: ModelsDeps): ModelsApi {
  return {
    async providers() {
      return listProviders()
    },

    profiles() {
      return listProfiles(ctx)
    },

    async saveProfile(input) {
      const profile = await saveProfile(ctx, input)
      ctx.events.emitEvent('state', { key: 'profiles' })
      return profile
    },

    async deleteProfile(id) {
      const result = await deleteProfile(ctx, id)
      if (result.ok) ctx.events.emitEvent('state', { key: 'profiles' })
      return result
    },

    async status() {
      return toModelStatus(await inspectModels(ctx, deps.proxy))
    },

    apply(req) {
      return applyProfile(ctx, deps.proxy, req)
    },

    reset(targets) {
      return resetModels(ctx, targets)
    },

    listModels(input) {
      return listModels(ctx, input)
    },

    testConnection(input) {
      return testConnection(ctx, input)
    }
  }
}
