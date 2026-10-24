import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => null) }))
vi.mock('@core/platform/exec', () => ({ run: vi.fn(), which: vi.fn(async () => null) }))

import { createExtensionsApi } from '@core/extensions'
import { applyTemplate, templateBlock } from '@core/extensions/claudeMd'
import { CLAUDE_MD_TEMPLATES } from '@core/extensions/templates'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { makeCtx, type TestContext } from './helpers'

describe('CLAUDE.md templates', () => {
  it('ships 8 distinct, compact templates', async () => {
    expect(CLAUDE_MD_TEMPLATES).toHaveLength(8)
    expect(new Set(CLAUDE_MD_TEMPLATES.map((t) => t.id)).size).toBe(8)
    expect(CLAUDE_MD_TEMPLATES.map((t) => t.name)).toEqual([
      'General coding assistant',
      'Web app (React + TypeScript)',
      'Python project',
      'Data science / notebooks',
      'Beginner-friendly (explain simply)',
      'Concise senior engineer',
      'Security-conscious reviewer',
      'Writing & docs'
    ])
    for (const t of CLAUDE_MD_TEMPLATES) {
      const lines = t.content.split('\n')
      expect(lines.length, t.id).toBeLessThan(80)
      expect(lines.length, t.id).toBeGreaterThan(15)
      expect(t.content.startsWith('# '), t.id).toBe(true)
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.content).not.toMatch(/<!--/)
    }
  })

  it('appends, updates in place and replaces using marker comments', () => {
    const [a, b] = CLAUDE_MD_TEMPLATES
    const first = applyTemplate('', a, false)
    expect(first.action).toBe('created')
    expect(first.text).toBe(templateBlock(a) + '\n')
    const mine = '# My notes\n\nUse tabs.\n'
    const appended = applyTemplate(mine, a, false)
    expect(appended.action).toBe('appended')
    expect(appended.text.startsWith(mine.trimEnd() + '\n\n<!-- claude-setup:general -->')).toBe(true)
    const edited = appended.text.replace('Be concise.', 'Be very concise.')
    const updated = applyTemplate(edited, a, false)
    expect(updated.action).toBe('updated')
    expect(updated.text).toBe(appended.text)
    const both = applyTemplate(updated.text, b, false)
    expect(both.text.match(/<!-- claude-setup:/g)).toHaveLength(2)
    expect(both.text).toContain('# My notes')
    const replaced = applyTemplate(both.text, b, true)
    expect(replaced.action).toBe('replaced')
    expect(replaced.text).toBe(templateBlock(b) + '\n')
  })

  it('keeps Windows line endings', () => {
    const t = CLAUDE_MD_TEMPLATES[0]
    const r = applyTemplate('# Notes\r\nKeep CRLF\r\n', t, false)
    expect(r.text.includes('\r\n<!-- claude-setup:general -->\r\n')).toBe(true)
    expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })
})

describe('writeClaudeMd', () => {
  let sb: Sandbox
  let t: TestContext
  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
  })
  afterEach(async () => sb.cleanup())

  it('writes the user CLAUDE.md with a backup', async () => {
    const api = createExtensionsApi(t.ctx)
    expect(await api.claudeMdTemplates()).toHaveLength(8)
    const file = join(sb.home, '.claude', 'CLAUDE.md')
    const r = await api.writeClaudeMd('beginner', { scope: 'user' })
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/Added the "Beginner-friendly \(explain simply\)" instructions to your personal CLAUDE.md/)
    expect(t.snapshots[0]).toMatchObject({ paths: [file], existed: [false] })
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('<!-- claude-setup:beginner -->\n# Explain things simply')).toBe(true)
    expect((await api.writeClaudeMd('beginner', { scope: 'user' })).message).toMatch(/already has the latest/)
    const replaced = await api.writeClaudeMd('concise-senior', { scope: 'user' }, true)
    expect(replaced.message).toMatch(/^Replaced your personal CLAUDE.md/)
    expect(readFileSync(file, 'utf8')).not.toContain('claude-setup:beginner')
  })

  it('writes a project CLAUDE.md, preferring an existing .claude/CLAUDE.md', async () => {
    const api = createExtensionsApi(t.ctx)
    const project = join(sb.root, 'proj')
    await mkdir(join(project, '.claude'), { recursive: true })
    await writeFile(join(project, '.claude', 'CLAUDE.md'), '# Team rules\n')
    const r = await api.writeClaudeMd('python', { scope: 'project', projectPath: project })
    expect(r.ok, r.details).toBe(true)
    expect(readFileSync(join(project, '.claude', 'CLAUDE.md'), 'utf8')).toMatch(/^# Team rules\n\n<!-- claude-setup:python -->/)
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false)
    expect(t.ctx.state.settings().recentProjects).toContain(project)

    const other = join(sb.root, 'other')
    await mkdir(other)
    expect((await api.writeClaudeMd('python', { scope: 'project', projectPath: other })).ok).toBe(true)
    expect(existsSync(join(other, 'CLAUDE.md'))).toBe(true)
  })

  it('reports unknown templates and missing folders', async () => {
    const api = createExtensionsApi(t.ctx)
    expect(await api.writeClaudeMd('nope', { scope: 'user' })).toMatchObject({ ok: false, message: "That CLAUDE.md template doesn't exist." })
    expect(await api.writeClaudeMd('general', { scope: 'project', projectPath: join(sb.root, 'missing') })).toMatchObject({ ok: false })
  })
})
