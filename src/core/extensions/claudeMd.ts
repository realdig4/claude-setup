/**
 * CLAUDE.md writer. A template is stored between marker comments
 *   <!-- claude-setup:<id> --> … <!-- /claude-setup:<id> -->
 * so it can be updated in place later; Claude Code strips HTML comments when it loads the file.
 * Appends by default (replacing an existing block for the same template); `replace` rewrites the whole file.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ClaudeMdTemplate, OpResult } from '@shared/types'
import { writeTextAtomic } from '../fs/json'
import { claudeConfigDir } from '../platform/paths'
import { backupFiles, failure, rememberProject, resolveTarget } from './installers/common'
import { claudeMdTemplate } from './templates'
import type { ExtEnv } from './types'
import { lstatSafe } from './util'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The marked block for a template, using `eol` line endings. */
export function templateBlock(template: ClaudeMdTemplate, eol = '\n'): string {
  const lines = template.content.trim().split(/\r?\n/)
  return [`<!-- claude-setup:${template.id} -->`, ...lines, `<!-- /claude-setup:${template.id} -->`].join(eol)
}

/** New file text after adding / updating / replacing with a template. Keeps the file's line endings. */
export function applyTemplate(
  existing: string,
  template: ClaudeMdTemplate,
  replace: boolean
): { text: string; action: 'created' | 'replaced' | 'updated' | 'appended' } {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const block = templateBlock(template, eol)
  if (!existing.trim()) return { text: block + eol, action: 'created' }
  if (replace) return { text: block + eol, action: 'replaced' }
  const id = escapeRe(template.id)
  const re = new RegExp(`<!-- claude-setup:${id} -->[\\s\\S]*?<!-- /claude-setup:${id} -->`)
  if (re.test(existing)) return { text: existing.replace(re, () => block), action: 'updated' }
  return { text: existing.replace(/\s+$/, '') + eol + eol + block + eol, action: 'appended' }
}

/** ~/.claude/CLAUDE.md, or the project's CLAUDE.md (./CLAUDE.md, or ./.claude/CLAUDE.md when only that exists). */
async function targetFile(
  where: { scope: 'user' } | { scope: 'project'; projectPath: string }
): Promise<{ file: string; projectPath?: string }> {
  if (where.scope === 'user') return { file: join(claudeConfigDir(), 'CLAUDE.md') }
  const target = await resolveTarget({ scope: 'project', projectPath: where.projectPath })
  const projectPath = target.projectPath as string
  const root = join(projectPath, 'CLAUDE.md')
  const nested = join(projectPath, '.claude', 'CLAUDE.md')
  if (!(await lstatSafe(root)) && (await lstatSafe(nested))) return { file: nested, projectPath }
  return { file: root, projectPath }
}

/** Write a template into CLAUDE.md (backed up first). */
export async function writeClaudeMd(
  env: ExtEnv,
  templateId: string,
  where: { scope: 'user' } | { scope: 'project'; projectPath: string },
  replace = false
): Promise<OpResult> {
  const template = claudeMdTemplate(templateId)
  if (!template) return { ok: false, message: "That CLAUDE.md template doesn't exist.", details: `Unknown template id "${templateId}".` }
  try {
    const { file, projectPath } = await targetFile(where?.scope === 'project' ? where : { scope: 'user' })
    const existing = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return ''
      throw err
    })
    const { text, action } = applyTemplate(existing.replace(/^﻿/, ''), template, replace)
    if (text === existing) return { ok: true, message: `${basename(file)} already has the latest "${template.name}" instructions.` }
    const backupId = await backupFiles(env, `CLAUDE.md: ${template.name}`, [file])
    await writeTextAtomic(file, text)
    await rememberProject(env, projectPath)
    const place = where?.scope === 'project' ? `the project's ${basename(file)}` : 'your personal CLAUDE.md (all projects)'
    const verb =
      action === 'replaced'
        ? `Replaced ${place} with the "${template.name}" instructions.`
        : action === 'updated'
          ? `Updated the "${template.name}" instructions in ${place}.`
          : `Added the "${template.name}" instructions to ${place}.`
    return { ok: true, message: `${verb} Claude Code reads them when a session starts (or after /clear).`, details: file, backupId }
  } catch (err) {
    return failure(err, "CLAUDE.md couldn't be written.")
  }
}
