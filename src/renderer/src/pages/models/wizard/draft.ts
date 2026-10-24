/**
 * Provider setup wizard state: the draft the user edits, how it is initialised (new or editing a profile), validated
 * per step and turned into core requests. Pure (no React, no DOM) — unit-tested in Node.
 */
import type { ConnectionTestInput, ModelPreset, ModelProfile, ModelProfileInput, ModelSlot, ModelTarget, ProviderPreset } from '@shared/types'
import { recordFromRows, rowErrors, rowsFromRecord, type KeyValueRow } from '../keyValueRows'
import {
  MODEL_SLOTS,
  apiKeyError,
  cloudFields,
  contextWindowError,
  defaultCompatMode,
  defaultFastModel,
  effectiveSlots,
  envVarError,
  extraEnvWithout,
  isHttpUrl,
  isUserDefined,
  modelIdError,
  parseTokenCount,
  profileNameError,
  stripContextSuffix,
  suggestProfileName
} from '../logic'

export type StepId = 'account' | 'models' | 'test' | 'apply'

export const STEP_ORDER: readonly StepId[] = ['account', 'models', 'test', 'apply']

export interface WizardDraft {
  regionId: string
  /** Typed server address ('' = use the region's address). */
  baseUrl: string
  /** Typed API key ('' = none, or keep the saved one when editing). Never persisted by the UI. */
  apiKey: string
  /** Values for an official cloud provider's fields (AWS region, project id…). */
  cloud: Record<string, string>
  main: string
  fast: string
  /** Explicit per-slot choices made in Advanced mode (empty = follow the main/fast model). */
  overrides: Partial<Record<ModelSlot, string>>
  contextWindow: string
  compatMode: boolean
  /** The user flipped the compatibility switch (otherwise it follows the main model). */
  compatTouched: boolean
  extraEnv: KeyValueRow[]
  useKeyHelper: boolean
  name: string
  /** The user edited the name (otherwise it follows the main model). */
  nameTouched: boolean
  targets: ModelTarget[]
}

