/**
 * Claude Setup's own bookkeeping in state.json:
 * - InstallRecord: servers installed through Claude Setup (catalog id, install time).
 * - DisabledServerRecord ("stash"): servers turned off by removing them from the app's config.
 *
 * Secrets never go into state.json, so a stashed config is stored there REDACTED (env/header values blanked,
 * credential-looking arguments masked) and the full config is kept in the secret store under `secretRef`.
 */
import { randomUUID } from 'node:crypto'
import type { DisabledServerRecord, InstallRecord, InstalledServer, ServerConfig, TargetRef } from '@shared/types'
import type { CoreContext } from '../context'
import { cloneJson } from '../fs/json'
import type { NormalizedRef } from './adapter'
import { jsonEqual } from './configDoc'
import { publicRef, sameRef } from './refs'
import { isRemoteConfig } from './validate'

/** DisabledServerRecord plus the secret-store key of the full config (see CONTRACT CHANGE REQUESTS). */
export interface StashRecord extends DisabledServerRecord {
  secretRef?: string
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|BEARER|SIGNATURE|CERT)/i
const TOKEN_PREFIX =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.|eyJ|hf_|npm_|pat_|key-|ntn_|secret_|lin_api_)/
const MASK = '***'

/** A random-looking token (API keys etc.): long, no spaces/paths, letters and digits mixed. */
function looksLikeToken(value: string): boolean {
  if (TOKEN_PREFIX.test(value) && value.length >= 12) return true
  if (value.length < 24 || /[\s/\\]/.test(value)) return false
  return /[A-Za-z]/.test(value) && /\d/.test(value) && /^[A-Za-z0-9_\-.=+:]+$/.test(value)
}

function maskUrl(raw: string): string {
  try {
    const u = new URL(raw)
    let changed = false
    if (u.password || u.username) {
      u.username = u.username ? MASK : ''
      u.password = u.password ? MASK : ''
      changed = true
    }
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (SECRET_NAME.test(k) || looksLikeToken(v)) {
        u.searchParams.set(k, MASK)
        changed = true
      }
    }
    return changed ? u.toString() : raw
  } catch {
    return raw
  }
}

/** Mask credential-looking command-line arguments (for display only). */
function maskArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const prev = i > 0 ? args[i - 1] : ''
    const eq = /^(--?[A-Za-z0-9][\w-]*)=(.*)$/.exec(a)
    if (eq && SECRET_NAME.test(eq[1])) out.push(`${eq[1]}=${MASK}`)
    else if (/^--?[A-Za-z0-9][\w-]*$/.test(prev) && SECRET_NAME.test(prev) && !a.startsWith('-')) out.push(MASK)
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) out.push(maskUrl(a))
    else if (looksLikeToken(a)) out.push(MASK)
    else out.push(a)
  }
  return out
}

/** Display-safe copy of a config: env/header values blanked, credential-looking args masked. */
export function redactConfig(config: ServerConfig): ServerConfig {
  if (isRemoteConfig(config)) {
    const out: ServerConfig = { type: config.type, url: maskUrl(config.url) }
    if (config.headers && Object.keys(config.headers).length) out.headers = Object.fromEntries(Object.keys(config.headers).map((k) => [k, '']))
    return out
  }
  const out: ServerConfig = { type: 'stdio', command: config.command }
  if (config.args?.length) out.args = maskArgs(config.args)
  if (config.env && Object.keys(config.env).length) out.env = Object.fromEntries(Object.keys(config.env).map((k) => [k, '']))
  if (config.cwd) out.cwd = config.cwd
  return out
}

// ─── Install records ─────────────────────────────────────────────────────────

export function findInstallRecord(ctx: CoreContext, name: string, ref: TargetRef): InstallRecord | undefined {
  return ctx.state.get().installs.find((r) => r.name === name && sameRef(r.target, ref))
}

/** Add or replace the install record for name + ref. */
export async function saveInstallRecord(ctx: CoreContext, record: Omit<InstallRecord, 'target'> & { target: NormalizedRef }): Promise<void> {
  const target = publicRef(record.target)
  await ctx.state.update((d) => {
    d.installs = d.installs.filter((r) => !(r.name === record.name && sameRef(r.target, target)))
    const rec: InstallRecord = { name: record.name, target, installedAt: record.installedAt }
    if (record.catalogId) rec.catalogId = record.catalogId
    if (record.optionId) rec.optionId = record.optionId
    d.installs.push(rec)
  })
}

