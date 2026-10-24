/**
 * Scan what is installed for Claude Code, for the user and for recent projects:
 *   skills (folders with SKILL.md), agents / commands / output styles (.md, or .md.disabled when switched off),
 *   plugins (plugins/installed_plugins.json + enabledPlugins), hooks and status lines (settings files),
 *   plus hooks / status lines parked in our registry while switched off.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { ExtensionItem, ExtensionKind, Scope } from '@shared/types'
import { isPlainObject, readJson } from '../fs/json'
import { claudeConfigDir } from '../platform/paths'
import { fmString, parseFrontmatter } from './frontmatter'
import { localItemId, pluginItemId, PLUGIN_NAME_RE } from './ids'
import { FILE_KIND_DIRS, installedPluginsPath, settingsPathFor, type FileKind } from './paths'
import type { RegistryRecord } from './registry'
import { peekSettings } from './settingsFile'
import { hasHook, hookRefHash, listHooks, normalizeMatcher, skillOverride, validateStatusLine, type HookRef } from './settingsMerge'
import type { ExtEnv } from './types'
import { clip, deepEqual, pathKey, samePath, toPosix } from './util'

/** One installed extension plus what is needed to act on it. */
export interface InstalledEntry {
  item: ExtensionItem
  kind: ExtensionKind
  scope: Scope
  projectPath?: string
  /** Skill folder, .md file (as currently named), plugin install folder, or settings file. */
  path: string
  /** Set when Claude Setup installed it (or parked it). */
  record?: RegistryRecord
  /** Skill name used by skillOverrides (frontmatter name, else folder name). */
  skillName?: string
  /** Hook handlers represented by this entry. */
  hooks?: HookRef[]
  /** Plugin id "name@marketplace". */
  pluginId?: string
}

export interface ScopeBase {
  scope: 'user' | 'project'
  projectPath?: string
  /** ~/.claude or <project>/.claude */
  base: string
}

/** User scope plus each existing recent project (skipping any whose .claude is the user folder). */
export async function scopeBases(env: ExtEnv, extraProjects: string[] = []): Promise<ScopeBase[]> {
  const userBase = claudeConfigDir()
  const out: ScopeBase[] = [{ scope: 'user', base: userBase }]
  const seen = new Set<string>([pathKey(userBase)])
  for (const p of [...(env.ctx.state.settings().recentProjects ?? []), ...extraProjects]) {
    if (typeof p !== 'string' || !p.trim()) continue
    const base = join(p, '.claude')
    if (seen.has(pathKey(base))) continue
    const s = await stat(p).catch(() => null)
    if (!s?.isDirectory()) continue
    seen.add(pathKey(base))
    out.push({ scope: 'project', projectPath: p, base })
  }
  return out
}

async function readHead(file: string, max = 128 * 1024): Promise<string> {
  const buf = await readFile(file).catch(() => null)
  return buf ? buf.subarray(0, max).toString('utf8') : ''
}

/** Directory entries; symlinks to folders count as folders. */
async function listDir(dir: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: Array<{ name: string; isDir: boolean; isFile: boolean }> = []
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      const s = await stat(join(dir, e.name)).catch(() => null)
      if (s) out.push({ name: e.name, isDir: s.isDirectory(), isFile: s.isFile() })
    } else out.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })
  }
  return out
}

/** Path of SKILL.md inside a folder (any letter case), or null. */
export async function findSkillFile(dir: string): Promise<string | null> {
  const entries = await listDir(dir)
  const hit = entries.find((e) => e.isFile && e.name === 'SKILL.md') ?? entries.find((e) => e.isFile && e.name.toLowerCase() === 'skill.md')
  return hit ? join(dir, hit.name) : null
}

function recordFor(records: RegistryRecord[], kind: ExtensionKind, path: string): RegistryRecord | undefined {
  const key = pathKey(path).replace(/\.disabled$/, '')
  return records.find((r) => r.kind === kind && pathKey(r.path).replace(/\.disabled$/, '') === key)
}

async function scanSkills(
  sb: ScopeBase,
  records: RegistryRecord[],
  overrideSources: Array<Record<string, unknown>>
): Promise<InstalledEntry[]> {
  const dir = join(sb.base, FILE_KIND_DIRS.skill)
  const out: InstalledEntry[] = []
  for (const e of await listDir(dir)) {
    if (!e.isDir || e.name.startsWith('.') || e.name.toLowerCase() === 'synced') continue
    const folder = join(dir, e.name)
    const skillFile = await findSkillFile(folder)
    if (!skillFile) continue
    const fm = parseFrontmatter(await readHead(skillFile))
    const skillName = fmString(fm.data, 'name') ?? e.name
    const enabled = !overrideSources.some((s) => skillOverride(s, skillName) === 'off')
    const record = recordFor(records, 'skill', folder)
    out.push({
      kind: 'skill',
      scope: sb.scope,
      projectPath: sb.projectPath,
      path: folder,
      record,
      skillName,
      item: {
        id: localItemId('skill', sb.scope, e.name, sb.projectPath),
        kind: 'skill',
        name: skillName,
        description: clip(fmString(fm.data, 'description') ?? '', 600),
        source: record?.source ?? 'local',
        repo: record?.repo,
        url: record?.url,
        installed: true,
        installedPath: folder,
        scope: sb.scope,
        enabled
      }
    })
  }
  return out
}

