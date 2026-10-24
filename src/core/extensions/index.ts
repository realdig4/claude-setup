/**
 * ExtensionsApi: Claude Code plugins & marketplaces, skills, subagents, slash commands, hooks, status lines,
 * output styles and CLAUDE.md templates. Owned by the EXTENSIONS module.
 *
 * Ids (see ids.ts): "plugin:<name>@<marketplace>", "<kind>:<source>:<owner>/<repo>/<path>" for catalog items,
 * "<kind>:local:…" for things found on disk (returned by installed()). install/uninstall/setEnabled accept all of them.
 */
import { basename, join } from 'node:path'
import type { ExtensionsApi } from '@shared/api'
import type { ClaudeMdTemplate, ExtensionItem, ExtensionKind, ExtensionQuery, OpResult, Scope } from '@shared/types'
import type { CoreContext } from '../context'
import { ExtensionsCache } from './cache'
import { Catalog, rankItems } from './catalog'
import { writeClaudeMd } from './claudeMd'
import { CATALOG_SOURCES, EXTENSION_KINDS, parseId, type CatalogId, type LocalId, type ParsedId } from './ids'
import { failure, resolveTarget, type Target } from './installers/common'
import { installMarkdown, removeMarkdown, setMarkdownEnabled } from './installers/file'
import { addMarketplace, installPlugin, listMarketplaces, removeMarketplace, setPluginEnabled, uninstallPlugin } from './installers/plugin'
import { installSettingsItem, removeSettingsItem, setSettingsItemEnabled } from './installers/settings'
import { installSkill, removeSkill, setSkillEnabled, skillFolderName } from './installers/skill'
import { readInstalledPlugins, scanInstalled, type InstalledEntry } from './installed'
import { fileScope, isFileKind, kindDir } from './paths'
import { InstallRegistry } from './registry'
import { DIRECTORY_FAMILY } from './sources/marketplaces'
import { CLAUDE_MD_TEMPLATES } from './templates'
import { toPublicItem, type CatalogItem, type ExtEnv } from './types'
import { errorMessage, samePath } from './util'

const DEFAULT_LIMIT = 60
const MAX_LIMIT = 500

function sanitizeQuery(query: ExtensionQuery | undefined): ExtensionQuery & { limit: number } {
  const q = query ?? {}
  const kind = q.kind && EXTENSION_KINDS.includes(q.kind) ? q.kind : undefined
  const source = q.source && (CATALOG_SOURCES.includes(q.source) || q.source === 'local') ? q.source : undefined
  const limit = Number.isFinite(q.limit) && (q.limit as number) > 0 ? Math.min(MAX_LIMIT, Math.floor(q.limit as number)) : DEFAULT_LIMIT
  const text = typeof q.query === 'string' ? q.query.slice(0, 200) : undefined
  return { kind, source, query: text, limit }
}

/** "abc.md" / "abc.md.disabled" → "abc" (lowercase) for name matching. */
function stem(file: string): string {
  return basename(file)
    .replace(/\.disabled$/i, '')
    .replace(/\.md$/i, '')
    .toLowerCase()
}

type ScopeOpts = { scope?: Scope; projectPath?: string }

/** Folder (skills) or file name (agents, commands, output styles) a catalog item gets on disk. */
function diskName(id: CatalogId): string {
  if (id.kind === 'skill') return id.source === 'skills.sh' ? id.path : skillFolderName(id.path, id.repo)
  return basename(id.path)
}

/** Pick the user-scope entry when there are several. */
function preferUser(entries: InstalledEntry[]): InstalledEntry | undefined {
  return entries.find((e) => e.scope === 'user') ?? entries[0]
}

/** The local-id key of an installed entry. */
function entryKey(entry: InstalledEntry): string | undefined {
  const parsed = parseId(entry.item.id)
  return parsed?.type === 'local' ? parsed.key : undefined
}

