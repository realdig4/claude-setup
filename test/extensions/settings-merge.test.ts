import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adaptForPlatform, planScripts, quoteStateAt, rewriteForUserScope, scriptRefs, usesPython } from '@core/extensions/installers/scripts'
import {
  hookRefHash,
  listHooks,
  mergeHooks,
  removeHooks,
  restoreStatusLine,
  setSkillOverride,
  setStatusLine,
  skillOverride,
  validateHooks,
  validateStatusLine,
  type HooksMap
} from '@core/extensions/settingsMerge'
import { createSandbox, type Sandbox } from '../helpers/sandbox'

const fragment = (command: string, matcher?: string): HooksMap => ({
  PreToolUse: [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', command }] }]
})

describe('mergeHooks / removeHooks', () => {
  it('adds hooks and keeps unrelated settings', () => {
    const settings: Record<string, unknown> = { permissions: { allow: ['Bash(ls)'] }, model: 'opus' }
    const added = mergeHooks(settings, fragment('echo one', 'Bash'))
    expect(added).toHaveLength(1)
    expect(settings).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one' }] }] }
    })
  })

  it('dedupes identical handlers and joins groups with the same matcher', () => {
    const settings: Record<string, unknown> = {}
    mergeHooks(settings, fragment('echo one', 'Bash'))
    expect(mergeHooks(settings, fragment('echo one', 'Bash'))).toHaveLength(0)
    mergeHooks(settings, fragment('echo two', 'Bash'))
    const groups = (settings.hooks as HooksMap).PreToolUse
    expect(groups).toHaveLength(1)
    expect(groups[0].hooks.map((h) => h.command)).toEqual(['echo one', 'echo two'])
  })

  it('treats "*", "" and a missing matcher as the same', () => {
    const settings: Record<string, unknown> = {}
    mergeHooks(settings, fragment('a', '*'))
    expect(mergeHooks(settings, fragment('a'))).toHaveLength(0)
    expect(mergeHooks(settings, fragment('a', ''))).toHaveLength(0)
    expect(listHooks(settings)).toHaveLength(1)
  })

  it('removes only the given handlers and cleans up empty groups', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }] }
    }
    const added = mergeHooks(settings, { ...fragment('ours', 'Bash'), SessionStart: [{ hooks: [{ type: 'command', command: 'ours2' }] }] })
    expect(removeHooks(settings, added)).toBe(2)
    expect(settings.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }]
    })
    removeHooks(settings, listHooks(settings))
    expect(settings.hooks).toBeUndefined()
  })

  it('validates fragments and hashes handlers stably', () => {
    const v = validateHooks({ PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }, { nope: true }] }], 'bad event': [] })
    expect(v.hooks.PreToolUse[0].hooks).toHaveLength(1)
    expect(v.problems[0]).toMatch(/unknown hook event/)
    expect(validateHooks(null).problems).toHaveLength(1)
    const ref = { event: 'Stop', handler: { type: 'command', command: 'x', timeout: 5 } }
    expect(hookRefHash(ref)).toBe(hookRefHash({ event: 'Stop', matcher: '*', handler: { timeout: 5, command: 'x', type: 'command' } }))
  })
})

describe('status line and skill overrides', () => {
  it('replaces the status line and restores the previous one', () => {
    const settings: Record<string, unknown> = { statusLine: { type: 'command', command: 'old' } }
    const value = validateStatusLine({ command: 'new' }) as Record<string, unknown>
    expect(value).toEqual({ command: 'new', type: 'command' })
    const prev = setStatusLine(settings, value)
    expect(prev).toEqual({ previous: { type: 'command', command: 'old' }, hadPrevious: true })
    expect(restoreStatusLine(settings, value, prev.previous, prev.hadPrevious)).toBe('restored')
    expect(settings.statusLine).toEqual({ type: 'command', command: 'old' })
  })

  it('removes the key when there was none, and leaves user changes alone', () => {
    const settings: Record<string, unknown> = {}
    const value = { type: 'command', command: 'new' }
    const prev = setStatusLine(settings, value)
    expect(restoreStatusLine(settings, value, prev.previous, prev.hadPrevious)).toBe('removed')
    expect('statusLine' in settings).toBe(false)
    settings.statusLine = { type: 'command', command: 'user changed it' }
    expect(restoreStatusLine(settings, value, undefined, false)).toBe('changed')
    expect(validateStatusLine({ type: 'static' })).toBeNull()
  })

  it('sets and clears skill overrides', () => {
    const settings: Record<string, unknown> = {}
    expect(setSkillOverride(settings, 'pdf', 'off')).toBe(true)
    expect(skillOverride(settings, 'pdf')).toBe('off')
    expect(setSkillOverride(settings, 'pdf', 'off')).toBe(false)
    expect(setSkillOverride(settings, 'pdf', undefined)).toBe(true)
    expect(settings).toEqual({})
  })
})

