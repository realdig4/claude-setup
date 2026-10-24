/**
 * Skills: a folder with SKILL.md downloaded from GitHub into ~/.claude/skills/<name>/ (user)
 * or <project>/.claude/skills/<name>/. Files are listed with the git trees API and downloaded from
 * raw.githubusercontent.com into a staging folder first (caps: 200 files, 20 MB). Nothing is executed.
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import type { OpResult } from '@shared/types'
import { parseFrontmatter, fmString } from '../frontmatter'
import { downloadRepoFile, formatBytes, friendlyGitHubError, GitHubError, githubTreeUrl, listDirectory, listTree, type RepoBlob } from '../github'
import { isSafeRelativePath, type CatalogId } from '../ids'
import type { InstalledEntry } from '../installed'
import { fileScope, kindDir, settingsPathFor } from '../paths'
import { FriendlyError, readSettings, writeSettings } from '../settingsFile'
import { setSkillOverride, skillOverride } from '../settingsMerge'
import type { CatalogItem, ExtEnv } from '../types'
import { listFilesRecursive, looseSlug, lstatSafe, mapLimit, plural, sha256, shortId } from '../util'
import { backupFiles, failure, moveDir, rememberProject, storableOnThisOS, writeFileAtomic, type Target } from './common'

export const SKILL_MAX_FILES = 200
export const SKILL_MAX_BYTES = 20 * 1024 * 1024

const KNOWN_SKILL_ROOTS = ['skills/', '.claude/skills/', '.agents/skills/', 'skills/.curated/', 'skills/.experimental/', 'skills/.system/']

/** Folders (repo-relative, '' = root) that contain a SKILL.md. */
export function skillDirs(blobs: RepoBlob[]): string[] {
  const dirs = new Set<string>()
  for (const b of blobs) {
    if (!/(^|\/)skill\.md$/i.test(b.path)) continue
    const d = posix.dirname(b.path)
    dirs.add(d === '.' ? '' : d)
  }
  return [...dirs]
}

function rankDir(d: string): number {
  const root = KNOWN_SKILL_ROOTS.findIndex((r) => d.startsWith(r))
  return (root >= 0 ? root : KNOWN_SKILL_ROOTS.length) * 1000 + d.split('/').length * 10 + Math.min(d.length, 9)
}

/**
 * Locate a skill folder by its skills.sh id (or display name): exact folder name, then case-insensitive,
 * then loose ("reactcomponents" ≈ "react-components"); a repo with a single skill matches anything.
 */
export function findSkillDir(blobs: RepoBlob[], skillId: string, displayName?: string): string | null {
  const dirs = skillDirs(blobs)
  if (!dirs.length) return null
  const base = (d: string) => d.slice(d.lastIndexOf('/') + 1)
  const pick = (list: string[]) => (list.length ? [...list].sort((a, b) => rankDir(a) - rankDir(b))[0] : null)
  const id = skillId.trim()
  return (
    pick(dirs.filter((d) => base(d) === id)) ??
    pick(dirs.filter((d) => base(d).toLowerCase() === id.toLowerCase())) ??
    pick(dirs.filter((d) => looseSlug(base(d)) === looseSlug(id) || (!!displayName && looseSlug(base(d)) === looseSlug(displayName)))) ??
    (dirs.length === 1 ? dirs[0] : null)
  )
}

/** Last resort: read SKILL.md headers of candidate folders and match the declared name. */
async function findByFrontmatter(
  owner: string,
  repo: string,
  blobs: RepoBlob[],
  skillId: string,
  displayName?: string
): Promise<string | null> {
  const dirs = skillDirs(blobs)
    .sort((a, b) => rankDir(a) - rankDir(b))
    .slice(0, 30)
  const wanted = new Set([looseSlug(skillId), displayName ? looseSlug(displayName) : ''].filter(Boolean))
  const hits = await mapLimit(dirs, 6, async (d) => {
    const file = blobs.find((b) => posix.dirname(b.path) === (d || '.') && /skill\.md$/i.test(b.path))
    if (!file) return null
    try {
      const fm = parseFrontmatter((await downloadRepoFile(owner, repo, file.path, { maxBytes: 512 * 1024 })).toString('utf8'))
      const name = fmString(fm.data, 'name')
      return name && wanted.has(looseSlug(name)) ? d : null
    } catch {
      return null
    }
  })
  return hits.find((h) => h !== null) ?? null
}

