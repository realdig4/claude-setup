/**
 * Plugins and marketplaces, always through the Claude Code CLI so settings.json, installed_plugins.json and
 * known_marketplaces.json stay consistent (settings-only provisioning is not applied until a session starts).
 * The files the CLI may touch are backed up before every command.
 */
import { isAbsolute } from 'node:path'
import type { Marketplace, OpResult } from '@shared/types'
import { isPlainObject, readJson } from '../../fs/json'
import { expandHome } from '../../platform/paths'
import { CACHE_KEYS } from '../cache'
import { claudeMissing, explainCliFailure, locateClaudeCli, parseCliJson, PLUGIN_DIRECTORY, runClaude } from '../cli'
import { PLUGIN_NAME_RE } from '../ids'
import { readInstalledPlugins } from '../installed'
import { installedPluginsPath, knownMarketplacesPath, settingsPathFor } from '../paths'
import { peekSettings } from '../settingsFile'
import { CURATED_MARKETPLACES, curatedMarketplace, DIRECTORY_DESCRIPTION, parseGitHubRepo } from '../sources/marketplaces'
import type { ExtEnv } from '../types'
import { plural } from '../util'
import { backupFiles, failure, rememberProject, type Target } from './common'

/** Files the plugin CLI may change for a target. */
function pluginStateFiles(target?: { projectPath?: string }): string[] {
  const files = [settingsPathFor('user'), installedPluginsPath(), knownMarketplacesPath()]
  if (target?.projectPath) files.push(settingsPathFor('project', target.projectPath), settingsPathFor('local', target.projectPath))
  return files
}

/** Forget cached plugin listings after marketplaces change. */
async function invalidatePluginCaches(env: ExtEnv): Promise<void> {
  await env.cache.delete(CACHE_KEYS.cli)
}

export interface KnownMarketplace {
  name: string
  /** What `marketplace add` was given: "owner/repo", a URL or a path. */
  source: string
  repo?: string
}

function describeSource(src: unknown): { source: string; repo?: string } {
  if (!isPlainObject(src)) return { source: typeof src === 'string' ? src : 'unknown' }
  const kind = src.source
  if (kind === 'github' && typeof src.repo === 'string') return { source: src.repo, repo: src.repo }
  if ((kind === 'git' || kind === 'url') && typeof src.url === 'string') {
    const gh = parseGitHubRepo(src.url)
    return { source: src.url, repo: gh ? `${gh.owner}/${gh.repo}` : undefined }
  }
  if ((kind === 'file' || kind === 'directory') && typeof src.path === 'string') return { source: src.path }
  if (kind === 'settings') return { source: 'settings (inline)' }
  return { source: typeof kind === 'string' ? kind : 'unknown' }
}

/**
 * Marketplaces Claude Code knows: plugins/known_marketplaces.json, extraKnownMarketplaces in user settings,
 * and (when `cli` is given) `claude plugin marketplace list --json`.
 */
export async function knownMarketplaces(cli: string | null): Promise<Map<string, KnownMarketplace>> {
  const out = new Map<string, KnownMarketplace>()
  const known = await readJson<unknown>(knownMarketplacesPath())
  if (isPlainObject(known.data)) {
    for (const [name, v] of Object.entries(known.data)) if (isPlainObject(v)) out.set(name, { name, ...describeSource(v.source) })
  }
  const settings = await peekSettings(settingsPathFor('user'))
  for (const key of ['extraKnownMarketplaces', 'additionalMarketplaces']) {
    const declared = settings[key]
    if (!isPlainObject(declared)) continue
    for (const [name, v] of Object.entries(declared)) if (isPlainObject(v) && !out.has(name)) out.set(name, { name, ...describeSource(v.source) })
  }
  if (cli) {
    const r = await runClaude(cli, ['plugin', 'marketplace', 'list', '--json'], { timeoutMs: 30_000 })
    const list = parseCliJson(r.raw.stdout)
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!isPlainObject(m) || typeof m.name !== 'string') continue
        if (out.has(m.name)) continue
        const repo = typeof m.repo === 'string' ? m.repo : undefined
        const source = repo ?? (typeof m.url === 'string' ? m.url : typeof m.path === 'string' ? m.path : String(m.source ?? 'unknown'))
        out.set(m.name, { name: m.name, source, repo })
      }
    }
  }
  return out
}