describe('hook scripts', () => {
  let sb: Sandbox
  afterEach(async () => sb?.cleanup())

  it('finds script references in commands', () => {
    expect(
      scriptRefs([
        'python3 .claude/hooks/a.py',
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/b.sh',
        'bash $HOME/.claude/scripts/game/start.sh',
        '~/.claude/statusline.sh',
        'echo hi >> .claude/changes.log'
      ])
    ).toEqual([
      { rel: 'hooks/a.py', home: false },
      { rel: 'hooks/b.sh', home: false },
      { rel: 'scripts/game/start.sh', home: true },
      { rel: 'statusline.sh', home: true }
    ])
  })

  it('plans supporting files and companions for user and project scope', async () => {
    sb = await createSandbox()
    const json = { supportingFiles: [{ source: 'change-logger.py', destination: '.claude/hooks/change-logger.py', executable: true }, { source: 'x.sh', destination: '/etc/evil.sh' }] }
    const user = planScripts(json, ['python3 .claude/hooks/change-logger.py', 'python3 .claude/scripts/monitor.py'], 'cli-tool/components/hooks/automation/change-logger.json', {
      scope: 'user'
    })
    expect(user.files).toEqual([
      {
        repoPath: 'cli-tool/components/hooks/automation/change-logger.py',
        dest: join(sb.home, '.claude', 'hooks', 'change-logger.py'),
        rel: 'hooks/change-logger.py',
        home: false,
        executable: true,
        required: true
      },
      {
        repoPath: 'cli-tool/components/hooks/automation/monitor.py',
        dest: join(sb.home, '.claude', 'scripts', 'monitor.py'),
        rel: 'scripts/monitor.py',
        home: false,
        executable: true,
        required: false
      }
    ])
    expect(user.warnings[0]).toMatch(/outside a .claude folder/)
    const project = join(sb.root, 'proj')
    const p = planScripts(json, [], 'hooks/a/change-logger.json', { scope: 'project', projectPath: project })
    expect(p.files[0].dest).toBe(join(project, '.claude', 'hooks', 'change-logger.py'))
  })

  it('points project-relative script paths at the user folder, keeping quotes intact', () => {
    const rels = new Set(['hooks/x.py', 'hooks/g.sh'])
    const base = '$HOME/.claude'
    expect(rewriteForUserScope('python3 .claude/hooks/x.py', base, rels)).toBe('python3 "$HOME/.claude/hooks/x.py"')
    expect(rewriteForUserScope('python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.py', base, rels)).toBe('python3 "$HOME/.claude/hooks/x.py"')
    expect(rewriteForUserScope('python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/x.py" --event Stop', base, rels)).toBe('python3 "$HOME/.claude/hooks/x.py" --event Stop')
    expect(rewriteForUserScope("bash -c 'bash .claude/hooks/g.sh'", base, rels)).toBe(`bash -c 'bash "$HOME/.claude/hooks/g.sh"'`)
    expect(rewriteForUserScope('cat .claude/changes.log && ~/.claude/hooks/x.py', base, rels)).toBe('cat .claude/changes.log && ~/.claude/hooks/x.py')
    expect(quoteStateAt('a "b c" \'d', 9)).toBe('single')
  })

  it('swaps python3 for the working Python command on Windows only', () => {
    expect(adaptForPlatform('python3 x.py && python3 -c "1"', 'win32')).toBe('python x.py && python -c "1"')
    expect(adaptForPlatform('python3 x.py; python y.py', 'win32', 'py -3')).toBe('py -3 x.py; py -3 y.py')
    expect(adaptForPlatform('/usr/bin/python3 x.py', 'win32')).toBe('/usr/bin/python3 x.py')
    expect(adaptForPlatform('python3 x.py', 'linux')).toBe('python3 x.py')
    expect(usesPython(['bash x.sh', 'python3 -c 1'])).toBe(true)
    expect(usesPython(['bash /opt/python3/bin/tool.sh'])).toBe(false)
  })
})
