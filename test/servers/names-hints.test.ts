import { describe, expect, it } from 'vitest'
import { dockerRisks, requiredRuntimes } from '@core/servers/checks'
import { commandTool, hintFor, missingEnvVars } from '@core/servers/hints'
import { nameFromConfig, sanitizeServerName, uniqueServerName } from '@core/servers/names'

describe('server names', () => {
  it.each([
    ['@modelcontextprotocol/server-filesystem', 'filesystem'],
    ['io.github.github/github-mcp-server', 'github'],
    ['@brave/brave-search-mcp-server', 'brave-search'],
    ['mcp-server-fetch', 'fetch'],
    ['ghcr.io/github/github-mcp-server:2.0.3', 'github'],
    ['Brave Search', 'brave-search'],
    ['some.pkg@1.2.3', 'some-pkg'],
    ['!!!', 'server'],
    ['a'.repeat(80), 'a'.repeat(64)]
  ])('%s → %s', (input, expected) => {
    expect(sanitizeServerName(input)).toBe(expected)
  })

  it('derives names from configs', () => {
    expect(nameFromConfig({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'] })).toBe('memory')
    expect(nameFromConfig({ type: 'stdio', command: 'uvx', args: ['--from', 'mcp-server-git==1.0', 'mcp-server-git'] })).toBe('git')
    expect(nameFromConfig({ type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'mcp/time:latest'] })).toBe('time')
    expect(nameFromConfig({ type: 'stdio', command: 'node', args: ['C:\\tools\\weather-server.js'] })).toBe('weather')
    expect(nameFromConfig({ type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'tavily-mcp'] })).toBe('tavily')
    expect(nameFromConfig({ type: 'http', url: 'https://mcp.notion.com/mcp' })).toBe('notion')
    expect(nameFromConfig({ type: 'http', url: 'https://api.githubcopilot.com/mcp/' })).toBe('githubcopilot')
  })

  it('makes names unique', () => {
    expect(uniqueServerName('github', ['github', 'github-2'])).toBe('github-3')
    expect(uniqueServerName('fresh', ['other'])).toBe('fresh')
  })
})

describe('failure hints', () => {
  const npx = { type: 'stdio' as const, command: 'npx', args: ['-y', 'x'] }

  it('extracts missing environment variable names from error output', () => {
    expect(missingEnvVars('Error: GITHUB_PERSONAL_ACCESS_TOKEN environment variable is required')).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN'])
    expect(missingEnvVars("KeyError: 'BRAVE_API_KEY'")).toEqual(['BRAVE_API_KEY'])
    expect(missingEnvVars('Missing required env var: SLACK_BOT_TOKEN and SLACK_TEAM_ID')).toEqual(['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'])
    expect(missingEnvVars('Error: Cannot find module x\n code: MODULE_NOT_FOUND')).toEqual([])
    expect(missingEnvVars('listening on stdio')).toEqual([])
  })

  it('maps failure kinds to next steps', () => {
    expect(hintFor({ kind: 'process-exited', stderr: 'API_TOKEN is not set', config: npx, timeoutMs: 60000 })).toContain('API_TOKEN')
    expect(hintFor({ kind: 'command-not-found', config: npx, timeoutMs: 60000 })).toMatch(/Node\.js/)
    expect(hintFor({ kind: 'command-not-found', config: { type: 'stdio', command: 'uvx', args: ['x'] }, timeoutMs: 60000 })).toMatch(/uv/)
    expect(hintFor({ kind: 'process-exited', stderr: "'docker' is not recognized as an internal or external command", config: { type: 'stdio', command: 'docker' }, timeoutMs: 60000 })).toMatch(/Docker Desktop/)
    expect(
      hintFor({
        kind: 'process-exited',
        stderr: 'docker: error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
        config: { type: 'stdio', command: 'docker', args: ['run', '-i', 'img'] },
        timeoutMs: 60000
      })
    ).toMatch(/isn't running/)
    expect(hintFor({ kind: 'auth-required', status: 401, config: { type: 'http', url: 'https://x/mcp' }, timeoutMs: 60000 })).toMatch(/sign in/)
    expect(hintFor({ kind: 'timeout', config: npx, timeoutMs: 60000 })).toMatch(/60 seconds.*npx downloads/)
    expect(hintFor({ kind: 'timeout', config: { type: 'http', url: 'https://x/mcp' }, timeoutMs: 30000 })).toMatch(/30 seconds/)
    expect(hintFor({ kind: 'error', status: 410, config: { type: 'sse', url: 'https://x/sse' }, timeoutMs: 1000 })).toMatch(/\/mcp/)
    expect(hintFor({ kind: 'process-exited', stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope', config: npx, timeoutMs: 1 })).toMatch(/wasn't found on npm/)
    expect(hintFor({ kind: 'process-exited', stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org', config: npx, timeoutMs: 1 })).toMatch(/network/)
    expect(hintFor({ kind: 'invalid-config', error: 'Enter the command', config: npx, timeoutMs: 1 })).toContain('Enter the command')
    // A folder from the settings is missing: not a "Node.js isn't installed" situation.
    const enoent = "Error: ENOENT: no such file or directory, stat 'C:\\Users\\me\\Nope'"
    const pathHint = hintFor({ kind: 'process-exited', stderr: enoent, config: npx, timeoutMs: 1 })
    expect(pathHint).toContain('C:\\Users\\me\\Nope')
    expect(pathHint).not.toMatch(/Node\.js/)
    expect(hintFor({ kind: 'error', error: 'spawn uvx ENOENT', config: { type: 'stdio', command: 'uvx', args: ['x'] }, timeoutMs: 1 })).toMatch(/uv \(which provides uvx\)/)
  })

  it('identifies the runtime of a command', () => {
    expect(commandTool({ type: 'stdio', command: 'C:\\Program Files\\nodejs\\npx.cmd' }).tool).toBe('node')
    expect(commandTool({ type: 'stdio', command: 'cmd', args: ['/c', 'uvx', 'x'] }).tool).toBe('uv')
    expect(commandTool({ type: 'stdio', command: '/usr/local/bin/docker' }).tool).toBe('docker')
    expect(commandTool({ type: 'stdio', command: 'my-tool' })).toEqual({ tool: 'other', command: 'my-tool' })
  })
})

describe('pre-install checks', () => {
  it('lists required runtimes', () => {
    expect(requiredRuntimes({ type: 'stdio', command: 'npx' })).toEqual(['npx'])
    expect(requiredRuntimes({ type: 'stdio', command: 'uvx' })).toEqual(['uvx'])
    expect(requiredRuntimes({ type: 'stdio', command: 'docker' })).toEqual(['docker'])
    expect(requiredRuntimes({ type: 'http', url: 'https://x/mcp' })).toEqual([])
    expect(requiredRuntimes({ type: 'http', url: 'https://x/mcp' }, true)).toEqual(['npx'])
  })

  it('warns about risky docker options', () => {
    const risks = dockerRisks({
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '--privileged', '--network=host', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', 'C:\\data:/data', '-p', '8080:80', '-v', '/anon', 'img']
    })
    expect(risks.join('\n')).toMatch(/--privileged/)
    expect(risks.join('\n')).toMatch(/network host/)
    expect(risks.join('\n')).toMatch(/Docker socket/)
    expect(risks.join('\n')).toMatch(/C:\\data/)
    expect(risks.join('\n')).toMatch(/port 8080:80/)
    expect(risks.join('\n')).not.toMatch(/\/anon/)
    expect(dockerRisks({ type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'mcp/time'] })).toEqual([])
    expect(dockerRisks({ type: 'stdio', command: 'npx', args: ['--privileged'] })).toEqual([])
  })
})