function pluginWhere(target: Target): string {
  if (target.scope === 'project') return 'for this project (shared with your team through .claude/settings.json)'
  if (target.scope === 'local') return 'for this project (just for you)'
  return 'for all your projects'
}

/** Install `name@marketplace`, adding the marketplace first when it is one of the curated ones. */
export async function installPlugin(env: ExtEnv, name: string, marketplace: string, target: Target): Promise<OpResult> {
  try {
    const cli = await locateClaudeCli()
    if (!cli) return claudeMissing()
    const backupId = await backupFiles(env, `Install plugin ${name}@${marketplace}`, pluginStateFiles(target))
    if (marketplace !== PLUGIN_DIRECTORY) {
      let known = await knownMarketplaces(null)
      if (!known.has(marketplace)) known = await knownMarketplaces(cli)
      if (!known.has(marketplace)) {
        const curated = curatedMarketplace(marketplace)
        if (!curated) {
          return {
            ok: false,
            message: `Add the "${marketplace}" marketplace first.`,
            details: "This plugin comes from a marketplace Claude Code doesn't know yet. Add it on the Marketplaces tab, then install the plugin again.",
            backupId
          }
        }
        env.progress(`Adding the ${marketplace} marketplace…`, 15)
        const add = await runClaude(cli, ['plugin', 'marketplace', 'add', curated.repo, '--json'], { timeoutMs: 300_000 })
        if (!add.ok) return { ...explainCliFailure(add, `add the ${marketplace} marketplace`), backupId }
        await invalidatePluginCaches(env)
      }
    }
    env.progress(`Installing ${name}…`, 50)
    const r = await runClaude(cli, ['plugin', 'install', `${name}@${marketplace}`, '--scope', target.scope, '--json'], {
      cwd: target.scope === 'user' ? undefined : target.projectPath,
      timeoutMs: 300_000
    })
    if (!r.ok) {
      return {
        ...explainCliFailure(r, 'install this plugin', {
          notFound: `Couldn't find "${name}" in the ${marketplace} marketplace. It may have been renamed or removed.`,
          notConfigured: `The "${marketplace}" marketplace isn't added in Claude Code. Add it on the Marketplaces tab, then try again.`
        }),
        backupId
      }
    }
    await rememberProject(env, target.projectPath)
    if (/already installed/i.test(r.message)) return { ok: true, message: `The "${name}" plugin is already installed.`, details: r.message, backupId }
    // `claude plugin install` never asks for a plugin's options; point the user at /plugin configure when it has some.
    const needsConfig = r.json?.hasUserConfig === true || /\bconfigure\b/i.test(r.message)
    const configHint = needsConfig ? `This plugin has settings: set them in Claude Code with /plugin configure ${name}@${marketplace}.` : ''
    return {
      ok: true,
      message: `Installed the "${name}" plugin ${pluginWhere(target)}. Run /reload-plugins in Claude Code (or restart it) to start using it.`,
      details: [r.message, configHint].filter(Boolean).join('\n'),
      backupId
    }
  } catch (err) {
    return failure(err, "The plugin couldn't be installed.")
  }
}

