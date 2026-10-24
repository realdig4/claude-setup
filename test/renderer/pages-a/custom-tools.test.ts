import { describe, expect, it } from 'vitest'
import type { InstalledServer } from '@shared/types'
import {
  configToDraft,
  draftErrors,
  draftToConfig,
  emptyDraft,
  nameForConfig,
  nameProblem,
  newRow,
  parseConfigText,
  parseServerJson,
  splitCommandLine,
  suggestName,
  validateServerConfig
} from '../../../src/renderer/src/pages/discover/lib/customServer'
import {
  commandLine,
  countByTarget,
  editableValues,
  filterInstalled,
  groupByTarget,
  looksSecret,
  maskArg,
  maskUrl,
  projectPaths,
  safeSummary,
  toolKind,
  transportSummary,
  withValues
} from '../../../src/renderer/src/pages/installed/lib/tools'

describe('pages-a/customServer: drafts', () => {
  it('validates names like Claude does', () => {
    expect(nameProblem('')).toMatch(/name/)
    expect(nameProblem('my tool')).toMatch(/no spaces/)
    expect(nameProblem('a'.repeat(65))).toMatch(/64/)
    expect(nameProblem('workspace')).toMatch(/built-in/)
    expect(nameProblem('my-tool_2')).toBeNull()
  })

  it('reports field problems', () => {
    const draft = { ...emptyDraft(), name: 'x', command: 'npx -y foo', env: [newRow('1BAD', 'v')] }
    const errors = draftErrors(draft)
    expect(errors.command).toMatch(/only the program/)
    expect(errors.env).toMatch(/can’t start with a number/)
    expect(draftErrors({ ...draft, command: 'C:\\Program Files\\tool\\tool.exe', env: [] })).toEqual({})
    const remote = { ...emptyDraft(), name: 'x', kind: 'url' as const, url: 'example.com' }
    expect(draftErrors(remote).url).toMatch(/https:\/\//)
    expect(draftErrors({ ...remote, url: 'https://x.dev/mcp', headers: [newRow('A', '1'), newRow('a', '2')] }).headers).toMatch(/twice/)
  })

  it('converts drafts to configs and back', () => {
    const draft = { ...emptyDraft(), name: 'fs', command: ' npx ', args: ['-y', ' ', '@scope/fs'], env: [newRow('TOKEN', 'abc'), newRow('', '')] }
    const config = draftToConfig(draft)
    expect(config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@scope/fs'], env: { TOKEN: 'abc' } })
    const back = configToDraft('fs', config)
    expect(back.kind).toBe('command')
    expect(back.args).toEqual(['-y', '@scope/fs'])
    expect(back.env.map((r) => [r.key, r.value])).toEqual([['TOKEN', 'abc']])
    const remote = draftToConfig({ ...emptyDraft(), kind: 'url', url: 'https://a.dev/sse', transport: 'sse', headers: [newRow('X-Key', 'k')] })
    expect(remote).toEqual({ type: 'sse', url: 'https://a.dev/sse', headers: { 'X-Key': 'k' } })
  })

  it('splits typed command lines', () => {
    expect(splitCommandLine('npx -y "@scope/my server" \'a b\' ""')).toEqual(['npx', '-y', '@scope/my server', 'a b', ''])
    expect(splitCommandLine('   ')).toEqual([])
  })

  it('suggests names from packages, images and hosts', () => {
    expect(suggestName('@modelcontextprotocol/server-filesystem')).toBe('filesystem')
    expect(suggestName('io.github.github/github-mcp-server')).toBe('github')
    expect(suggestName('ghcr.io/org/tool:1.2')).toBe('tool')
    expect(suggestName('Brave Search')).toBe('brave-search')
    expect(suggestName('!!!')).toBe('server')
    expect(nameForConfig({ type: 'http', url: 'https://mcp.notion.com/mcp' })).toBe('notion')
    expect(nameForConfig({ type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'mcp/fetch'] })).toBe('fetch')
    expect(nameForConfig({ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('mcp')
  })
})

describe('pages-a/customServer: JSON', () => {
  it('accepts the shapes people paste', () => {
    expect(parseServerJson('{"command":"npx","args":["-y","x"],"env":{"PORT":3000}}')).toEqual({
      ok: true,
      name: undefined,
      config: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { PORT: '3000' } }
    })
    expect(parseServerJson('{"mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}')).toEqual({
      ok: true,
      name: 'github',
      config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }
    })
    expect(parseServerJson('{"servers":{"docs":{"type":"sse","url":"https://d.dev/sse","headers":{"A":"b"}}}}')).toMatchObject({
      ok: true,
      name: 'docs',
      config: { type: 'sse', headers: { A: 'b' } }
    })
    expect(parseServerJson('"memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },')).toMatchObject({
      ok: true,
      name: 'memory'
    })
    expect(parseServerJson('{"wind":{"serverUrl":"https://w.dev/mcp"}}')).toMatchObject({ ok: true, name: 'wind', config: { type: 'http' } })
  })

  it('explains problems', () => {
    expect(parseServerJson('')).toMatchObject({ ok: false })
    expect(parseServerJson('{nope')).toMatchObject({ ok: false, message: expect.stringMatching(/valid JSON/) })
    expect(parseServerJson('{"mcpServers":{}}')).toMatchObject({ ok: false })
    expect(parseServerJson('{"command":"npx","args":"-y x"}')).toMatchObject({ ok: false, message: expect.stringMatching(/list/) })
    expect(parseServerJson('{"url":"ftp://x"}')).toMatchObject({ ok: false })
  })

  it('strictly validates edited configs', () => {
    expect(validateServerConfig({ command: 'npx', args: ['-y'] })).toEqual({ ok: true, config: { type: 'stdio', command: 'npx', args: ['-y'] } })
    expect(validateServerConfig({ url: 'https://x.dev/mcp' })).toEqual({ ok: true, config: { type: 'http', url: 'https://x.dev/mcp' } })
    expect(validateServerConfig({ type: 'stdio', command: 'npx', env: { A: 1 } })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/quotes/)
    })
    expect(validateServerConfig({ type: 'ws', url: 'wss://x' })).toMatchObject({ ok: false })
    expect(validateServerConfig([])).toMatchObject({ ok: false })
    expect(parseConfigText('{ "command": ')).toMatchObject({ ok: false, message: expect.stringMatching(/valid JSON/) })
  })
})

