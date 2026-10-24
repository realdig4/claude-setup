/** Model profiles: a provider + region/address + models + options. API keys live in the secret store only. */
import { randomBytes } from 'node:crypto'
import type { ModelProfile, ModelProfileInput, ModelSlot, OpResult, ProviderPreset } from '@shared/types'
import type { CoreContext } from '../context'
import { PROTECTED_EXTRA_ENV } from './ownedKeys'
import { findProvider, findRegion } from './providers'
import { isClaudeModel, isHttpUrl, stripTrailingV1, trimSlashes } from './urls'

export const MODEL_SLOTS: readonly ModelSlot[] = ['main', 'opus', 'sonnet', 'haiku', 'fable', 'subagent']

/** Secret store reference holding a profile's API key. */
export function profileSecretRef(profileId: string): string {
  return `profile:${profileId}`
}

/** Profile by id from state. */
export function getProfile(ctx: CoreContext, id: string | undefined): ModelProfile | undefined {
  return id ? ctx.state.get().profiles.find((p) => p.id === id) : undefined
}

/** All profiles; `hasKey` is refreshed from the secret store (falls back to the stored flag). */
export async function listProfiles(ctx: CoreContext): Promise<ModelProfile[]> {
  const profiles = structuredClone(ctx.state.get().profiles)
  return Promise.all(
    profiles.map(async (p) => {
      if (!p.keyRef) return { ...p, hasKey: false }
      try {
        return { ...p, hasKey: await ctx.secrets.has(p.keyRef) }
      } catch {
        return p
      }
    })
  )
}

function fail(message: string): never {
  throw new Error(message)
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return slug || 'profile'
}

function newProfileId(ctx: CoreContext, name: string): string {
  const taken = new Set(ctx.state.get().profiles.map((p) => p.id))
  for (;;) {
    const id = `${slugify(name)}-${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

/** Clean up a pasted key: trim, drop surrounding quotes and a "Bearer " prefix. */
export function cleanApiKey(raw: string): string {
  let key = raw.trim().replace(/^["']|["']$/g, '').trim()
  key = key.replace(/^Bearer\s+/i, '')
  if (/\s/.test(key)) fail('The API key contains spaces or line breaks. Copy it again from the provider\'s website.')
  return key
}

/** Typed address (cleaned) → the same-provider profile's address for an unchanged region → the region's address. */
function resolveBaseUrl(preset: ProviderPreset, input: ModelProfileInput, prev: ModelProfile | undefined, regionId?: string): string {
  if (preset.kind === 'cloud') return ''
  const typed = input.baseUrl?.trim()
  let url: string
  if (typed) url = preset.kind === 'openai-proxy' ? trimSlashes(typed) : stripTrailingV1(typed)
  else if (prev && prev.regionId === regionId && prev.baseUrl) url = prev.baseUrl
  else url = findRegion(preset, regionId)?.baseUrl ?? ''
  if (!url) {
    const example = preset.kind === 'openai-proxy' ? ' (for example http://localhost:8000/v1)' : ''
    fail(`Enter the address of your ${preset.name} server${example}.`)
  }
  if (!isHttpUrl(url)) fail(`"${url}" is not a web address. It should start with http:// or https://.`)
  return url
}

function validModelId(id: string, slot: ModelSlot): string {
  if (id.length > 200 || /[\s\u0000-\u001f]/.test(id)) fail(`The ${slot} model "${id.slice(0, 60)}" is not a valid model name.`)
  return id
}

function resolveModels(preset: ProviderPreset, input: ModelProfileInput): ModelProfile['models'] {
  const main = input.models?.main?.trim()
  if (!main) fail('Choose a model for this profile.')
  const usesPresetDefaults = main === preset.defaults.main
  const models: Record<ModelSlot, string> = { main: validModelId(main, 'main'), opus: '', sonnet: '', haiku: '', fable: '', subagent: '' }
  for (const slot of MODEL_SLOTS) {
    if (slot === 'main') continue
    const given = input.models[slot]?.trim()
    const fallback = usesPresetDefaults ? preset.defaults[slot] || main : main
    models[slot] = validModelId(given || fallback, slot)
  }
  return models
}

function resolveExtraEnv(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, value] of Object.entries(input ?? {})) {
    const key = rawKey.trim()
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`"${key}" is not a valid environment variable name.`)
    if (PROTECTED_EXTRA_ENV.includes(key)) {
      fail(`${key} can't be set as an extra variable — it comes from the provider, the model choices or the API key field.`)
    }
    out[key] = value === undefined || value === null ? '' : String(value)
  }
  return out
}

function resolveContextWindow(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isFinite(value) || value < 1024 || value > 10_000_000) fail('The context window must be between 1,024 and 10,000,000 tokens.')
  return Math.round(value)
}