/** `claude plugin uninstall`. */
export async function uninstallPlugin(env: ExtEnv, pluginId: string, target: Target): Promise<OpResult> {
  const name = pluginId.slice(0, pluginId.lastIndexOf('@'))
  try {
    const cli = await locateClaudeCli()
    if (!cli) return claudeMissing()
    const backupId = await backupFiles(env, `Remove plugin ${pluginId}`, pluginStateFiles(target))
    const r = await runClaude(cli, ['plugin', 'uninstall', pluginId, '--scope', target.scope, '--json'], {
      cwd: target.scope === 'user' ? undefined : target.projectPath,
      timeoutMs: 120_000
    })
    if (!r.ok && r.failureCode === 'not_installed') {
      return { ok: true, message: `The "${name}" plugin is not installed${target.scope === 'user' ? '' : ' in this project'}.`, backupId }
    }
    if (!r.ok) return { ...explainCliFailure(r, 'remove this plugin'), backupId }
    return { ok: true, message: `Removed the "${name}" plugin. Run /reload-plugins in any open Claude Code session.`, details: r.message, backupId }
  } catch (err) {
    return failure(err, "The plugin couldn't be removed.")
  }
}

/** `claude plugin enable|disable`. */
export async function setPluginEnabled(env: ExtEnv, pluginId: string, enabled: boolean, target: Target): Promise<OpResult> {
  const name = pluginId.slice(0, pluginId.lastIndexOf('@'))
  try {
    const cli = await locateClaudeCli()
    if (!cli) return claudeMissing()
    const backupId = await backupFiles(env, `${enabled ? 'Enable' : 'Disable'} plugin ${pluginId}`, pluginStateFiles(target))
    const r = await runClaude(cli, ['plugin', enabled ? 'enable' : 'disable', pluginId, '--scope', target.scope, '--json'], {
      cwd: target.scope === 'user' ? undefined : target.projectPath,
      timeoutMs: 60_000
    })
    if (r.alreadyDone) return { ok: true, message: `The "${name}" plugin is already ${enabled ? 'on' : 'off'}.`, backupId }
    if (!r.ok) {
      return { ...explainCliFailure(r, `${enabled ? 'turn on' : 'turn off'} this plugin`, { notFound: `The "${name}" plugin isn't installed.` }), backupId }
    }
    return { ok: true, message: `Turned ${enabled ? 'on' : 'off'} the "${name}" plugin. Run /reload-plugins in any open Claude Code session.`, backupId }
  } catch (err) {
    return failure(err, "The plugin couldn't be changed.")
  }
}