async function walkMarkdown(dir: string, recursive: boolean, depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const e of await listDir(dir)) {
    const full = join(dir, e.name)
    if (e.isDir && recursive && depth < 6 && !e.name.startsWith('.')) out.push(...(await walkMarkdown(full, recursive, depth + 1)))
    else if (e.isFile && /\.md(\.disabled)?$/i.test(e.name)) out.push(full)
  }
  return out
}

/** "frontend/component.md" → "/frontend:component" */
function commandName(rel: string): string {
  return '/' + rel.replace(/\.md$/i, '').split('/').join(':')
}

async function scanMarkdownKind(kind: Exclude<FileKind, 'skill'>, sb: ScopeBase, records: RegistryRecord[]): Promise<InstalledEntry[]> {
  const dir = join(sb.base, FILE_KIND_DIRS[kind])
  const files = await walkMarkdown(dir, kind !== 'output-style')
  const out: InstalledEntry[] = []
  const seen = new Set<string>()
  // Active files first so a stray ".disabled" twin never hides the real one.
  files.sort((a, b) => Number(a.endsWith('.disabled')) - Number(b.endsWith('.disabled')))
  for (const file of files) {
    const rel = toPosix(relative(dir, file)).replace(/\.disabled$/i, '')
    if (seen.has(rel.toLowerCase())) continue
    seen.add(rel.toLowerCase())
    const fm = parseFrontmatter(await readHead(file, 64 * 1024))
    const base = basename(rel).replace(/\.md$/i, '')
    const name = kind === 'command' ? commandName(rel) : (fmString(fm.data, 'name') ?? base)
    const description = fmString(fm.data, 'description') ?? firstLine(fm.body)
    const record = recordFor(records, kind, file)
    const enabled = !/\.disabled$/i.test(file)
    out.push({
      kind,
      scope: sb.scope,
      projectPath: sb.projectPath,
      path: file,
      record,
      item: {
        id: localItemId(kind, sb.scope, rel, sb.projectPath),
        kind,
        name,
        description: clip(description, 600),
        source: record?.source ?? 'local',
        repo: record?.repo,
        url: record?.url,
        installed: true,
        installedPath: file,
        scope: sb.scope,
        enabled
      }
    })
  }
  return out
}

function firstLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0)
  return line ?? ''
}

interface PluginRecord {
  scope: Scope
  installPath?: string
  version?: string
  projectPath?: string
}

/** Records from installed_plugins.json (version 2: id → array; older files: id → object). */
export async function readInstalledPlugins(): Promise<Array<{ pluginId: string; rec: PluginRecord }>> {
  const r = await readJson<unknown>(installedPluginsPath())
  const plugins = isPlainObject(r.data) && isPlainObject(r.data.plugins) ? r.data.plugins : undefined
  if (!plugins) return []
  const out: Array<{ pluginId: string; rec: PluginRecord }> = []
  for (const [pluginId, value] of Object.entries(plugins)) {
    const list = Array.isArray(value) ? value : [value]
    for (const v of list) {
      if (!isPlainObject(v)) continue
      const scope: Scope = v.scope === 'project' || v.scope === 'local' ? v.scope : 'user'
      out.push({
        pluginId,
        rec: {
          scope,
          installPath: typeof v.installPath === 'string' ? v.installPath : undefined,
          version: typeof v.version === 'string' ? v.version : undefined,
          projectPath: typeof v.projectPath === 'string' ? v.projectPath : undefined
        }
      })
    }
  }
  return out
}

