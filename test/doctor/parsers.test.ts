import { describe, expect, it } from 'vitest'
import { launcherOf } from '@core/doctor/checks/mcp'
import { failuresFromEvents, parseMcpEvents } from '@core/doctor/desktopLogs'
import { parseRegQuery, policyIsOff } from '@core/doctor/policies'

describe('Desktop log parsing', () => {
  it('keeps the newest event per server', () => {
    const events = parseMcpEvents([
      '2026-10-23 09:00:00 [error] [LocalMcpServerManager] Failed to connect to alpha: Error: spawn uvx ENOENT',
      '2026-10-23 09:00:01 [info] [LocalMcpServerManager] Connected to beta (12 tools)',
      '2026-10-23 09:10:00 [error] [LocalMcpServerManager] Failed to connect to beta:',
      'not a log line',
      '2026-10-23 08:00:00 [info] [LocalMcpServerManager] Connected to alpha (1 tool)'
    ])
    expect(events).toHaveLength(4)
    expect(failuresFromEvents(events)).toEqual([
      { name: 'alpha', time: '2026-10-23 09:00:00' },
      { name: 'beta', time: '2026-10-23 09:10:00' }
    ])
  })

  it('treats a later success as recovery', () => {
    const events = parseMcpEvents([
      '2026-10-23 09:00:00 [error] [LocalMcpServerManager] Failed to connect to gamma: x',
      '2026-10-23 09:05:00 [info] [LocalMcpServerManager] Connected to gamma (2 tools)'
    ])
    expect(failuresFromEvents(events)).toEqual([])
  })
})

describe('policy parsing', () => {
  it('reads reg query output', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude',
      '    isLocalDevMcpEnabled    REG_DWORD    0x0',
      '    isDesktopExtensionEnabled    REG_SZ    false',
      '    managedMcpServers    REG_SZ    [{"name":"x"}]',
      ''
    ].join('\r\n')
    expect(parseRegQuery(out)).toEqual({ isLocalDevMcpEnabled: '0', isDesktopExtensionEnabled: 'false', managedMcpServers: '[{"name":"x"}]' })
  })

  it('understands "off" values', () => {
    expect(policyIsOff('0')).toBe(true)
    expect(policyIsOff('false')).toBe(true)
    expect(policyIsOff('FALSE')).toBe(true)
    expect(policyIsOff('1')).toBe(false)
    expect(policyIsOff('true')).toBe(false)
    expect(policyIsOff(undefined)).toBe(false)
  })
})

describe('MCP launcher detection', () => {
  it('unwraps cmd /c', () => {
    expect(launcherOf({ type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'x'] })).toBe('npx')
    expect(launcherOf({ type: 'stdio', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/C', 'uvx', 'y'] })).toBe('uvx')
    expect(launcherOf({ type: 'stdio', command: 'node', args: ['server.js'] })).toBe('node')
  })
})