export function createExtensionsApi(ctx: CoreContext): ExtensionsApi {
  const env: ExtEnv = {
    ctx,
    cache: new ExtensionsCache(join(ctx.cacheDir, 'extensions')),
    registry: InstallRegistry.at(ctx.dataDir),
    progress: (message, pct) => ctx.events.emitEvent('progress', { op: 'extensions', message, pct })
  }
  const catalog = new Catalog(env)

  // Search-as-you-type re-marks results on every keystroke: reuse a very recent scan (dropped after any change).
  let scanMemo: { at: number; entries: Promise<InstalledEntry[]> } | undefined
  const recentScan = (): Promise<InstalledEntry[]> => {
    if (!scanMemo || Date.now() - scanMemo.at > 2000) scanMemo = { at: Date.now(), entries: scanInstalled(env) }
    return scanMemo.entries
  }
  /** After a change: forget the scan memo and tell the surfaces (GUI refreshes its lists on state 'extensions'). */
  const changed = (result: OpResult): OpResult => {
    scanMemo = undefined
    if (result.ok) ctx.events.emitEvent('state', { key: 'extensions' })
    return result
  }
  // Changes run one at a time within this process (two installs must not edit settings.json concurrently).
  let queue: Promise<unknown> = Promise.resolve()
  const serial = (fn: () => Promise<OpResult>): Promise<OpResult> => {
    const job = queue.then(fn, fn).then(changed)
    queue = job.catch(() => undefined)
    return job
  }

  /** Mark catalog items that are already installed (registry first, then by plugin id / file name). */
  async function markInstalled(items: CatalogItem[]): Promise<void> {
    if (!items.length) return
    const entries = await recentScan()
    const byPlugin = new Map<string, InstalledEntry[]>()
    const byRecord = new Map<string, InstalledEntry[]>()
    const byName = new Map<string, InstalledEntry[]>()
    const push = (m: Map<string, InstalledEntry[]>, k: string, e: InstalledEntry) => m.set(k, [...(m.get(k) ?? []), e])
    for (const e of entries) {
      if (e.pluginId) push(byPlugin, e.pluginId.toLowerCase(), e)
      if (e.record) push(byRecord, e.record.id, e)
      if (isFileKind(e.kind)) push(byName, `${e.kind}:${e.kind === 'skill' ? basename(e.path).toLowerCase() : stem(e.path)}`, e)
    }
    for (const item of items) {
      let found: InstalledEntry | undefined
      if (item.kind === 'plugin') {
        for (const id of [item.id, ...(item.aliases ?? [])]) {
          found = preferUser(byPlugin.get(id.replace(/^plugin:/, '').toLowerCase()) ?? [])
          if (found) break
        }
      } else {
        found = preferUser(byRecord.get(item.id) ?? [])
        const parsed = found ? null : parseId(item.id)
        if (!found && parsed?.type === 'catalog' && isFileKind(parsed.kind)) {
          const name = parsed.kind === 'skill' ? diskName(parsed).toLowerCase() : stem(parsed.path)
          found = preferUser(byName.get(`${parsed.kind}:${name}`) ?? [])
        }
      }
      if (found) {
        item.installed = true
        item.installedPath = found.item.installedPath
        item.scope = found.scope
        item.enabled = found.item.enabled
      }
    }
  }

  /**
   * The installed variant of a plugin: the id itself, or an equivalent id it was merged with in the catalog
   * (e.g. "x@anthropic-plugin-directory" shown as "x@claude-plugins-official"). undefined when none is installed.
   */
  async function installedVariant(pluginId: string): Promise<string | undefined> {
    const ids = new Set((await readInstalledPlugins()).map((r) => r.pluginId))
    if (ids.has(pluginId)) return pluginId
    const meta = await catalog.lookup(`plugin:${pluginId}`)
    for (const alias of meta?.aliases ?? []) {
      const id = alias.replace(/^plugin:/, '')
      if (ids.has(id)) return id
    }
    const at = pluginId.lastIndexOf('@')
    const [name, marketplace] = [pluginId.slice(0, at), pluginId.slice(at + 1)]
    if (!DIRECTORY_FAMILY.has(marketplace)) return undefined
    for (const id of ids) {
      const i = id.lastIndexOf('@')
      if (id.slice(0, i) === name && DIRECTORY_FAMILY.has(id.slice(i + 1))) return id
    }
    return undefined
  }

  /** Where a plugin is installed (user scope first). */
  async function pluginTarget(pluginId: string, opts?: ScopeOpts): Promise<Target> {
    if (opts?.scope) return resolveTarget(opts)
    const records = (await readInstalledPlugins()).filter((p) => p.pluginId === pluginId)
    const user = records.find((r) => r.rec.scope === 'user')
    if (user || !records.length) return { scope: 'user' }
    const first = records[0].rec
    return first.projectPath ? { scope: first.scope, projectPath: first.projectPath } : { scope: 'user' }
  }

  /** Installed entry for a local id. */
  async function findLocal(id: LocalId): Promise<InstalledEntry | undefined> {
    const entries = await scanInstalled(env, id.kind, id.projectPath ? [id.projectPath] : [])
    const scope = isFileKind(id.kind) ? fileScope(id.scope) : id.scope
    return entries.find((e) => {
      if (e.kind !== id.kind || entryKey(e) === undefined) return false
      const key = entryKey(e) as string
      const sameKey = process.platform === 'win32' ? key.toLowerCase() === id.key.toLowerCase() : key === id.key
      if (!sameKey) return false
      if (scope === 'user') return e.scope === 'user'
      return e.scope === scope && !!e.projectPath && !!id.projectPath && samePath(e.projectPath, id.projectPath)
    })
  }

  /** Installed entry for a catalog id (our registry first, then the expected file location). */
  async function findCatalog(id: CatalogId, raw: string, opts?: ScopeOpts): Promise<InstalledEntry | undefined> {
    const target = opts?.scope ? await resolveTarget(opts) : undefined
    const recordScope = target?.scope && isFileKind(id.kind) ? fileScope(target.scope) : target?.scope
    const records = await env.registry.findById(raw, recordScope, target?.projectPath)
    const projects = [...new Set([...records.map((r) => r.projectPath), target?.projectPath].filter((p): p is string => !!p))]
    const entries = await scanInstalled(env, id.kind, projects)
    const viaRecord = preferUser(entries.filter((e) => e.record && records.some((r) => r.key === e.record?.key)))
    if (viaRecord) return viaRecord
    if (!isFileKind(id.kind)) {
      // A hook / status line we installed but that was later edited away by hand: still let it be cleaned up.
      const rec = records.find((r) => r.scope === 'user') ?? records[0]
      if (!rec) return undefined
      return {
        kind: rec.kind,
        scope: rec.scope,
        projectPath: rec.projectPath,
        path: rec.path,
        record: rec,
        hooks: rec.hooks,
        item: {
          id: raw,
          kind: rec.kind,
          name: rec.name,
          description: rec.description ?? '',
          source: rec.source,
          installed: true,
          installedPath: rec.path,
          scope: rec.scope,
          enabled: !rec.disabled
        }
      }
    }
    const scope = fileScope(target?.scope)
    const dir = kindDir(id.kind, scope, target?.projectPath)
    const expected = join(dir, diskName(id))
    return entries.find((e) => samePath(e.path, expected) || samePath(e.path, expected + '.disabled'))
  }

  async function findEntry(parsed: ParsedId, raw: string, opts?: ScopeOpts): Promise<InstalledEntry | undefined> {
    if (parsed.type === 'local') return findLocal(parsed)
    if (parsed.type === 'catalog') return findCatalog(parsed, raw, opts)
    return undefined
  }

  const invalidId = (id: string): OpResult => ({ ok: false, message: "That extension id isn't valid.", details: String(id) })
  const notInstalled: OpResult = { ok: false, message: "It isn't installed (or it was already removed)." }

  async function install(id: string, opts?: ScopeOpts): Promise<OpResult> {
    const parsed = parseId(id)
    if (!parsed) return invalidId(id)
    if (parsed.type === 'local') return { ok: true, message: 'This is already installed.' }
    try {
      const target = await resolveTarget(opts)
      let result: OpResult
      if (parsed.type === 'plugin') {
        const variant = await installedVariant(parsed.pluginId)
        if (variant && variant !== parsed.pluginId) {
          return { ok: true, message: `The "${parsed.name}" plugin is already installed (from ${variant.slice(variant.lastIndexOf('@') + 1)}).` }
        }
        result = await installPlugin(env, parsed.name, parsed.marketplace, target)
      }
      else {
        const meta = await catalog.lookup(id)
        switch (parsed.kind) {
          case 'skill':
            result = await installSkill(env, parsed, target, id, meta)
            break
          case 'agent':
          case 'command':
          case 'output-style':
            result = await installMarkdown(env, parsed, target, id, meta)
            break
          case 'hook':
          case 'statusline':
            result = await installSettingsItem(env, parsed, target, id, meta)
            break
          default:
            return invalidId(id)
        }
      }
      const where = target.projectPath ? `${target.scope} ${target.projectPath}` : target.scope
      ctx.log.info('extensions', `${result.ok ? 'Installed' : 'Could not install'} ${id} (${where}): ${result.message}`)
      return result
    } catch (err) {
      return failure(err, "The extension couldn't be installed.")
    }
  }

  async function uninstall(id: string, opts?: ScopeOpts): Promise<OpResult> {
    const parsed = parseId(id)
    if (!parsed) return invalidId(id)
    try {
      let result: OpResult
      if (parsed.type === 'plugin') {
        const pluginId = (await installedVariant(parsed.pluginId)) ?? parsed.pluginId
        result = await uninstallPlugin(env, pluginId, await pluginTarget(pluginId, opts))
      }
      else if (parsed.type === 'local' && parsed.kind === 'plugin') {
        result = await uninstallPlugin(env, parsed.key, { scope: parsed.scope, projectPath: parsed.projectPath })
      } else {
        const entry = await findEntry(parsed, id, opts)
        if (!entry) return notInstalled
        switch (entry.kind) {
          case 'skill':
            result = await removeSkill(env, entry)
            break
          case 'agent':
          case 'command':
          case 'output-style':
            result = await removeMarkdown(env, entry)
            break
          case 'hook':
          case 'statusline':
            result = await removeSettingsItem(env, entry)
            break
          default:
            return invalidId(id)
        }
      }
      ctx.log.info('extensions', `${result.ok ? 'Removed' : 'Could not remove'} ${id}: ${result.message}`)
      return result
    } catch (err) {
      return failure(err, "The extension couldn't be removed.")
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<OpResult> {
    const parsed = parseId(id)
    if (!parsed) return invalidId(id)
    const on = enabled !== false
    try {
      if (parsed.type === 'plugin') {
        const pluginId = (await installedVariant(parsed.pluginId)) ?? parsed.pluginId
        return await setPluginEnabled(env, pluginId, on, await pluginTarget(pluginId))
      }
      if (parsed.type === 'local' && parsed.kind === 'plugin') {
        return await setPluginEnabled(env, parsed.key, on, { scope: parsed.scope, projectPath: parsed.projectPath })
      }
      const entry = await findEntry(parsed, id)
      if (!entry) return notInstalled
      switch (entry.kind) {
        case 'skill':
          return await setSkillEnabled(env, entry, on)
        case 'agent':
        case 'command':
        case 'output-style':
          return await setMarkdownEnabled(env, entry, on)
        case 'hook':
        case 'statusline':
          return await setSettingsItemEnabled(env, entry, on)
        default:
          return invalidId(id)
      }
    } catch (err) {
      return failure(err, "The extension couldn't be changed.")
    }
  }

  return {
    async search(query: ExtensionQuery): Promise<ExtensionItem[]> {
      const q = sanitizeQuery(query)
      try {
        if (q.source === 'local') {
          const entries = await scanInstalled(env, q.kind)
          const local = entries.map((e) => e.item as CatalogItem)
          return rankItems(local, { ...q, source: undefined })
            .slice(0, q.limit)
            .map(toPublicItem)
        }
        const ranked = rankItems(await catalog.load(q), q).slice(0, q.limit)
        await markInstalled(ranked)
        return ranked.map(toPublicItem)
      } catch (err) {
        ctx.log.error('extensions', `Search failed: ${errorMessage(err)}`)
        return []
      }
    },

    async installed(kind?: ExtensionKind): Promise<ExtensionItem[]> {
      try {
        const entries = await scanInstalled(env, kind && EXTENSION_KINDS.includes(kind) ? kind : undefined)
        // Plugins without a description in their own manifest: borrow it from the cached catalog.
        for (const e of entries) {
          if (e.kind !== 'plugin' || !e.pluginId || e.item.description) continue
          const meta = await catalog.lookup(`plugin:${e.pluginId}`)
          if (!meta) continue
          e.item.description = meta.description
          e.item.url ??= meta.url
          e.item.author ??= meta.author
          e.item.category ??= meta.category
        }
        const order: ExtensionKind[] = ['plugin', 'skill', 'agent', 'command', 'hook', 'statusline', 'output-style']
        return entries
          .map((e) => toPublicItem(e.item as CatalogItem))
          .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
      } catch (err) {
        ctx.log.error('extensions', `Listing installed extensions failed: ${errorMessage(err)}`)
        return []
      }
    },

    install: (id, opts) => serial(() => install(id, opts)),

    uninstall: (id, opts) => serial(() => uninstall(id, opts)),

    setEnabled: (id, enabled) => serial(() => setEnabled(id, enabled)),

    async marketplaces() {
      try {
        const { counts, directoryOn } = await catalog.marketplaceStats()
        return await listMarketplaces(counts, directoryOn)
      } catch (err) {
        ctx.log.error('extensions', `Listing marketplaces failed: ${errorMessage(err)}`)
        return []
      }
    },

    addMarketplace: (source) => serial(() => addMarketplace(env, source)),

    removeMarketplace: (name) => serial(() => removeMarketplace(env, name)),

    async refresh(): Promise<OpResult> {
      await env.cache.deletePrefix('')
      ctx.events.emitEvent('state', { key: 'extensions' })
      return { ok: true, message: 'Catalog cleared — the next search downloads fresh lists from every source.' }
    },

    async claudeMdTemplates(): Promise<ClaudeMdTemplate[]> {
      return CLAUDE_MD_TEMPLATES.map((t) => ({ ...t }))
    },

    writeClaudeMd: (templateId, where, replace) => serial(() => writeClaudeMd(env, templateId, where, replace))
  }
}