export interface DraftOptions {
  profile?: ModelProfile
  existingNames: readonly string[]
  defaultTargets: readonly ModelTarget[]
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  const clean = (u: string | undefined): string => (u ?? '').trim().replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

/** A fresh draft for a provider, or one pre-filled from an existing profile. */
export function initialDraft(preset: ProviderPreset, options: DraftOptions): WizardDraft {
  const { profile } = options
  const fields = cloudFields(preset)
  const cloudKeys = fields.map((f) => f.key)
  const targets = [...options.defaultTargets]

  if (profile) {
    const region = preset.regions.find((r) => r.id === profile.regionId) ?? preset.regions[0]
    const main = profile.models.main
    const fast = profile.models.haiku ?? ''
    const derived = effectiveSlots(preset, main, fast)
    const overrides: Partial<Record<ModelSlot, string>> = {}
    for (const slot of MODEL_SLOTS) {
      if (slot === 'main' || slot === 'haiku') continue
      const saved = profile.models[slot]
      if (saved && saved !== derived[slot]) overrides[slot] = saved
    }
    return {
      regionId: region?.id ?? '',
      baseUrl: isUserDefined(preset) || !sameUrl(profile.baseUrl, region?.baseUrl) ? profile.baseUrl : '',
      apiKey: '',
      cloud: Object.fromEntries(fields.map((f) => [f.key, profile.extraEnv[f.key] ?? f.defaultValue])),
      main,
      fast,
      overrides,
      contextWindow: profile.contextWindow ? String(profile.contextWindow) : '',
      compatMode: profile.compatMode,
      compatTouched: true,
      extraEnv: rowsFromRecord(extraEnvWithout(profile.extraEnv, cloudKeys)),
      useKeyHelper: profile.useKeyHelper ?? false,
      name: profile.name,
      nameTouched: true,
      targets
    }
  }

  const main = preset.defaults.main
  return {
    regionId: preset.regions[0]?.id ?? '',
    baseUrl: '',
    apiKey: '',
    cloud: Object.fromEntries(fields.map((f) => [f.key, f.defaultValue])),
    main,
    fast: isUserDefined(preset) ? '' : defaultFastModel(preset),
    overrides: {},
    contextWindow: '',
    compatMode: defaultCompatMode(preset, main),
    compatTouched: false,
    extraEnv: [],
    useKeyHelper: false,
    name: suggestProfileName(preset, main, options.existingNames),
    nameTouched: false,
    targets
  }
}

/** Apply a change to the main model, keeping the name and compatibility default in step unless the user changed them. */
export function withMainModel(
  draft: WizardDraft,
  preset: ProviderPreset,
  main: string,
  existingNames: readonly string[]
): WizardDraft {
  return {
    ...draft,
    main,
    name: draft.nameTouched ? draft.name : suggestProfileName(preset, main, existingNames),
    compatMode: draft.compatTouched ? draft.compatMode : defaultCompatMode(preset, main)
  }
}

/** Move a draft to a sibling preset (same service bought another way): keep what the user typed that still applies. */
export function switchPreset(draft: WizardDraft, to: ProviderPreset, existingNames: readonly string[]): WizardDraft {
  const fresh = initialDraft(to, { existingNames, defaultTargets: draft.targets })
  return {
    ...fresh,
    regionId: to.regions.some((r) => r.id === draft.regionId) ? draft.regionId : fresh.regionId,
    apiKey: draft.apiKey,
    extraEnv: draft.extraEnv,
    useKeyHelper: draft.useKeyHelper,
    name: draft.nameTouched ? draft.name : fresh.name,
    nameTouched: draft.nameTouched
  }
}

/**
 * When the provider's live list says the account gets a bigger window, move untouched default models to their `[1m]`
 * variant (e.g. Kimi Code K3.1 Pro 256K → 1M on Pro and Max plans). Null when nothing changes.
 */
export function upgradeForPlan(
  preset: ProviderPreset,
  models: readonly ModelPreset[],
  draft: WizardDraft,
  existingNames: readonly string[]
): WizardDraft | null {
  const longer = (id: string): string | null => {
    if (!id || stripContextSuffix(id) !== id) return null
    const live = models.find((m) => m.id === id)?.liveContext
    const longId = `${id}[1m]`
    return live && live >= 1_000_000 && preset.models.some((m) => m.id === longId) ? longId : null
  }
  const main = draft.main === preset.defaults.main ? longer(draft.main) : null
  const fast = draft.fast === defaultFastModel(preset) ? longer(draft.fast) : null
  if (!main && !fast) return null
  const next = main ? withMainModel(draft, preset, main, existingNames) : draft
  return fast ? { ...next, fast } : next
}

/** Providers whose key can be kept out of settings.json with Claude Code's apiKeyHelper. */
export function supportsKeyHelper(preset: ProviderPreset): boolean {
  return preset.kind === 'anthropic' || preset.kind === 'anthropic-compatible' || preset.kind === 'custom'
}

/** A key field is shown (required, optional, or optional for cloud sign-in). */
export function showsKeyField(preset: ProviderPreset): boolean {
  if (preset.kind === 'local') return false
  if (preset.requiresKey) return true
  return !!preset.keyPlaceholder || preset.kind === 'anthropic' || isUserDefined(preset)
}

export type AccountErrors = Partial<Record<'apiKey' | 'baseUrl', string>> & { cloud?: Record<string, string> }

/** Problems on the first step (key, address, cloud fields). Empty object = can continue. */
export function accountErrors(preset: ProviderPreset, draft: WizardDraft, hasStoredKey: boolean): AccountErrors {
  const errors: AccountErrors = {}
  const key = draft.apiKey.trim()
  if (preset.requiresKey && !hasStoredKey && !key) errors.apiKey = `Paste your ${preset.name} API key to continue.`
  else if (key) {
    const problem = apiKeyError(key)
    if (problem) errors.apiKey = problem
  }
  const address = draft.baseUrl.trim()
  if (isUserDefined(preset) && !address) errors.baseUrl = 'Enter the address of your server.'
  else if (address && !isHttpUrl(address)) errors.baseUrl = 'Enter a full address that starts with http:// or https://.'
  const cloud: Record<string, string> = {}
  for (const field of cloudFields(preset)) {
    if (field.required && !draft.cloud[field.key]?.trim()) cloud[field.key] = `Enter your ${field.label.toLowerCase()}.`
  }
  if (Object.keys(cloud).length) errors.cloud = cloud
  return errors
}

export type ModelErrors = Partial<Record<'main' | 'fast' | 'contextWindow', string>> & {
  slots?: Partial<Record<ModelSlot, string>>
  env?: Record<string, string>
}

/** Problems on the model step. Empty object = can continue. */
export function modelErrors(draft: WizardDraft): ModelErrors {
  const errors: ModelErrors = {}
  if (!draft.main.trim()) errors.main = 'Choose a model, or type its name.'
  else {
    const problem = modelIdError(draft.main)
    if (problem) errors.main = problem
  }
  const fast = modelIdError(draft.fast)
  if (fast) errors.fast = fast
  const slots: Partial<Record<ModelSlot, string>> = {}
  for (const slot of MODEL_SLOTS) {
    const problem = modelIdError(draft.overrides[slot] ?? '')
    if (problem) slots[slot] = problem
  }
  if (Object.keys(slots).length) errors.slots = slots
  const context = contextWindowError(draft.contextWindow)
  if (context) errors.contextWindow = context
  const env = rowErrors(draft.extraEnv, envVarError, { noun: 'variable' })
  if (Object.keys(env).length) errors.env = env
  return errors
}

/** Problems on the last step. */
export function applyErrors(draft: WizardDraft, requireTargets: boolean): Partial<Record<'name' | 'targets', string>> {
  const errors: Partial<Record<'name' | 'targets', string>> = {}
  const name = profileNameError(draft.name)
  if (name) errors.name = name
  if (requireTargets && draft.targets.length === 0) errors.targets = 'Choose at least one place to use it.'
  return errors
}

/** True when an errors object has no messages. */
export function isValid(errors: object): boolean {
  return Object.values(errors).every(
    (value) => value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)
  )
}