/** Is `source` something `claude plugin marketplace add` accepts (and safe to pass as an argument)? */
export function validMarketplaceSource(source: string): boolean {
  const s = source.trim()
  if (!s || s.length > 500 || s.startsWith('-') || /[\r\n\0]/.test(s)) return false
  if (s === PLUGIN_DIRECTORY) return true
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[#@][A-Za-z0-9_./-]+)?$/.test(s) && !s.startsWith('.')) return true
  if (/^https?:\/\/[^\s]+$/i.test(s)) return true
  if (/^git@[\w.-]+:[\w./-]+$/.test(s)) return true
  return isAbsolute(s) || s.startsWith('~/') || s.startsWith('~\\')
}

/** `claude plugin marketplace add <source>`. */
export async function addMarketplace(env: ExtEnv, source: string): Promise<OpResult> {
  const input = (source ?? '').trim()
  if (!validMarketplaceSource(input)) {
    return {
      ok: false,
      message: "That doesn't look like a marketplace address.",
      details: 'Use a GitHub "owner/repo", a git or https URL (for example a link to marketplace.json), or the full path of a folder.'
    }
  }
  const s = expandHome(input)
  try {
    const cli = await locateClaudeCli()
    if (!cli) return claudeMissing()
    const backupId = await backupFiles(env, `Add marketplace ${s}`, pluginStateFiles())
    env.progress('Adding the marketplace…', 20)
    const r = await runClaude(cli, ['plugin', 'marketplace', 'add', s, '--json'], { timeoutMs: 300_000 })
    if (!r.ok) return { ...explainCliFailure(r, 'add this marketplace'), backupId }
    await invalidatePluginCaches(env)
    if (s === PLUGIN_DIRECTORY) return { ok: true, message: "Turned on Anthropic's plugin directory. Its plugins appear in the catalog again.", backupId }
    const name = typeof r.json?.marketplace === 'string' ? r.json.marketplace : s
    if (/already/i.test(r.message)) return { ok: true, message: `The "${name}" marketplace is already added.`, details: r.message, backupId }
    return { ok: true, message: `Added the "${name}" marketplace. Its plugins now appear in the catalog.`, details: r.message, backupId }
  } catch (err) {
    return failure(err, "The marketplace couldn't be added.")
  }
}

/** `claude plugin marketplace remove <name>` (Claude Code also uninstalls that marketplace's plugins). */
export async function removeMarketplace(env: ExtEnv, name: string): Promise<OpResult> {
  const n = (name ?? '').trim()
  if (!PLUGIN_NAME_RE.test(n)) return { ok: false, message: "That isn't a valid marketplace name." }
  try {
    const cli = await locateClaudeCli()
    if (!cli) return claudeMissing()
    const affected = new Set((await readInstalledPlugins()).filter((p) => p.pluginId.endsWith(`@${n}`)).map((p) => p.pluginId))
    const backupId = await backupFiles(env, `Remove marketplace ${n}`, pluginStateFiles())
    const r = await runClaude(cli, ['plugin', 'marketplace', 'remove', n, '--json'], { timeoutMs: 120_000 })
    if (!r.ok && r.failureCode === 'not_configured') return { ok: true, message: `The "${n}" marketplace isn't added, so there was nothing to remove.`, backupId }
    if (!r.ok) return { ...explainCliFailure(r, 'remove this marketplace'), backupId }
    await invalidatePluginCaches(env)
    if (n === PLUGIN_DIRECTORY) {
      return { ok: true, message: "Turned off Anthropic's plugin directory. Plugins you installed from it stay installed and keep updating.", backupId }
    }
    const names = [...affected].map((p) => p.slice(0, p.lastIndexOf('@'))).join(', ')
    return {
      ok: true,
      message: `Removed the "${n}" marketplace${affected.size ? ` and uninstalled its ${plural(affected.size, 'plugin')} (${names})` : ''}.`,
      details: r.message,
      backupId
    }
  } catch (err) {
    return failure(err, "The marketplace couldn't be removed.")
  }
}

/**
 * Known marketplaces merged with the curated suggestions.
 * `counts` = plugins per marketplace (from cached listings); `directoryOn` = the built-in directory is active.
 */
export async function listMarketplaces(counts: Map<string, number>, directoryOn: boolean | undefined): Promise<Marketplace[]> {
  const cli = await locateClaudeCli()
  const known = await knownMarketplaces(cli)
  const out: Marketplace[] = [
    {
      name: PLUGIN_DIRECTORY,
      source: 'built-in',
      added: !!cli && directoryOn !== false,
      official: true,
      description: DIRECTORY_DESCRIPTION,
      pluginCount: counts.get(PLUGIN_DIRECTORY)
    }
  ]
  for (const m of known.values()) {
    if (m.name === PLUGIN_DIRECTORY) continue
    const curated = curatedMarketplace(m.name)
    out.push({
      name: m.name,
      source: m.source,
      repo: m.repo ?? curated?.repo,
      added: true,
      official: curated?.official ?? false,
      description: curated?.description ?? 'Added by you.',
      pluginCount: counts.get(m.name)
    })
  }
  for (const c of CURATED_MARKETPLACES) {
    if (known.has(c.name)) continue
    out.push({
      name: c.name,
      source: c.repo,
      repo: c.repo,
      added: false,
      official: c.official ?? false,
      description: c.description,
      pluginCount: counts.get(c.name)
    })
  }
  const order = (m: Marketplace) => (m.name === PLUGIN_DIRECTORY ? 0 : m.added ? (m.official ? 1 : 2) : 3)
  const curatedIndex = (m: Marketplace) => {
    const i = CURATED_MARKETPLACES.findIndex((c) => c.name === m.name)
    return i < 0 ? 999 : i
  }
  return out.sort((a, b) => order(a) - order(b) || curatedIndex(a) - curatedIndex(b) || a.name.localeCompare(b.name))
}