/** Folder name used on disk: the source folder name, made safe. */
export function skillFolderName(dir: string, repo: string): string {
  const raw = dir ? dir.slice(dir.lastIndexOf('/') + 1) : repo
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'skill'
}

interface PlannedFile {
  blob: RepoBlob
  /** Path inside the skill folder. */
  rel: string
}

function planFiles(blobs: RepoBlob[], dir: string): PlannedFile[] {
  const prefix = dir ? dir + '/' : ''
  return blobs
    .filter((b) => b.path.startsWith(prefix))
    .map((b) => ({ blob: b, rel: b.path.slice(prefix.length) }))
    .filter((f) => f.rel && !(dir === '' && (f.rel.startsWith('.github/') || /^\.git(ignore|attributes|modules)?$/.test(f.rel))))
}

/** Locate the folder and its files for a catalog id. */
async function locate(env: ExtEnv, id: CatalogId, meta?: CatalogItem): Promise<{ dir: string; files: PlannedFile[] }> {
  if (id.source === 'skills.sh') {
    const tree = await listTree(env.ctx, id.owner, id.repo)
    let dir = findSkillDir(tree.blobs, id.path, meta?.name)
    if (dir === null) dir = await findByFrontmatter(id.owner, id.repo, tree.blobs, id.path, meta?.name)
    if (dir === null && tree.truncated) {
      for (const candidate of [`skills/${id.path}`, id.path, `.claude/skills/${id.path}`]) {
        const listing = await listDirectory(env.ctx, id.owner, id.repo, candidate).catch(() => null)
        if (listing?.blobs.some((b) => /\/skill\.md$/i.test(b.path))) return { dir: candidate, files: planFiles(listing.blobs, candidate) }
      }
    }
    if (dir === null) throw new FriendlyError(`Couldn't find the skill "${id.path}" in ${id.owner}/${id.repo}.`, 'The repository may have moved or renamed it.')
    return { dir, files: planFiles(tree.blobs, dir) }
  }
  const listing = await listDirectory(env.ctx, id.owner, id.repo, id.path)
  return { dir: id.path, files: planFiles(listing.blobs, id.path) }
}