/** The profile to save. */
export function buildProfileInput(preset: ProviderPreset, draft: WizardDraft, profileId?: string): ModelProfileInput {
  const cloud: Record<string, string> = {}
  for (const field of cloudFields(preset)) {
    const value = draft.cloud[field.key]?.trim()
    if (value) cloud[field.key] = value
  }
  const contextWindow = parseTokenCount(draft.contextWindow)
  const input: ModelProfileInput = {
    name: draft.name.trim(),
    providerId: preset.id,
    models: effectiveSlots(preset, draft.main, draft.fast, draft.overrides),
    compatMode: preset.kind === 'openai-proxy' ? true : draft.compatMode,
    extraEnv: { ...cloud, ...recordFromRows(draft.extraEnv) },
    useKeyHelper: supportsKeyHelper(preset) ? draft.useKeyHelper : false
  }
  if (profileId) input.id = profileId
  if (draft.regionId) input.regionId = draft.regionId
  if (draft.baseUrl.trim()) input.baseUrl = draft.baseUrl.trim()
  if (draft.apiKey.trim()) input.apiKey = draft.apiKey.trim()
  if (typeof contextWindow === 'number') input.contextWindow = contextWindow
  return input
}

/** What to test (or list models for): the typed values, falling back to the saved profile's key when editing. */
export function connectionInput(preset: ProviderPreset, draft: WizardDraft, profileId?: string): ConnectionTestInput {
  const input: ConnectionTestInput = { providerId: preset.id }
  if (draft.regionId) input.regionId = draft.regionId
  if (draft.baseUrl.trim()) input.baseUrl = draft.baseUrl.trim()
  if (draft.apiKey.trim()) input.apiKey = draft.apiKey.trim()
  else if (profileId) input.profileId = profileId
  if (draft.main.trim()) input.model = draft.main.trim()
  return input
}

/** Label of the first step for this kind of provider. */
export function accountStepLabel(preset: ProviderPreset): string {
  if (preset.kind === 'cloud') return 'Your account'
  if (preset.kind === 'local') return 'Connect'
  if (isUserDefined(preset)) return 'Address'
  return preset.requiresKey ? 'Your key' : 'Sign-in'
}

/** Why the connection test is skipped by default (null = run it). */
export function testSkipReason(preset: ProviderPreset, draft: WizardDraft, hasStoredKey: boolean): string | null {
  if (preset.kind === 'cloud') {
    return (
      `${preset.name} signs in with your cloud account, so Claude Setup can’t test it here. ` +
      'After you apply it, start Claude Code and send a message to check.'
    )
  }
  if (preset.kind === 'anthropic' && !draft.apiKey.trim() && !hasStoredKey) {
    return 'Claude Code will use your Claude account, so there’s nothing to test. Sign in with claude.ai when Claude Code asks.'
  }
  return null
}