async function scanPlugins(): Promise<InstalledEntry[]> {
  const out: InstalledEntry[] = []
  const settingsCache = new Map<string, Record<string, unknown>>()
  const settingsOf = async (path: string) => {
    const k = pathKey(path)
    if (!settingsCache.has(k)) settingsCache.set(k, await peekSettings(path))
    return settingsCache.get(k) as Record<string, unknown>
  }
  for (const { pluginId, rec } of await readInstalledPlugins()) {
    const at = pluginId.lastIndexOf('@')
    const name = at > 0 ? pluginId.slice(0, at) : pluginId
    const marketplace = at > 0 ? pluginId.slice(at + 1) : ''
    if (!PLUGIN_NAME_RE.test(name)) continue
    const scope = rec.scope !== 'user' && !rec.projectPath ? 'user' : rec.scope
    const settings = await settingsOf(settingsPathFor(scope, rec.projectPath))
    const enabledMap = isPlainObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
    const enabled = enabledMap[pluginId] !== false
    let description = ''
    let displayName = name
    let author: string | undefined
    if (rec.installPath) {
      const manifest = await readJson<unknown>(join(rec.installPath, '.claude-plugin', 'plugin.json'))
      if (isPlainObject(manifest.data)) {
        if (typeof manifest.data.description === 'string') description = manifest.data.description
        if (typeof manifest.data.displayName === 'string' && manifest.data.displayName.trim()) displayName = manifest.data.displayName.trim()
        const a = manifest.data.author
        author = typeof a === 'string' ? a : isPlainObject(a) && typeof a.name === 'string' ? a.name : undefined
      }
    }
    const id = scope === 'user' ? pluginItemId(name, marketplace) : localItemId('plugin', scope, pluginId, rec.projectPath)
    out.push({
      kind: 'plugin',
      scope,
      projectPath: scope === 'user' ? undefined : rec.projectPath,
      path: rec.installPath ?? '',
      pluginId,
      item: {
        id,
        kind: 'plugin',
        name: displayName,
        description: clip(description, 600),
        author,
        source: 'marketplace',
        marketplace: marketplace || undefined,
        installed: true,
        installedPath: rec.installPath,
        scope,
        enabled
      }
    })
  }
  return out
}

interface SettingsFileInfo {
  scope: Scope
  projectPath?: string
  path: string
  data: Record<string, unknown>
}

/** User settings plus project / local settings of each recent project. */
export async function settingsFiles(bases: ScopeBase[]): Promise<SettingsFileInfo[]> {
  const out: SettingsFileInfo[] = [{ scope: 'user', path: settingsPathFor('user'), data: await peekSettings(settingsPathFor('user')) }]
  for (const sb of bases) {
    if (sb.scope !== 'project' || !sb.projectPath) continue
    for (const scope of ['project', 'local'] as const) {
      const path = settingsPathFor(scope, sb.projectPath)
      out.push({ scope, projectPath: sb.projectPath, path, data: await peekSettings(path) })
    }
  }
  return out
}

/** Short label for a hook handler: script name, URL host, tool, or the start of the command. */
export function hookLabel(ref: HookRef): string {
  const h = ref.handler
  if (typeof h.command === 'string') {
    const script = /([\w.-]+\.(?:py|sh|js|mjs|cjs|ts|ps1|rb|pl|bash))\b/.exec(h.command)
    return script ? script[1] : clip(h.command, 48)
  }
  if (typeof h.url === 'string') {
    try {
      return new URL(h.url).host
    } catch {
      return clip(h.url, 48)
    }
  }
  if (typeof h.tool === 'string') return `${typeof h.server === 'string' ? h.server + ' / ' : ''}${h.tool}`
  if (typeof h.prompt === 'string') return `${h.type} hook: ${clip(h.prompt, 40)}`
  return `${h.type} hook`
}

/** One-sentence description of a hook handler. */
export function hookDescription(ref: HookRef): string {
  const m = normalizeMatcher(ref.matcher)
  const when = `Runs on ${ref.event}${m ? ` (${m})` : ''}`
  const h = ref.handler
  let what = ''
  if (typeof h.command === 'string') what = h.command
  else if (typeof h.url === 'string') what = `POST ${h.url}`
  else if (typeof h.prompt === 'string') what = h.prompt
  return clip(what ? `${when}: ${what}` : when, 300)
}