/** Download a skill from GitHub and install it. */
export async function installSkill(env: ExtEnv, id: CatalogId, target: Target, catalogId: string, meta?: CatalogItem): Promise<OpResult> {
  const staging = join(env.ctx.cacheDir, 'extensions', 'staging', shortId())
  try {
    env.progress('Looking up the skill on GitHub…', 5)
    let located: { dir: string; files: PlannedFile[] }
    try {
      located = await locate(env, id, meta)
    } catch (err) {
      if (err instanceof FriendlyError) throw err
      throw new FriendlyError(friendlyGitHubError(err, 'this skill'), err instanceof GitHubError ? undefined : String(err))
    }
    const { dir, files } = located
    const skillFile = files.find((f) => /^skill\.md$/i.test(f.rel))
    if (!files.length) throw new FriendlyError(`Couldn't find this skill in ${id.owner}/${id.repo}.`, `The folder "${dir || '/'}" is empty or missing.`)
    if (!skillFile) throw new FriendlyError("This folder doesn't contain a SKILL.md file, so it isn't a skill Claude can use.", `${id.owner}/${id.repo}/${dir}`)
    if (files.length > SKILL_MAX_FILES) {
      throw new FriendlyError(`This skill is too large to install safely (${plural(files.length, 'file')}; the limit is ${SKILL_MAX_FILES}).`)
    }
    const totalSize = files.reduce((n, f) => n + f.blob.size, 0)
    if (totalSize > SKILL_MAX_BYTES) {
      throw new FriendlyError(`This skill is too large to install safely (${formatBytes(totalSize)}; the limit is ${formatBytes(SKILL_MAX_BYTES)}).`)
    }
    const unsafe = files.find((f) => !isSafeRelativePath(f.rel) || !storableOnThisOS(f.rel))
    if (unsafe) throw new FriendlyError("This skill contains file names that can't be saved safely on this computer, so it wasn't installed.", unsafe.rel)
    // Windows and macOS ignore letter case: "a.md" and "A.md" would overwrite each other.
    if (new Set(files.map((f) => f.rel.toLowerCase())).size !== files.length) {
      throw new FriendlyError('This skill contains files whose names differ only in upper/lower case, so it can’t be installed on this computer.')
    }

    const folderName = skillFolderName(dir, id.repo)
    if (/^synced$/i.test(folderName) || /^anthropic-skills$/i.test(folderName)) {
      throw new FriendlyError(`"${folderName}" is a reserved name in Claude Code, so this skill can't be installed as a personal skill.`)
    }
    const scope = fileScope(target.scope)
    const skillsDir = kindDir('skill', scope, target.projectPath)
    const dest = join(skillsDir, folderName)
    const hadSkillsDir = !!(await lstatSafe(skillsDir))

    // Download everything into a staging folder first.
    let downloaded = 0
    let received = 0
    const written: Array<{ rel: string; sha256: string }> = []
    await mapLimit(files, 6, async (f) => {
      const data = await downloadRepoFile(id.owner, id.repo, f.blob.path, { maxBytes: Math.max(f.blob.size + 64 * 1024, 256 * 1024) })
      received += data.length
      if (received > SKILL_MAX_BYTES + 1024 * 1024) throw new FriendlyError('This skill is too large to install safely.')
      const rel = f === skillFile ? 'SKILL.md' : f.rel
      await writeFileAtomic(join(staging, ...rel.split('/')), data, { executable: f.blob.executable })
      written.push({ rel, sha256: sha256(data) })
      downloaded++
      env.progress(`Downloading skill files (${downloaded}/${files.length})…`, 10 + Math.round((downloaded / files.length) * 80))
    }).catch((err) => {
      if (err instanceof FriendlyError) throw err
      throw new FriendlyError(friendlyGitHubError(err, 'the skill files'))
    })

    const skillMd = await readFile(join(staging, 'SKILL.md'), 'utf8')
    const warnings = skillWarnings(skillMd)
    const existing = await lstatSafe(dest)
    const record = await env.registry.findByPath('skill', dest)
    const destFiles = written.map((w) => join(dest, ...w.rel.split('/')))
    const name = meta?.name ?? fmString(parseFrontmatter(skillMd).data, 'name') ?? folderName
    const recordBase = {
      id: catalogId,
      kind: 'skill' as const,
      name,
      source: id.source,
      scope,
      projectPath: scope === 'project' ? target.projectPath : undefined,
      path: dest,
      files: written.map((w) => ({ path: join(dest, ...w.rel.split('/')), sha256: w.sha256 })),
      description: meta?.description,
      url: meta?.url ?? githubTreeUrl(id.owner, id.repo, dir || undefined),
      repo: `${id.owner}/${id.repo}`,
      installedAt: new Date().toISOString()
    }
    if (existing && !record) {
      if (await sameContent(dest, written)) {
        await env.registry.add(recordBase)
        return { ok: true, message: `The "${name}" skill is already installed.` }
      }
      throw new FriendlyError(
        `A different skill named "${folderName}" is already installed, so it was left untouched.`,
        `Folder: ${dest}. Remove or rename it first if you want to replace it.`
      )
    }
    const oldFiles = existing ? await listFilesRecursive(dest) : []
    const backupId = await backupFiles(env, `Install skill ${name}`, [...oldFiles, ...destFiles])
    env.progress('Installing the skill…', 95)
    if (existing) await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await mkdir(skillsDir, { recursive: true })
    await moveDir(staging, dest)
    await env.registry.add(record ? { ...recordBase, key: record.key } : recordBase)
    await rememberProject(env, recordBase.projectPath)
    const where = scope === 'user' ? 'for all your projects' : `for the project "${basename(target.projectPath ?? '')}"`
    const reload = hadSkillsDir
      ? 'Claude Code picks it up automatically.'
      : 'Run /reload-skills in any open Claude Code session (or restart it) to start using it.'
    return {
      ok: true,
      message: `${existing ? 'Updated' : 'Installed'} the "${name}" skill ${where}. ${reload}`,
      details: [
        ...warnings,
        'Skills work in Claude Code (terminal, VS Code and the Code tab of the desktop app). Claude Desktop chats use skills uploaded under Customize → Skills instead.'
      ].join('\n'),
      backupId
    }
  } catch (err) {
    return failure(err, "The skill couldn't be installed.")
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
}

/** Problems with a SKILL.md header that would make Claude ignore or misuse the skill. */
export function skillWarnings(skillMd: string): string[] {
  const fm = parseFrontmatter(skillMd)
  const out: string[] = []
  if (!fm.present) out.push('Its SKILL.md has no header (name and description), so Claude may not know when to use it.')
  else {
    if (fm.error) out.push(`Its SKILL.md header isn't valid YAML (${fm.error}); Claude Code may ignore some of its settings.`)
    if (!fmString(fm.data, 'description')) out.push('Its SKILL.md has no description, so Claude may not know when to use it.')
    if (!fmString(fm.data, 'name')) out.push('Its SKILL.md has no name; Claude Code will use the folder name.')
  }
  return out
}

async function sameContent(dir: string, files: Array<{ rel: string; sha256: string }>): Promise<boolean> {
  const existing = await listFilesRecursive(dir)
  if (existing.length !== files.length) return false
  for (const f of files) {
    const buf = await readFile(join(dir, ...f.rel.split('/'))).catch(() => null)
    if (!buf || sha256(buf) !== f.sha256) return false
  }
  return true
}

/** Remove a skill folder (backed up first) and any skillOverrides entry for it. */
export async function removeSkill(env: ExtEnv, entry: InstalledEntry): Promise<OpResult> {
  try {
    const folder = entry.path
    const files = await listFilesRecursive(folder)
    const skillName = entry.skillName ?? basename(folder)
    const settingsPath = settingsPathFor(entry.scope === 'user' ? 'user' : 'local', entry.projectPath)
    let settings: Record<string, unknown> | undefined
    try {
      const doc = await readSettings(settingsPath)
      if (skillOverride(doc.data, skillName) !== undefined) settings = doc.data
    } catch {
      settings = undefined
    }
    const backupId = await backupFiles(env, `Remove skill ${skillName}`, settings ? [...files, settingsPath] : files)
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    if (settings && setSkillOverride(settings, skillName, undefined)) await writeSettings(settingsPath, settings)
    if (entry.record) await env.registry.remove(entry.record.key)
    return { ok: true, message: `Removed the "${entry.item.name}" skill.`, backupId }
  } catch (err) {
    return failure(err, "The skill couldn't be removed.")
  }
}

/** Switch a skill on/off with skillOverrides (user settings for personal skills, settings.local.json for project skills). */
export async function setSkillEnabled(env: ExtEnv, entry: InstalledEntry, enabled: boolean): Promise<OpResult> {
  try {
    const name = entry.skillName ?? basename(entry.path)
    const primary = settingsPathFor(entry.scope === 'user' ? 'user' : 'local', entry.projectPath)
    const paths = enabled && entry.scope !== 'user' ? [primary, settingsPathFor('user')] : [primary]
    const docs = await Promise.all(paths.map((p) => readSettings(p)))
    const changedDocs = docs.filter((doc, i) =>
      enabled ? skillOverride(doc.data, name) === 'off' : i === 0 && skillOverride(doc.data, name) !== 'off'
    )
    if (!changedDocs.length) {
      const shared = entry.projectPath ? await readSettings(settingsPathFor('project', entry.projectPath)).catch(() => null) : null
      if (enabled && shared && skillOverride(shared.data, name) === 'off') {
        return { ok: false, message: `The "${name}" skill is turned off in the project's shared settings (.claude/settings.json).`, details: shared.path }
      }
      return { ok: true, message: `The "${name}" skill is already ${enabled ? 'on' : 'off'}.` }
    }
    const backupId = await backupFiles(env, `${enabled ? 'Turn on' : 'Turn off'} skill ${name}`, changedDocs.map((d) => d.path))
    for (const doc of changedDocs) {
      setSkillOverride(doc.data, name, enabled ? undefined : 'off')
      await writeSettings(doc.path, doc.data)
    }
    return { ok: true, message: `Turned ${enabled ? 'on' : 'off'} the "${name}" skill. Claude Code picks this up automatically.`, backupId }
  } catch (err) {
    return failure(err, "The skill couldn't be changed.")
  }
}