/** Default for compatibility mode: on for third-party models, off for Claude itself and the official clouds. */
export function defaultCompatMode(preset: ProviderPreset, mainModel: string): boolean {
  if (preset.kind === 'anthropic' || preset.kind === 'cloud') return false
  if (preset.kind === 'openai-proxy') return true
  return !isClaudeModel(mainModel)
}

/** Create or update a profile. Throws an Error with a friendly message for invalid input. */
export async function saveProfile(ctx: CoreContext, input: ModelProfileInput): Promise<ModelProfile> {
  const name = input.name?.trim()
  if (!name) fail('Give the profile a name.')
  if (name.length > 80) fail('Profile names can be at most 80 characters long.')
  const preset = findProvider(input.providerId) ?? fail(`Unknown provider "${input.providerId}".`)

  const existing = getProfile(ctx, input.id)
  /** The existing profile when it uses the same provider (its settings carry over). */
  const prev = existing && existing.providerId === preset.id ? existing : undefined
  const regionId = findRegion(preset, input.regionId ?? prev?.regionId)?.id
  const baseUrl = resolveBaseUrl(preset, input, prev, regionId)
  const models = resolveModels(preset, input)
  const extraEnv = input.extraEnv !== undefined ? resolveExtraEnv(input.extraEnv) : { ...(prev?.extraEnv ?? {}) }
  let contextWindow: number | undefined
  if (input.contextWindow !== undefined) contextWindow = resolveContextWindow(input.contextWindow)
  else if (prev && prev.models.main === models.main) contextWindow = prev.contextWindow
  else if (models.main === preset.defaults.main) contextWindow = preset.contextWindow
  const compatMode = preset.kind === 'openai-proxy' || (input.compatMode ?? prev?.compatMode ?? defaultCompatMode(preset, models.main))

  const id = existing?.id ?? (input.id && /^[a-z0-9-]{1,64}$/.test(input.id) ? input.id : newProfileId(ctx, name))
  const ref = profileSecretRef(id)
  const typedKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? cleanApiKey(input.apiKey) : undefined

  let hasKey = Boolean(existing?.hasKey && existing.keyRef)
  if (typedKey) {
    try {
      await ctx.secrets.set(ref, typedKey)
    } catch (err) {
      fail(`Couldn't save the API key securely: ${(err as Error).message}`)
    }
    hasKey = true
  } else if (existing && !prev && hasKey) {
    // Never send one provider's key to another provider.
    await ctx.secrets.delete(existing.keyRef ?? ref).catch(() => {})
    hasKey = false
  }

  const now = new Date().toISOString()
  const profile: ModelProfile = {
    id,
    name,
    providerId: preset.id,
    regionId,
    baseUrl,
    keyRef: hasKey ? ref : undefined,
    hasKey,
    models,
    compatMode,
    extraEnv,
    contextWindow,
    useKeyHelper: input.useKeyHelper ?? prev?.useKeyHelper ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  if (profile.contextWindow === undefined) delete profile.contextWindow
  if (profile.regionId === undefined) delete profile.regionId
  if (profile.keyRef === undefined) delete profile.keyRef

  await ctx.state.update((draft) => {
    const index = draft.profiles.findIndex((p) => p.id === id)
    if (index >= 0) draft.profiles[index] = profile
    else draft.profiles.push(profile)
  })
  ctx.log.info('models', `${existing ? 'Updated' : 'Created'} model profile "${name}" (${preset.name})`)
  return structuredClone(profile)
}

/** Delete a profile and its saved key. An active profile's settings stay in place until the user changes them. */
export async function deleteProfile(ctx: CoreContext, id: string): Promise<OpResult> {
  const profile = getProfile(ctx, id)
  if (!profile) return { ok: false, message: 'That profile no longer exists.' }
  const wasActive = ctx.state.get().activeProfileId === id
  let keyNote = ''
  if (profile.keyRef) {
    try {
      await ctx.secrets.delete(profile.keyRef)
    } catch (err) {
      keyNote = ` (the saved key couldn't be removed: ${(err as Error).message})`
    }
  }
  await ctx.state.update((draft) => {
    draft.profiles = draft.profiles.filter((p) => p.id !== id)
    if (draft.activeProfileId === id) delete draft.activeProfileId
  })
  ctx.log.info('models', `Deleted model profile "${profile.name}"`)
  if (!wasActive) return { ok: true, message: `Deleted "${profile.name}"${keyNote}.` }
  const message = `Deleted "${profile.name}"${keyNote}. Claude Code is still set up with it — choose another model or "Use Claude" to change that.`
  const keyGone = profile.useKeyHelper || findProvider(profile.providerId)?.kind === 'openai-proxy'
  if (!keyGone) return { ok: true, message }
  return { ok: true, message, details: 'Its saved API key was removed, so Claude Code will fail to sign in with it until you pick another model.' }
}