export async function deleteInstallRecord(ctx: CoreContext, name: string, ref: TargetRef): Promise<void> {
  if (!findInstallRecord(ctx, name, ref)) return
  await ctx.state.update((d) => {
    d.installs = d.installs.filter((r) => !(r.name === name && sameRef(r.target, ref)))
  })
}

// ─── Disabled-server stash ───────────────────────────────────────────────────

export function findStash(ctx: CoreContext, name: string, ref: TargetRef): StashRecord | undefined {
  return (ctx.state.get().disabled as StashRecord[]).find((r) => r.name === name && sameRef(r.target, ref))
}

export function stashesFor(ctx: CoreContext, ref: TargetRef): StashRecord[] {
  return (ctx.state.get().disabled as StashRecord[]).filter((r) => sameRef(r.target, ref))
}

/** What a stash restores: the normalized config and, when it carries extra app-specific fields, the raw entry. */
export interface StashPayload {
  config: ServerConfig
  native?: Record<string, unknown>
}

/**
 * Remember a turned-off server. The full config (and the raw entry when given) goes to the secret store whenever
 * the redacted copy differs or a raw entry must be kept. Throws when the secret store fails (the caller reports it
 * and leaves the server untouched).
 */
export async function saveStash(
  ctx: CoreContext,
  name: string,
  ref: NormalizedRef,
  config: ServerConfig,
  native?: Record<string, unknown>
): Promise<StashRecord> {
  const previous = findStash(ctx, name, publicRef(ref))
  const redacted = redactConfig(config)
  let secretRef: string | undefined
  if (!jsonEqual(redacted, config) || native) {
    secretRef = `server-stash:${randomUUID()}`
    const payload: StashPayload = native ? { config, native } : { config }
    await ctx.secrets.set(secretRef, JSON.stringify(payload))
  }
  const record: StashRecord = { name, target: publicRef(ref), config: redacted, disabledAt: new Date().toISOString() }
  if (secretRef) record.secretRef = secretRef
  await ctx.state.update((d) => {
    d.disabled = d.disabled.filter((r) => !(r.name === name && sameRef(r.target, record.target)))
    d.disabled.push(record)
  })
  if (previous?.secretRef && previous.secretRef !== secretRef) await ctx.secrets.delete(previous.secretRef).catch(() => {})
  return record
}

/** The full config (and raw entry, if kept) of a stashed server, or null when its secret part is gone. */
export async function loadStash(ctx: CoreContext, record: StashRecord): Promise<StashPayload | null> {
  if (!record.secretRef) return { config: cloneJson(record.config) }
  try {
    const raw = await ctx.secrets.get(record.secretRef)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StashPayload> & { type?: string }
    if (parsed && typeof parsed === 'object' && parsed.config) {
      return parsed.native ? { config: parsed.config, native: parsed.native } : { config: parsed.config }
    }
    return { config: parsed as unknown as ServerConfig }
  } catch {
    return null
  }
}

export async function deleteStash(ctx: CoreContext, name: string, ref: TargetRef): Promise<void> {
  const record = findStash(ctx, name, ref)
  if (!record) return
  await ctx.state.update((d) => {
    d.disabled = d.disabled.filter((r) => !(r.name === name && sameRef(r.target, ref)))
  })
  if (record.secretRef) await ctx.secrets.delete(record.secretRef).catch(() => {})
}

/**
 * Decorate active servers with install-record info and append turned-off servers (enabled: false)
 * whose name is not active in the same place.
 */
export function withRecords(ctx: CoreContext, ref: NormalizedRef, active: InstalledServer[], primaryFile: string): InstalledServer[] {
  const pub = publicRef(ref)
  const out = active.map((s) => {
    const rec = findInstallRecord(ctx, s.name, pub)
    return rec ? { ...s, managedByUs: true, catalogId: rec.catalogId, installedAt: rec.installedAt } : s
  })
  const activeNames = new Set(active.map((s) => s.name))
  for (const st of stashesFor(ctx, pub)) {
    if (activeNames.has(st.name)) continue
    const rec = findInstallRecord(ctx, st.name, pub)
    const item: InstalledServer = {
      name: st.name,
      target: pub,
      config: cloneJson(st.config),
      enabled: false,
      configPath: primaryFile,
      managedByUs: !!rec
    }
    if (rec?.catalogId) item.catalogId = rec.catalogId
    if (rec?.installedAt) item.installedAt = rec.installedAt
    out.push(item)
  }
  return out
}
