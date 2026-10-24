import { InvalidArgumentError } from 'commander'
import { describe, expect, it } from 'vitest'
import {
  buildTargetRefs,
  collect,
  pairsToArgValues,
  pairsToRecord,
  parseExtensionKind,
  parseModelTargets,
  parsePair,
  parsePositiveInt,
  parseScope,
  parseTargetList
} from '../../src/cli/args'
import { CliError } from '../../src/cli/errors'

describe('target aliases', () => {
  it('maps desktop/code aliases and comma lists, de-duplicated', () => {
    expect(parseTargetList('desktop,code')).toEqual(['claude-desktop', 'claude-code'])
    expect(parseTargetList(['Desktop', 'claude-code', 'code'])).toEqual(['claude-desktop', 'claude-code'])
    expect(parseTargetList(['vscode, cursor', 'windsurf'])).toEqual(['vscode', 'cursor', 'windsurf'])
    expect(parseTargetList('all')).toEqual(['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf'])
  })

  it('rejects unknown apps with the list of valid ones', () => {
    expect(() => parseTargetList('notepad')).toThrow(InvalidArgumentError)
    expect(() => parseTargetList('notepad')).toThrow(/desktop, code, vscode/)
  })

  it('model targets', () => {
    expect(parseModelTargets('code,vscode')).toEqual(['claude-code', 'vscode'])
    expect(parseModelTargets(['cli'])).toEqual(['claude-code'])
    expect(() => parseModelTargets('desktop')).toThrow(/code and\/or vscode/)
  })
})

describe('KEY=VALUE parsing', () => {
  it('splits at the first "=" and keeps the rest of the value', () => {
    expect(parsePair('TOKEN=abc=def', 'env')).toEqual(['TOKEN', 'abc=def'])
    expect(parsePair('EMPTY=', 'env')).toEqual(['EMPTY', ''])
    expect(parsePair('X-Api-Key=1', 'header')).toEqual(['X-Api-Key', '1'])
  })

  it('validates names', () => {
    expect(() => parsePair('novalue', 'env')).toThrow(/NAME=value/)
    expect(() => parsePair('=x', 'env')).toThrow(/NAME=value/)
    expect(() => parsePair('1BAD=x', 'env')).toThrow(/environment variable/)
    expect(() => parsePair('Bad Header=x', 'header')).toThrow(/header/)
  })

  it('builds records (later wins) and repeatable argument lists', () => {
    expect(pairsToRecord(['A=1', 'B=2', 'A=3'], 'env')).toEqual({ A: '3', B: '2' })
    expect(pairsToRecord(undefined, 'env')).toEqual({})
    expect(pairsToArgValues(['path=/a', 'path=/b', 'mode=ro', 'path=/c'])).toEqual({ path: ['/a', '/b', '/c'], mode: 'ro' })
  })

  it('collects repeated flags', () => {
    expect(collect('b', collect('a', []))).toEqual(['a', 'b'])
  })
})

describe('other parsers', () => {
  it('scope / numbers / extension kinds', () => {
    expect(parseScope('Project')).toBe('project')
    expect(() => parseScope('global')).toThrow(/user, project or local/)
    expect(parsePositiveInt('5')).toBe(5)
    expect(() => parsePositiveInt('0')).toThrow()
    expect(() => parsePositiveInt('2.5')).toThrow()
    expect(parseExtensionKind('skills')).toBe('skill')
    expect(parseExtensionKind('subagent')).toBe('agent')
    expect(parseExtensionKind('status-line')).toBe('statusline')
    expect(() => parseExtensionKind('widget')).toThrow(/plugin, skill/)
  })
})

describe('buildTargetRefs', () => {
  const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

  it('applies scope to Claude Code and VS Code only', () => {
    expect(buildTargetRefs(['claude-desktop', 'claude-code'], 'user', undefined, cwd)).toEqual([{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }])
  })

  it('defaults the project folder to the current directory and resolves relative paths', () => {
    expect(buildTargetRefs(['claude-code'], 'project', undefined, cwd)).toEqual([{ target: 'claude-code', scope: 'project', projectPath: cwd }])
    const refs = buildTargetRefs(['claude-code', 'vscode'], 'project', 'sub', cwd)
    expect(refs[0].projectPath?.endsWith('sub')).toBe(true)
    expect(refs[1]).toMatchObject({ target: 'vscode', scope: 'project' })
  })

  it('refuses local scope for VS Code', () => {
    expect(() => buildTargetRefs(['vscode'], 'local', undefined, cwd)).toThrow(CliError)
  })
})
