/**
 * Single-file extensions: subagents, slash commands and output styles — one .md file in
 * ~/.claude/{agents,commands,output-styles}/ (user) or <project>/.claude/… (project). The original file
 * name is kept; an existing file is only replaced when Claude Setup installed it. Switching off renames
 * "x.md" to "x.md.disabled" (Claude Code ignores that name).
 */
import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OpResult } from '@shared/types'
import { fmString, parseFrontmatter } from '../frontmatter'
import { downloadRepoFile, friendlyGitHubError, githubBlobUrl } from '../github'
import type { CatalogId } from '../ids'
import type { InstalledEntry } from '../installed'
import { fileScope, kindDir } from '../paths'
import { FriendlyError } from '../settingsFile'
import type { CatalogItem, ExtEnv } from '../types'
import { lstatSafe, sha256 } from '../util'
import { backupFiles, failure, rememberProject, renameWithRetry, storableOnThisOS, writeFileAtomic, type Target } from './common'

export type MarkdownKind = 'agent' | 'command' | 'output-style'

export const KIND_LABEL: Record<MarkdownKind, string> = { agent: 'agent', command: 'command', 'output-style': 'output style' }

/** Header problems that would make Claude Code skip or misread the file. */
export function markdownWarnings(kind: MarkdownKind, text: string): string[] {
  const fm = parseFrontmatter(text)
  const out: string[] = []
  if (kind === 'agent') {
    if (!fm.present || !fmString(fm.data, 'name') || !fmString(fm.data, 'description')) {
      out.push('Its header is missing a name or description, and Claude Code skips agents without both.')
    } else if (fm.error) out.push(`Its header isn't valid YAML (${fm.error}), so Claude Code may skip it.`)
  } else if (fm.error) out.push(`Its header isn't valid YAML (${fm.error}); Claude Code may ignore some of its settings.`)
  return out
}

function usageMessage(kind: MarkdownKind, name: string, fileName: string, hadDir: boolean): string {
  const stem = fileName.replace(/\.md$/i, '')
  if (kind === 'agent') {
    return hadDir
      ? `Claude can now hand work to it automatically, or you can ask for it with @agent-${name}.`
      : 'Restart Claude Code to load it (new agent folders are only noticed at startup).'
  }
  if (kind === 'command') return `Run /reload-skills in any open Claude Code session (or restart it), then type /${stem} to use it.`
  return `Restart Claude Code, then choose it with /output-style ${name}.`
}