describe('pages-a/installed tools', () => {
  const servers: InstalledServer[] = [
    {
      name: 'notion',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'] },
      enabled: true,
      configPath: 'a',
      managedByUs: true
    },
    {
      name: 'fs',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: 'npx', args: ['-y', '@scope/fs', 'C:\\My Docs'], env: { API_TOKEN: 't', HOST: 'h' } },
      enabled: false,
      configPath: 'a',
      managedByUs: true
    },
    {
      name: 'think',
      target: { target: 'claude-code', scope: 'project', projectPath: 'C:\\P\\Acme' },
      config: { type: 'stdio', command: 'docker', args: ['run', '-i', 'mcp/think'] },
      enabled: true,
      configPath: 'b',
      managedByUs: false
    },
    {
      name: 'gh',
      target: { target: 'claude-code', scope: 'user' },
      config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
      enabled: true,
      configPath: 'c',
      managedByUs: true
    }
  ]

  it('summarizes commands and kinds', () => {
    expect(commandLine({ type: 'stdio', command: 'npx', args: ['-y', 'a b', ''] })).toBe('npx -y "a b" ""')
    expect(transportSummary(servers[3]!.config)).toBe('https://api.githubcopilot.com/mcp/')
    expect(servers.map((s) => toolKind(s.config))).toEqual(['online', 'local', 'docker', 'online'])
  })

  it('filters and groups by app', () => {
    expect(filterInstalled(servers, { target: 'claude-code' }).map((s) => s.name)).toEqual(['think', 'gh'])
    expect(filterInstalled(servers, { scope: 'project' }).map((s) => s.name)).toEqual(['think'])
    expect(filterInstalled(servers, { projectPath: 'c:/p/acme/' }).map((s) => s.name)).toEqual(['think'])
    expect(filterInstalled(servers, { query: 'notion.com' }).map((s) => s.name)).toEqual(['notion'])
    expect(filterInstalled(servers, { query: 'files' }, (s) => (s.name === 'fs' ? 'Filesystem' : s.name)).map((s) => s.name)).toEqual(['fs'])
    const groups = groupByTarget(servers)
    expect(groups.map((g) => g.target)).toEqual(['claude-desktop', 'claude-code'])
    expect(groups[0]!.servers.map((s) => s.name)).toEqual(['fs', 'notion'])
    expect(groups[1]!.servers.map((s) => s.name)).toEqual(['gh', 'think'])
    expect(projectPaths(servers)).toEqual(['C:\\P\\Acme'])
    expect(countByTarget(servers)).toMatchObject({ 'claude-desktop': 2, 'claude-code': 2, vscode: 0 })
  })

  it('edits env and header values', () => {
    expect(looksSecret('GITHUB_TOKEN')).toBe(true)
    expect(looksSecret('Authorization')).toBe(true)
    expect(looksSecret('MEMORY_FILE_PATH')).toBe(false)
    const values = editableValues(servers[1]!.config)
    expect(values).toEqual([
      { kind: 'env', name: 'API_TOKEN', value: 't', secret: true },
      { kind: 'env', name: 'HOST', value: 'h', secret: false }
    ])
    expect(editableValues({ type: 'stdio', command: 'x', env: { DATABASE_URI: 'postgresql://u:pw@h/db' } })[0]?.secret).toBe(true)
    expect(withValues(servers[1]!.config, { API_TOKEN: 'new', NOPE: 'x' })).toMatchObject({ env: { API_TOKEN: 'new', HOST: 'h' } })
    expect(withValues(servers[3]!.config, { Authorization: 'Bearer y' })).toMatchObject({ headers: { Authorization: 'Bearer y' } })
  })

  it('hides keys and tokens in summaries', () => {
    expect(maskArg('Authorization:Bearer ghp_abcdefghijklmnop')).toBe('Authorization:Bearer ghp_••••op')
    expect(maskArg('X-Api-Key: 1234567890abcdef')).toBe('X-Api-Key: 1234••••ef')
    expect(maskArg('--api-key=sk-live-123456789')).toBe('--api-key=sk-l••••89')
    expect(maskArg('sk-proj-ABCDEFGHIJKLMNOP')).toBe('sk-p••••OP')
    expect(maskArg('C:\Users\you\Documents')).toBe('C:\Users\you\Documents')
    expect(maskArg('-y')).toBe('-y')
    expect(maskUrl('postgresql://admin:supersecret@db.local/app')).toBe('postgresql://admin:supe••••et@db.local/app')
    expect(maskUrl('https://x.dev/mcp?api_key=abcdef123456&mode=full')).toBe('https://x.dev/mcp?api_key=abcd••••56&mode=full')
    const bridged = safeSummary({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://api.githubcopilot.com/mcp/', '--header', 'Authorization:Bearer ghp_EXAMPLEexample0000']
    })
    expect(bridged).not.toContain('EXAMPLEexample')
    expect(bridged).toContain('mcp-remote https://api.githubcopilot.com/mcp/ --header')
    expect(safeSummary({ type: 'stdio', command: 'tool', args: ['--token', 'abcdefghijkl'] })).toBe('tool --token abcd••••kl')
  })
})
