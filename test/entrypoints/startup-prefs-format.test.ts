import { describe, expect, it } from 'vitest'
import { defaultState } from '@core/state'
import type { ModelStatus } from '@shared/types'
import { refsFor, splitCommandLine } from '../../src/mcp/common'
import { capStructured, capText, configLine, redactConfig, tail, truncate } from '../../src/mcp/format'
import { isVisibleOnSomeDisplay, restoreBounds } from '../../src/main/prefs'
import { shouldAutostartProxy } from '../../src/main/startup'
import { sampleProfile, sampleProvider } from './fakeCore'

describe('shouldAutostartProxy', () => {
  const proxyProvider = { ...sampleProvider, id: 'openai', kind: 'openai-proxy' as const }
  const proxyProfile = { ...sampleProfile, id: 'gpt', providerId: 'openai' }
  const custom: ModelStatus = { mode: 'custom', profileId: 'gpt', vscodeConfigured: false, vscodeMatches: false, problems: [], shellOverrides: [] }

  it('starts for an applied openai-proxy profile when auto-start is on', () => {
    const state = defaultState()
    expect(shouldAutostartProxy({ state, status: custom, profiles: [proxyProfile], providers: [proxyProvider], proxy: { running: false, requests: 0, errors: 0 } })).toBe(true)
  })

  it('does not start when disabled, already running, not applied, or not a proxy provider', () => {
    const off = { ...defaultState(), proxy: { ...defaultState().proxy, autoStart: false } }
    expect(shouldAutostartProxy({ state: off, status: custom, profiles: [proxyProfile], providers: [proxyProvider], proxy: null })).toBe(false)
    expect(shouldAutostartProxy({ state: defaultState(), status: custom, profiles: [proxyProfile], providers: [proxyProvider], proxy: { running: true, requests: 0, errors: 0 } })).toBe(false)
    expect(shouldAutostartProxy({ state: defaultState(), status: { ...custom, mode: 'anthropic' }, profiles: [proxyProfile], providers: [proxyProvider], proxy: null })).toBe(false)
    expect(shouldAutostartProxy({ state: defaultState(), status: { ...custom, profileId: 'kimi-1' }, profiles: [sampleProfile], providers: [sampleProvider], proxy: null })).toBe(false)
  })

  it('falls back to the remembered active profile when the status is unavailable', () => {
    const state = { ...defaultState(), activeProfileId: 'gpt' }
    expect(shouldAutostartProxy({ state, status: null, profiles: [proxyProfile], providers: [proxyProvider], proxy: null })).toBe(true)
  })
})

describe('window bounds', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }]

  it('keeps visible positions, drops off-screen ones and enforces the minimum size', () => {
    expect(restoreBounds({ x: 100, y: 100, width: 1300, height: 900 }, screens, { width: 980, height: 640 })).toEqual({ x: 100, y: 100, width: 1300, height: 900 })
    expect(restoreBounds({ x: 5000, y: 100, width: 1300, height: 900 }, screens, { width: 980, height: 640 })).toEqual({ width: 1300, height: 900 })
    expect(restoreBounds({ width: 300, height: 200 }, screens, { width: 980, height: 640 })).toEqual({ width: 980, height: 640 })
    expect(restoreBounds(undefined, screens, { width: 980, height: 640 })).toBeUndefined()
  })

  it('requires the title area to be reachable', () => {
    expect(isVisibleOnSomeDisplay({ x: -1200, y: 10, width: 1240, height: 800 }, screens)).toBe(false)
    expect(isVisibleOnSomeDisplay({ x: 1800, y: 10, width: 1240, height: 800 }, screens)).toBe(true)
    expect(isVisibleOnSomeDisplay({ x: 100, y: 1030, width: 1240, height: 800 }, screens)).toBe(false)
  })
})

describe('MCP formatting helpers', () => {
  it('truncate/tail/capText', () => {
    expect(truncate('a  b\n c', 10)).toBe('a b c')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
    expect(tail('1\n2\n3\n4', 100, 2)).toBe('3\n4')
    expect(capText('x'.repeat(30_000)).length).toBeLessThanOrEqual(20_000)
  })

  it('redacts secret values from configs', () => {
    expect(redactConfig({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'secret' } })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], envNames: ['TOKEN'] })
    expect(redactConfig({ type: 'http', url: 'https://x', headers: { Authorization: 'Bearer s' } })).toEqual({ type: 'http', url: 'https://x', headerNames: ['Authorization'] })
    expect(configLine({ type: 'stdio', command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg'] })).toBe('"C:\\Program Files\\nodejs\\npx.cmd" -y pkg')
    expect(configLine({ type: 'stdio', command: 'node', args: ['say "hi"'] })).toBe('node "say \\"hi\\""')
  })

  it('capStructured trims the largest array and marks the result', () => {
    const data = { total: 500, items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'y'.repeat(200) })) }
    const capped = capStructured(data, 10_000)
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(10_000)
    expect(capped.truncated).toBe(true)
    expect(capped.total).toBe(500)
    expect(capStructured({ a: 1 })).toEqual({ a: 1 })
  })

  it('splitCommandLine only splits plain command lines', () => {
    expect(splitCommandLine('npx -y @scope/pkg "a b"', undefined)).toEqual({ command: 'npx', args: ['-y', '@scope/pkg', 'a b'] })
    expect(splitCommandLine('C:\\Program Files\\x\\tool.exe', undefined)).toEqual({ command: 'C:\\Program Files\\x\\tool.exe', args: [] })
    expect(splitCommandLine('uvx', ['mcp-server-git'])).toEqual({ command: 'uvx', args: ['mcp-server-git'] })
  })

  it('refsFor applies scopes per app', () => {
    const p = process.platform === 'win32' ? 'C:\\p' : '/p'
    expect(refsFor(['claude-desktop', 'claude-code', 'vscode'], 'project', p)).toEqual([
      { target: 'claude-desktop' },
      { target: 'claude-code', scope: 'project', projectPath: p },
      { target: 'vscode', scope: 'project', projectPath: p }
    ])
    expect(refsFor(['claude-code', 'claude-code'], 'user')).toEqual([{ target: 'claude-code', scope: 'user' }])
    expect(() => refsFor([], 'user')).toThrow(/at least one/)
    expect(() => refsFor(['claude-code'], 'local', 'relative/path')).toThrow(/absolute/)
  })
})