/** Download one .md file and install it. */
export async function installMarkdown(
  env: ExtEnv,
  id: CatalogId,
  target: Target,
  catalogId: string,
  meta?: CatalogItem
): Promise<OpResult> {
  const kind = id.kind as MarkdownKind
  const label = KIND_LABEL[kind]
  try {
    const fileName = basename(id.path)
    if (!/\.md$/i.test(fileName) || !storableOnThisOS(fileName)) {
      throw new FriendlyError(`This ${label} has an unexpected file name, so it wasn't installed.`, fileName)
    }
    env.progress(`Downloading the ${label}…`, 20)
    let data: Buffer
    try {
      data = await downloadRepoFile(id.owner, id.repo, id.path, { maxBytes: 2 * 1024 * 1024 })
    } catch (err) {
      throw new FriendlyError(friendlyGitHubError(err, `this ${label}`))
    }
    const text = data.toString('utf8')
    const fm = parseFrontmatter(text)
    const name = (kind === 'command' ? undefined : fmString(fm.data, 'name')) ?? meta?.name ?? fileName.replace(/\.md$/i, '')
    const warnings = markdownWarnings(kind, text)
    const scope = fileScope(target.scope)
    const dir = kindDir(kind, scope, target.projectPath)
    const dest = join(dir, fileName)
    const hadDir = !!(await lstatSafe(dir))
    const existing = await readFile(dest).catch(() => null)
    const disabledTwin = await lstatSafe(dest + '.disabled')
    const record = await env.registry.findByPath(kind, dest)
    const hash = sha256(data)
    const recordBase = {
      id: catalogId,
      kind,
      name,
      source: id.source,
      scope,
      projectPath: scope === 'project' ? target.projectPath : undefined,
      path: dest,
      files: [{ path: dest, sha256: hash }],
      description: meta?.description ?? fmString(fm.data, 'description'),
      url: meta?.url ?? githubBlobUrl(id.owner, id.repo, id.path),
      repo: `${id.owner}/${id.repo}`,
      installedAt: new Date().toISOString()
    }
    if (!existing && disabledTwin) {
      return {
        ok: false,
        message: `This ${label} is already installed but switched off. Turn it back on from your installed extensions.`,
        details: dest + '.disabled'
      }
    }
    if (existing) {
      if (sha256(existing) === hash) {
        if (!record) await env.registry.add(recordBase)
        return { ok: true, message: `The "${name}" ${label} is already installed.` }
      }
      if (!record) {
        throw new FriendlyError(
          `A different ${label} file named "${fileName}" already exists, so it was left untouched.`,
          `File: ${dest}. Rename or remove it first if you want to replace it.`
        )
      }
    }
    const backupId = await backupFiles(env, `Install ${label} ${name}`, [dest])
    await writeFileAtomic(dest, data)
    await env.registry.add(record ? { ...recordBase, key: record.key } : recordBase)
    await rememberProject(env, recordBase.projectPath)
    const where = scope === 'user' ? 'for all your projects' : `for the project "${basename(target.projectPath ?? '')}"`
    return {
      ok: true,
      message: `${existing ? 'Updated' : 'Installed'} the "${name}" ${label} ${where}. ${usageMessage(kind, name, fileName, hadDir)}`,
      details: warnings.length ? warnings.join('\n') : undefined,
      backupId
    }
  } catch (err) {
    return failure(err, `The ${label} couldn't be installed.`)
  }
}

/** Delete an installed .md file (backed up first). */
export async function removeMarkdown(env: ExtEnv, entry: InstalledEntry): Promise<OpResult> {
  const label = KIND_LABEL[entry.kind as MarkdownKind] ?? 'file'
  try {
    const backupId = await backupFiles(env, `Remove ${label} ${entry.item.name}`, [entry.path])
    await rm(entry.path, { force: true, maxRetries: 5, retryDelay: 100 })
    if (entry.record) await env.registry.remove(entry.record.key)
    return { ok: true, message: `Removed the "${entry.item.name}" ${label}.`, backupId }
  } catch (err) {
    return failure(err, `The ${label} couldn't be removed.`)
  }
}

/** Switch a .md extension on/off by renaming x.md ↔ x.md.disabled. */
export async function setMarkdownEnabled(env: ExtEnv, entry: InstalledEntry, enabled: boolean): Promise<OpResult> {
  const label = KIND_LABEL[entry.kind as MarkdownKind] ?? 'file'
  try {
    const isDisabled = /\.disabled$/i.test(entry.path)
    if (enabled !== isDisabled) return { ok: true, message: `The "${entry.item.name}" ${label} is already ${enabled ? 'on' : 'off'}.` }
    const to = enabled ? entry.path.replace(/\.disabled$/i, '') : entry.path + '.disabled'
    if (await lstatSafe(to)) {
      throw new FriendlyError(
        `Couldn't switch the "${entry.item.name}" ${label} ${enabled ? 'on' : 'off'}: another file is in the way.`,
        `Both ${entry.path} and ${to} exist.`
      )
    }
    const backupId = await backupFiles(env, `${enabled ? 'Turn on' : 'Turn off'} ${label} ${entry.item.name}`, [entry.path, to])
    await renameWithRetry(entry.path, to)
    let after = ''
    if (entry.kind === 'output-style') after = ' Restart Claude Code for the change to take effect.'
    else if (entry.kind === 'command') after = ' Run /reload-skills in open sessions.'
    return { ok: true, message: `Turned ${enabled ? 'on' : 'off'} the "${entry.item.name}" ${label}.${after}`, backupId }
  } catch (err) {
    return failure(err, `The ${label} couldn't be changed.`)
  }
}