function scanSettingsKinds(files: SettingsFileInfo[], records: RegistryRecord[], want: (k: ExtensionKind) => boolean): InstalledEntry[] {
  const out: InstalledEntry[] = []
  for (const file of files) {
    const fileRecords = records.filter((r) => samePath(r.path, file.path))
    if (want('hook')) {
      const claimed = new Set<number>()
      const refs = listHooks(file.data)
      for (const rec of fileRecords.filter((r) => r.kind === 'hook')) {
        const own = rec.hooks ?? []
        if (rec.disabled) {
          out.push(hookEntry(file, rec, own, false))
          continue
        }
        const present = own.filter((ref) => hasHook(file.data, ref))
        if (!present.length) continue
        for (const ref of present) {
          const i = refs.findIndex((r, idx) => !claimed.has(idx) && sameHook(r, ref))
          if (i >= 0) claimed.add(i)
        }
        out.push(hookEntry(file, rec, present, true))
      }
      refs.forEach((ref, idx) => {
        if (claimed.has(idx)) return
        out.push({
          kind: 'hook',
          scope: file.scope,
          projectPath: file.projectPath,
          path: file.path,
          hooks: [ref],
          item: {
            id: localItemId('hook', file.scope, `${ref.event}/${hookRefHash(ref)}`, file.projectPath),
            kind: 'hook',
            name: hookLabel(ref),
            description: hookDescription(ref),
            source: 'local',
            installed: true,
            installedPath: file.path,
            scope: file.scope,
            enabled: true
          }
        })
      })
    }
    if (want('statusline')) {
      const current = validateStatusLine(file.data.statusLine)
      const recs = fileRecords.filter((r) => r.kind === 'statusline')
      const active = current ? recs.find((r) => !r.disabled && r.statusLine && deepEqual(r.statusLine.value, current)) : undefined
      if (current) {
        out.push({
          kind: 'statusline',
          scope: file.scope,
          projectPath: file.projectPath,
          path: file.path,
          record: active,
          item: {
            id: localItemId('statusline', file.scope, 'statusLine', file.projectPath),
            kind: 'statusline',
            name: active?.name ?? 'Custom status line',
            description: active?.description ?? clip(`Runs: ${String(current.command)}`, 300),
            source: active?.source ?? 'local',
            repo: active?.repo,
            url: active?.url,
            installed: true,
            installedPath: file.path,
            scope: file.scope,
            enabled: true
          }
        })
      }
      for (const rec of recs.filter((r) => r.disabled)) {
        out.push({
          kind: 'statusline',
          scope: file.scope,
          projectPath: file.projectPath,
          path: file.path,
          record: rec,
          item: {
            id: localItemId('statusline', file.scope, `rec-${rec.key}`, file.projectPath),
            kind: 'statusline',
            name: rec.name,
            description: rec.description ?? 'Status line (switched off)',
            source: rec.source,
            repo: rec.repo,
            url: rec.url,
            installed: true,
            installedPath: file.path,
            scope: file.scope,
            enabled: false
          }
        })
      }
    }
  }
  return out
}

function sameHook(a: HookRef, b: HookRef): boolean {
  return a.event === b.event && normalizeMatcher(a.matcher) === normalizeMatcher(b.matcher) && deepEqual(a.handler, b.handler)
}

function hookEntry(file: SettingsFileInfo, rec: RegistryRecord, hooks: HookRef[], enabled: boolean): InstalledEntry {
  return {
    kind: 'hook',
    scope: file.scope,
    projectPath: file.projectPath,
    path: file.path,
    record: rec,
    hooks,
    item: {
      id: localItemId('hook', file.scope, `rec-${rec.key}`, file.projectPath),
      kind: 'hook',
      name: rec.name,
      description: rec.description ?? (hooks[0] ? hookDescription(hooks[0]) : ''),
      source: rec.source,
      repo: rec.repo,
      url: rec.url,
      installed: true,
      installedPath: file.path,
      scope: file.scope,
      enabled
    }
  }
}

/**
 * Everything installed (optionally one kind) for the user and recent projects (+ `extraProjects`).
 * Never throws for unreadable files; they are skipped.
 */
export async function scanInstalled(env: ExtEnv, kind?: ExtensionKind, extraProjects: string[] = []): Promise<InstalledEntry[]> {
  const want = (k: ExtensionKind) => !kind || kind === k
  const [bases, records] = await Promise.all([scopeBases(env, extraProjects), env.registry.list()])
  const out: InstalledEntry[] = []
  const needSettings = want('skill') || want('hook') || want('statusline')
  const files = needSettings ? await settingsFiles(bases) : []
  for (const sb of bases) {
    if (want('skill')) {
      // Overrides that apply: user settings for personal skills; project + local settings for project skills.
      const sources =
        sb.scope === 'user'
          ? files.filter((f) => f.scope === 'user').map((f) => f.data)
          : files.filter((f) => f.scope === 'user' || (f.projectPath && samePath(f.projectPath, sb.projectPath as string))).map((f) => f.data)
      out.push(...(await scanSkills(sb, records, sources)))
    }
    for (const k of ['agent', 'command', 'output-style'] as const) if (want(k)) out.push(...(await scanMarkdownKind(k, sb, records)))
  }
  if (want('plugin')) out.push(...(await scanPlugins()))
  if (want('hook') || want('statusline')) {
    // Parked items whose settings file is not part of the scanned set (e.g. a project no longer in the recent list).
    const scanned = new Set(files.map((f) => pathKey(f.path)))
    const parked = records.filter((r) => (r.kind === 'hook' || r.kind === 'statusline') && r.disabled && !scanned.has(pathKey(r.path)))
    const extraPaths = [...new Set(parked.map((r) => r.path))]
    for (const p of extraPaths) {
      const rec = records.find((r) => samePath(r.path, p)) as RegistryRecord
      files.push({ scope: rec.scope, projectPath: rec.projectPath, path: p, data: await peekSettings(p) })
    }
    out.push(...scanSettingsKinds(files, records, want))
  }
  return out
}
