/**
 * Shared TargetAdapter implementation for apps whose servers live in a name → entry map inside JSON / JSONC files.
 * Each target supplies its file locations and native entry mapping; this module does the safe read → backup →
 * formatting-preserving write → (optional) verify cycle and produces friendly results.
 */
import type { InstalledServer, ServerConfig, TargetChangeResult, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import type { AddOptions, FoundServer, NormalizedRef, SupportResult, TargetAdapter } from './adapter'
import {
  ConfigDocError,
  editConfigDoc,
  editsApplied,
  getAt,
  getMap,
  jsonEqual,
  readConfigDoc,
  type ConfigDoc,
  type DocEdit,
  type DocFormat
} from './configDoc'
import { withRecords } from './records'
import { publicRef, refLabel, TARGET_SCOPES } from './refs'

export interface Location {
  file: string
  format: DocFormat
  /** Server maps that are read (and cleaned on remove). */
  mapPaths: string[][]
  /** Server maps written on add (defaults to mapPaths). */
  writeMapPaths?: string[][]
  /** POSIX permission bits for a newly created file. */
  createMode?: number
  /** Entry shape for this file when it differs from the adapter's default (e.g. Windsurf vs Devin files). */
  toNative?: (config: ServerConfig) => Record<string, unknown>
}

export interface ChangeInfo {
  kind: 'add' | 'remove'
  ref: NormalizedRef
  name: string
  /** Native entry written (add only). */
  native?: Record<string, unknown>
  files: string[]
}

export interface AfterChange {
  needsRestart?: boolean
  note?: string
}

export interface ConfigSummary {
  configPath: string
  configExists: boolean
  configValid: boolean
  configError?: string
  /** Servers in the primary file's map(s). */
  serverCount: number
  doc: ConfigDoc
  servers: Record<string, unknown>
}

export interface FileAdapterSpec {
  id: TargetAdapter['id']
  label: string
  description: string
  primary: boolean
  supportsRemote: boolean
  /** Primary location first; further entries are mirrors kept in sync. */
  locations(ref: NormalizedRef): Promise<Location[]>
  toNative(config: ServerConfig): Record<string, unknown>
  fromNative(entry: unknown): ServerConfig | null
  supports(config: ServerConfig): SupportResult
  prepare?(config: ServerConfig): Promise<ServerConfig>
  /** Final check of the native entry (e.g. Claude Desktop's schema). Returns a friendly problem or null. */
  validateEntry?(name: string, native: Record<string, unknown>): string | null
  /** Refuse any write for this ref (e.g. enterprise-managed MCP). Returns the reason or null. */
  writeBlocker?(ref: NormalizedRef): Promise<string | null>
  /** Re-read after writing and retry once if another process overwrote the change (Claude Code). */
  verifyWrites?: boolean
  /** Runs after a successful change (e.g. Desktop restart detection). */
  afterChange?(change: ChangeInfo): Promise<AfterChange>
  /** Message when the existing file can't be parsed (nothing is written). */
  invalidFileMessage(file: string, error: string): string
  /** Extra sentence after "Added …" (how the app picks the change up). */
  addedHint?(ref: NormalizedRef): string
  /** The snippet layout, e.g. { mcpServers: { name: entry } }. */
  snippetWrapper(ref: NormalizedRef, name: string, native: Record<string, unknown>): unknown
  info(tools: { summarize(ref: NormalizedRef): Promise<ConfigSummary> }): Promise<TargetInfo>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

/** Friendly text for a failed write. */
function writeError(spec: FileAdapterSpec, file: string, err: unknown): string {
  if (err instanceof ConfigDocError) return err.kind === 'invalid' ? spec.invalidFileMessage(file, err.message) : err.message
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return `Couldn't save ${file} because access was denied. Close any program that has it open (or check its permissions) and try again.`
  }
  if (code === 'EROFS') return `Couldn't save ${file} because the disk is read-only.`
  if (code === 'ENOSPC') return `Couldn't save ${file} because the disk is full.`
  return `Couldn't save ${file}: ${errMessage(err)}`
}

function backupFailed(spec: FileAdapterSpec, err: unknown): string {
  return `Couldn't make a backup before changing ${spec.label}'s settings, so nothing was changed. (${errMessage(err)})`
}

/** The post-change hook never turns a successful write into a failure. */
async function runAfterChange(spec: FileAdapterSpec, change: ChangeInfo): Promise<AfterChange> {
  if (!spec.afterChange) return {}
  try {
    return await spec.afterChange(change)
  } catch {
    return {}
  }
}

/** Build a TargetAdapter from a spec. */
export function createFileAdapter(ctx: CoreContext, spec: FileAdapterSpec): TargetAdapter {
  const prepare = async (config: ServerConfig) => (spec.prepare ? spec.prepare(config) : config)

  async function writeVerified(loc: Location, edits: DocEdit[]): Promise<void> {
    await editConfigDoc(loc.file, loc.format, edits, { createMode: loc.createMode })
    if (!spec.verifyWrites) return
    await sleep(200)
    if (await editsApplied(loc.file, loc.format, edits)) return
    await editConfigDoc(loc.file, loc.format, edits, { createMode: loc.createMode })
    await sleep(200)
    if (await editsApplied(loc.file, loc.format, edits)) return
    const message = `Another program kept changing ${loc.file} at the same moment, so the change didn't stick. Close it (or wait a few seconds) and try again.`
    throw new ConfigDocError(message, loc.file, 'conflict')
  }

  async function summarize(ref: NormalizedRef): Promise<ConfigSummary> {
    const [primary] = await spec.locations(ref)
    const doc = await readConfigDoc(primary.file, primary.format)
    const servers: Record<string, unknown> = {}
    for (const mp of primary.mapPaths) {
      for (const [name, entry] of Object.entries(getMap(doc.data, mp))) if (!(name in servers)) servers[name] = entry
    }
    const s: ConfigSummary = {
      configPath: primary.file,
      configExists: doc.exists,
      configValid: doc.valid,
      serverCount: Object.keys(servers).length,
      doc,
      servers
    }
    if (doc.error) s.configError = doc.error
    return s
  }

  const adapter: TargetAdapter = {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    scopes: TARGET_SCOPES[spec.id],
    supportsRemote: spec.supportsRemote,
    primary: spec.primary,

    info: () => spec.info({ summarize }),

    async configFile(ref) {
      return (await spec.locations(ref))[0].file
    },

    async configFiles(ref) {
      return (await spec.locations(ref)).map((l) => l.file)
    },

    async list(ref): Promise<InstalledServer[]> {
      const locs = await spec.locations(ref)
      const found = new Map<string, InstalledServer>()
      for (const loc of locs) {
        const doc = await readConfigDoc(loc.file, loc.format)
        if (!doc.valid) continue
        for (const mp of loc.mapPaths) {
          for (const [name, entry] of Object.entries(getMap(doc.data, mp))) {
            if (found.has(name)) continue
            const config = spec.fromNative(entry)
            if (!config) continue
            found.set(name, { name, target: publicRef(ref), config, enabled: true, configPath: loc.file, managedByUs: false })
          }
        }
      }
      return withRecords(ctx, ref, [...found.values()], locs[0].file)
    },

    async exists(ref, name): Promise<boolean> {
      for (const loc of await spec.locations(ref)) {
        const doc = await readConfigDoc(loc.file, loc.format)
        if (doc.valid && loc.mapPaths.some((mp) => getAt(doc.data, [...mp, name]) !== undefined)) return true
      }
      return false
    },

    async get(ref, name): Promise<FoundServer | null> {
      for (const loc of await spec.locations(ref)) {
        const doc = await readConfigDoc(loc.file, loc.format)
        if (!doc.valid) continue
        for (const mp of loc.mapPaths) {
          const native = getAt(doc.data, [...mp, name])
          if (native === undefined) continue
          const config = spec.fromNative(native)
          if (config) return { name, config, native, configPath: loc.file }
        }
      }
      return null
    },

    async add(ref, name, config, opts: AddOptions = {}): Promise<TargetChangeResult> {
      const target = publicRef(ref)
      const where = refLabel(ref)
      const fail = (message: string, extra: Partial<TargetChangeResult> = {}): TargetChangeResult => ({ target, ok: false, message, ...extra })

      const blocker = await spec.writeBlocker?.(ref)
      if (blocker) return fail(blocker)
      const support = spec.supports(config)
      if (!support.ok) return fail(support.reason ?? `${spec.label} can't use this server.`)
      let prepared: ServerConfig
      try {
        prepared = await prepare(config)
      } catch (err) {
        return fail(`Couldn't prepare the server for ${spec.label}: ${errMessage(err)}`)
      }
      const locs = await spec.locations(ref)
      // A verbatim native entry (restoring a turned-off server) applies to the primary file; mirrors get the conversion.
      const nativeFor = (loc: Location) => (opts.native && loc === locs[0] ? opts.native : (loc.toNative ?? spec.toNative)(prepared))
      const native = nativeFor(locs[0])
      const problem = spec.validateEntry?.(name, native)
      if (problem) return fail(problem)

      const configPath = locs[0].file
      const docs = await Promise.all(locs.map((l) => readConfigDoc(l.file, l.format)))
      if (!docs[0].valid) return fail(spec.invalidFileMessage(configPath, docs[0].error ?? 'unknown problem'), { configPath })

      const skipped: string[] = []
      const writes: Array<{ loc: Location; edits: DocEdit[] }> = []
      let conflict = false
      locs.forEach((loc, i) => {
        const doc = docs[i]
        if (!doc.valid) return void skipped.push(loc.file)
        const native = nativeFor(loc)
        for (const mp of loc.mapPaths) {
          const existing = getAt(doc.data, [...mp, name])
          if (existing !== undefined && !jsonEqual(existing, native)) conflict = true
        }
        const edits = (loc.writeMapPaths ?? loc.mapPaths)
          .filter((mp) => !jsonEqual(getAt(doc.data, [...mp, name]), native))
          .map((mp) => ({ path: [...mp, name], value: native }))
        if (edits.length) writes.push({ loc, edits })
      })
      if (conflict && !opts.overwrite) {
        return fail(`${where} already has a different server named "${name}". Choose another name, or replace the existing one.`, { configPath })
      }
      if (!writes.length) return { target, ok: true, message: `"${name}" is already set up in ${where}.`, configPath, written: native }

      let backupId: string
      try {
        const reason = `${conflict ? 'Replace' : 'Add'} MCP server "${name}" in ${where}`
        backupId = (await ctx.backups.snapshot(reason, writes.map((w) => w.loc.file))).id
      } catch (err) {
        return fail(backupFailed(spec, err), { configPath })
      }
      for (const w of writes) {
        try {
          await writeVerified(w.loc, w.edits)
        } catch (err) {
          return fail(writeError(spec, w.loc.file, err), { configPath, backupId })
        }
      }
      ctx.log.info('targets', `${conflict ? 'Replaced' : 'Added'} "${name}" in ${writes.map((w) => w.loc.file).join(', ')}`)
      const after = await runAfterChange(spec, { kind: 'add', ref, name, native, files: writes.map((w) => w.loc.file) })
      const parts = [`${conflict ? 'Updated' : 'Added'} "${name}" in ${where}.`]
      if (support.reason && !opts.native) parts.push(support.reason)
      const hint = spec.addedHint?.(ref)
      if (hint) parts.push(hint)
      if (after.note) parts.push(after.note)
      if (skipped.length) parts.push(`Skipped ${skipped.join(', ')} because it can't be read.`)
      const result: TargetChangeResult = { target, ok: true, message: parts.join(' '), configPath, backupId, written: native }
      if (after.needsRestart) result.needsRestart = true
      return result
    },

    async remove(ref, name): Promise<TargetChangeResult> {
      const target = publicRef(ref)
      const where = refLabel(ref)
      const fail = (message: string, extra: Partial<TargetChangeResult> = {}): TargetChangeResult => ({ target, ok: false, message, ...extra })

      const blocker = await spec.writeBlocker?.(ref)
      if (blocker) return fail(blocker)
      const locs = await spec.locations(ref)
      const configPath = locs[0].file
      const docs = await Promise.all(locs.map((l) => readConfigDoc(l.file, l.format)))
      if (!docs[0].valid) return fail(spec.invalidFileMessage(configPath, docs[0].error ?? 'unknown problem'), { configPath })

      const writes: Array<{ loc: Location; edits: DocEdit[] }> = []
      locs.forEach((loc, i) => {
        const doc = docs[i]
        if (!doc.valid) return
        const edits: DocEdit[] = []
        for (const mp of loc.mapPaths) {
          const map = getMap(doc.data, mp)
          if (!Object.prototype.hasOwnProperty.call(map, name)) continue
          // Leave a tidy "{}" instead of an empty multi-line object when the last server goes.
          edits.push(Object.keys(map).length === 1 ? { path: mp, value: {} } : { path: [...mp, name], value: undefined })
        }
        if (edits.length) writes.push({ loc, edits })
      })
      if (!writes.length) return fail(`There's no server named "${name}" in ${where}.`, { configPath })

      let backupId: string
      try {
        backupId = (await ctx.backups.snapshot(`Remove MCP server "${name}" from ${where}`, writes.map((w) => w.loc.file))).id
      } catch (err) {
        return fail(backupFailed(spec, err), { configPath })
      }
      for (const w of writes) {
        try {
          await writeVerified(w.loc, w.edits)
        } catch (err) {
          return fail(writeError(spec, w.loc.file, err), { configPath, backupId })
        }
      }
      ctx.log.info('targets', `Removed "${name}" from ${writes.map((w) => w.loc.file).join(', ')}`)
      const after = await runAfterChange(spec, { kind: 'remove', ref, name, files: writes.map((w) => w.loc.file) })
      const parts = [`Removed "${name}" from ${where}.`]
      if (after.note) parts.push(after.note)
      const result: TargetChangeResult = { target, ok: true, message: parts.join(' '), configPath, backupId }
      if (after.needsRestart) result.needsRestart = true
      return result
    },

    prepare,
    toNative: (config) => spec.toNative(config),
    fromNative: (entry) => spec.fromNative(entry),
    supports: (config) => spec.supports(config),

    async snippet(ref, name, config) {
      const [primary] = await spec.locations(ref)
      const native = (primary.toNative ?? spec.toNative)(await prepare(config))
      return JSON.stringify(spec.snippetWrapper(ref, name, native), null, 2)
    }
  }
  return adapter
}
