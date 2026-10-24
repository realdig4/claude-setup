/** Resolve a ConnectionTestInput (profile and/or provider, region, address, key, model) for list/test calls. */
import type { ConnectionTestInput, ModelProfile, ProviderPreset, ProviderRegion } from '@shared/types'
import type { CoreContext } from '../context'
import { cleanApiKey, getProfile } from './profiles'
import { findProvider, findRegion } from './providers'
import { stripTrailingV1, trimSlashes } from './urls'

export interface ResolvedConnection {
  preset: ProviderPreset
  profile?: ModelProfile
  region?: ProviderRegion
  /** Effective base URL ('' when unknown / not applicable). */
  baseUrl: string
  /** API key (never logged or returned). */
  key?: string
  model?: string
}

/** Work out provider, address, key and model. Returns { error } with a friendly message when impossible. */
export async function resolveConnection(ctx: CoreContext, input: ConnectionTestInput): Promise<ResolvedConnection | { error: string }> {
  const profile = input?.profileId ? getProfile(ctx, input.profileId) : undefined
  if (input?.profileId && !profile) return { error: 'That model profile no longer exists.' }
  const preset = findProvider(input?.providerId ?? profile?.providerId)
  if (!preset) return { error: input?.providerId ? `Unknown provider "${input.providerId}".` : 'Choose a provider first.' }

  const fromProfile = profile && profile.providerId === preset.id ? profile : undefined
  const region = findRegion(preset, input.regionId ?? fromProfile?.regionId)
  const typedUrl = input.baseUrl?.trim()
  let baseUrl: string
  if (typedUrl) baseUrl = preset.kind === 'openai-proxy' ? trimSlashes(typedUrl) : stripTrailingV1(typedUrl)
  else if (fromProfile && (!input.regionId || input.regionId === fromProfile.regionId)) baseUrl = fromProfile.baseUrl
  else baseUrl = region?.baseUrl ?? ''

  let key: string | undefined
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    try {
      key = cleanApiKey(input.apiKey)
    } catch (err) {
      return { error: (err as Error).message }
    }
  } else if (fromProfile?.keyRef) {
    try {
      key = (await ctx.secrets.get(fromProfile.keyRef)) ?? undefined
    } catch {
      key = undefined
    }
  }
  if (!key && preset.defaultKey && preset.kind !== 'openai-proxy') key = preset.defaultKey

  const model = input.model?.trim() || fromProfile?.models.main || preset.defaults.main || undefined
  return { preset, profile: fromProfile, region, baseUrl, key, model }
}
