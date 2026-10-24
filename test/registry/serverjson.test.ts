import { describe, expect, it } from 'vitest'
import type { InstallOption } from '@shared/types'
import { mapServerJson, packageFromJson, remoteFromJson, headerSpec } from '@core/registry/serverjson'
import { buildServerConfig, expandArgs, applyHeaderTemplate } from '@core/registry/launch'
import type { HeaderSpec } from '@core/registry/types'
import { fixture } from './helpers'

type Page = { servers: Array<{ server: Record<string, unknown> }> }
const page1 = fixture<Page>('official-page-1.json')
const page2 = fixture<Page>('official-page-2.json')
const server = (name: string) => [...page1.servers, ...page2.servers].find((s) => s.server.name === name)!.server

describe('server.json → InstallOption', () => {
  it('maps an npm package with a secret env var (brave)', () => {
    const { options, keys } = mapServerJson(server('io.github.brave/brave-search-mcp-server'))
    expect(options).toHaveLength(1)
    const o = options[0]
    expect(o).toMatchObject({ kind: 'npm', runtime: 'node', transport: 'stdio', command: 'npx', package: '@brave/brave-search-mcp-server', version: '2.1.3' })
    // the default npm registry URL is not passed explicitly
    expect(o.args).toEqual(['-y', '@brave/brave-search-mcp-server@2.1.3'])
    expect(o.env).toEqual([expect.objectContaining({ name: 'BRAVE_API_KEY', required: true, secret: true, format: undefined })])
    expect(keys).toContain('npm:@brave/brave-search-mcp-server')
    expect(keys).toContain('repo:github.com/brave/brave-search-mcp-server')
  })

  it('maps a pypi package to uvx pkg@version', () => {
    const { options } = mapServerJson(server('ai.anomalyarmor/armor-mcp'))
    const pypi = options.find((o) => o.kind === 'pypi')!
    expect(pypi).toMatchObject({ kind: 'pypi', runtime: 'uv', command: 'uvx', args: ['armor-mcp@0.6.1'] })
    expect(pypi.env[0]).toMatchObject({ name: 'ARMOR_API_KEY', required: true, secret: true })
    expect(pypi.env[0].helpUrl).toBe('https://app.anomalyarmor.ai/settings/api-keys')
  })

  it('maps a nuget package to dnx with --yes', () => {
    const { options } = mapServerJson(server('cloud.anythink/anythink'))
    expect(options.find((o) => o.kind === 'nuget')).toMatchObject({ runtime: 'dotnet', command: 'dnx', args: ['anythink-mcp@0.2.37', '--yes'] })
  })

  it('maps an OCI image to docker run, turning -e NAME={var} into an env spec', () => {
    const { options, keys } = mapServerJson(server('io.github.github/github-mcp-server'))
    const docker = options.find((o) => o.kind === 'docker')!
    expect(docker.command).toBe('docker')
    expect(docker.args).toEqual([
      'run',
      '-i',
      '--rm',
      '-p',
      '127.0.0.1:8085:8085',
      '-e',
      'GITHUB_OAUTH_CALLBACK_PORT=8085',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'ghcr.io/github/github-mcp-server:2.0.3'
    ])
    expect(docker.env).toEqual([expect.objectContaining({ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', secret: true, required: false })])
    expect(docker.notes).toMatch(/-p 127\.0\.0\.1:8085:8085/)
    expect(keys).toContain('oci:ghcr.io/github/github-mcp-server')
  })

  it('maps remotes with secret headers and prefers them as the default option', () => {
    const { options, keys } = mapServerJson(server('io.github.github/github-mcp-server'))
    expect(options[0]).toMatchObject({ kind: 'remote', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', runtime: 'none' })
    expect(options[0].headers).toEqual([expect.objectContaining({ name: 'Authorization', secret: true, required: false, placeholder: 'Bearer <token>' })])
    expect(keys).toContain('remote:api.githubcopilot.com/mcp')
  })

  it('maps mcpb bundles with their checksum and npm/remote siblings (context7)', () => {
    const { options } = mapServerJson(server('io.github.upstash/context7'))
    expect(options.map((o) => o.kind)).toEqual(['remote', 'npm', 'mcpb'])
    const mcpb = options[2] as InstallOption & { sha256?: string }
    expect(mcpb.package).toMatch(/context7\.mcpb$/)
    expect(mcpb.sha256).toBe('25cabf3767cc61171e3435c4ce5427e03ffe7ab671cc0e2d5b89e04eef246949')
    expect(mcpb.runtime).toBe('none')
    expect(options[1].env[0]).toMatchObject({ name: 'CONTEXT7_API_KEY', secret: true, required: false })
  })

  it('maps remote URL template variables to argument placeholders (with choices in the description)', () => {
    const { options } = mapServerJson(server('ai.autorfp/mcp'))
    expect(options[0].url).toBe('https://{{arg:api_host}}/mcp')
    expect(options[0].argsSpec).toEqual([expect.objectContaining({ name: 'api_host', required: true })])
    expect(options[0].argsSpec![0].description).toMatch(/Allowed values: api\.autorfp\.ai, api\.eu\.autorfp\.ai/)
  })

  it('maps several packages including positional packageArguments (azure)', () => {
    const { options } = mapServerJson(server('com.microsoft/azure'))
    const npm = options.find((o) => o.kind === 'npm')!
    expect(npm.args).toEqual(['-y', '@azure/mcp@3.0.0-beta.48', 'server', 'start'])
    const nuget = options.find((o) => o.kind === 'nuget')!
    expect(nuget.args).toEqual(['Azure.Mcp@3.0.0-beta.48', '--yes', '--', 'server', 'start'])
    const pypi = options.find((o) => o.kind === 'pypi')!
    expect(pypi.args).toEqual(['msmcp-azure@3.0.0b48', 'server', 'start'])
  })

  it('handles named/positional args with values, variables, hints, optional and boolean flags', () => {
    const opt = packageFromJson({
      registryType: 'npm',
      identifier: 'demo-mcp',
      version: '1.0.0',
      registryBaseUrl: 'https://npm.example.com',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'named', name: '--node-options', value: '--max-old-space-size=512' }],
      packageArguments: [
        { type: 'positional', valueHint: 'workspace', description: 'Folder to serve', isRequired: true, format: 'filepath' },
        { type: 'named', name: '--port', value: '{port}', variables: { port: { default: '8080', description: 'Port' } } },
        { type: 'named', name: '--token', description: 'Optional API token' },
        { type: 'named', name: '--read-only', format: 'boolean', description: 'Read only' },
        { type: 'named', name: '--tag', description: 'Tags', isRepeated: true, isRequired: true }
      ],
      environmentVariables: [
        { name: 'MODE', value: 'production' },
        { name: 'API_URL', value: 'https://{host}/v1', variables: { host: { default: 'api.example.com' } } },
        { name: 'bad name', value: 'x' }
      ]
    })!
    expect(opt.args).toEqual([
      '-y',
      '--node-options',
      '--max-old-space-size=512',
      '--registry',
      'https://npm.example.com',
      'demo-mcp@1.0.0',
      '{{arg:workspace}}',
      '--port',
      '{{arg:port}}',
      '--token',
      '{{arg:token}}',
      '--tag',
      '{{arg:tag}}'
    ])
    expect(opt.argsSpec).toEqual([
      expect.objectContaining({ name: 'workspace', required: true, format: 'path' }),
      expect.objectContaining({ name: 'port', required: false, default: '8080' }),
      expect.objectContaining({ name: 'token', required: false }),
      expect.objectContaining({ name: 'tag', required: true, repeatable: true })
    ])
    expect(opt.notes).toMatch(/Optional flags: --read-only/)
    expect(opt.env).toEqual([
      expect.objectContaining({ name: 'MODE', default: 'production', required: false }),
      expect.objectContaining({ name: 'API_URL', default: 'https://api.example.com/v1', placeholder: 'https://{host}/v1' })
    ])
  })

  it('caps optional arguments and says so', () => {
    const packageArguments = Array.from({ length: 14 }, (_, i) => ({ type: 'named', name: `--opt${i}`, description: `Option ${i}` }))
    const opt = packageFromJson({ registryType: 'npm', identifier: 'big', version: '1.0.0', transport: { type: 'stdio' }, packageArguments })!
    expect(opt.argsSpec).toHaveLength(10)
    expect(opt.notes).toMatch(/4 more optional setting/)
  })

  it('turns local-HTTP packages, cargo crates and unknown types into manual options', () => {
    expect(packageFromJson({ registryType: 'npm', identifier: 'web-mcp', transport: { type: 'streamable-http' } })).toMatchObject({ kind: 'manual' })
    const cargo = packageFromJson({ registryType: 'cargo', identifier: 'mochify', version: '1.6.2', transport: { type: 'stdio' } })!
    expect(cargo.kind).toBe('manual')
    expect(cargo.notes).toMatch(/cargo install mochify --version 1\.6\.2 --locked/)
    expect(packageFromJson({ registryType: 'other', identifier: 'uv', transport: { type: 'stdio' }, runtimeHint: 'uv' })).toMatchObject({ kind: 'manual' })
  })

  it('keeps optional "--flag {var}" droppable and leaves optional templated flags to the user', () => {
    const opt = packageFromJson({
      registryType: 'pypi',
      identifier: 'demo',
      version: '1.0.0',
      transport: { type: 'stdio' },
      packageArguments: [
        { type: 'named', name: '--api-key', value: '{key}', variables: { key: { isSecret: true, description: 'API key' } } },
        { type: 'named', name: '--header', value: 'Authorization: Bearer {token}', variables: { token: { isSecret: true } } },
        { type: 'named', name: '--region', value: 'region={region}', isRequired: true, variables: { region: { isRequired: true } } }
      ]
    })!
    expect(opt.args).toEqual(['demo@1.0.0', '--api-key', '{{arg:api-key}}', '--region', 'region={{arg:region}}'])
    expect(opt.argsSpec?.map((a) => [a.name, a.required])).toEqual([
      ['api-key', false],
      ['region', true]
    ])
    expect(opt.notes).toMatch(/Optional flags: --header/)
    const built = buildServerConfig(opt, { args: { region: 'eu' } })
    expect(built.config).toMatchObject({ args: ['demo@1.0.0', '--region', 'region=eu'] })
  })

  it('prefixes docker images without host with a non-docker.io registry base', () => {
    const opt = packageFromJson({ registryType: 'oci', identifier: 'team/tool:1.2', registryBaseUrl: 'https://ghcr.io', transport: { type: 'stdio' } })!
    expect(opt.args?.at(-1)).toBe('ghcr.io/team/tool:1.2')
  })

  it('ignores unsupported remote transports and builds labels for extra remotes', () => {
    expect(remoteFromJson({ type: 'websocket', url: 'wss://x' }, 0, 1)).toBeUndefined()
    const second = remoteFromJson({ type: 'streamable-http', url: 'https://mcp.linear.app/mcp/readonly' }, 1, 2)!
    expect(second.label).toBe('Remote (mcp.linear.app/mcp/readonly)')
  })

  it('derives header templates from "Bearer {token}" values and undeclared tokens', () => {
    const h = headerSpec({ name: 'Authorization', value: 'Bearer {smithery_api_key}' })!
    expect(h).toMatchObject({ name: 'Authorization', required: true, secret: true, template: 'Bearer {{value}}', placeholder: 'Bearer <smithery_api_key>' })
    const fixed = headerSpec({ name: 'Accept', value: 'application/json, text/event-stream' })!
    expect(fixed).toMatchObject({ required: false, default: 'application/json, text/event-stream' })
    expect(fixed.template).toBeUndefined()
  })
})

describe('buildServerConfig (placeholder expansion)', () => {
  const fs: InstallOption = {
    id: 'npm',
    kind: 'npm',
    label: 'npm',
    runtime: 'node',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.0', '{{arg:directories}}'],
    env: [],
    argsSpec: [{ name: 'directories', required: true, repeatable: true, format: 'directory' }]
  }

  it('repeats repeatable arguments and reports missing required values', () => {
    const ok = buildServerConfig(fs, { args: { directories: ['C:\\Users\\me\\Documents', '/home/me/projects'] } })
    expect(ok.ok).toBe(true)
    expect(ok.config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.0', 'C:\\Users\\me\\Documents', '/home/me/projects']
    })
    const missing = buildServerConfig(fs, {})
    expect(missing.ok).toBe(false)
    expect(missing.missing).toEqual(['directories'])
  })

  it('drops an optional argument together with its flag, keeps it when given', () => {
    const time: InstallOption = {
      id: 'pypi',
      kind: 'pypi',
      label: 'uvx',
      runtime: 'uv',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time@2026.10.19', '--local-timezone', '{{arg:local-timezone}}'],
      env: [],
      argsSpec: [{ name: 'local-timezone', required: false }]
    }
    expect(buildServerConfig(time).config).toEqual({ type: 'stdio', command: 'uvx', args: ['mcp-server-time@2026.10.19'] })
    expect(buildServerConfig(time, { args: { 'local-timezone': 'Europe/Paris' } }).config).toMatchObject({
      args: ['mcp-server-time@2026.10.19', '--local-timezone', 'Europe/Paris']
    })
  })

  it('repeats named repeatable flags and fills env placeholders inside args', () => {
    expect(expandArgs(['--tag', '{{arg:tag}}', '-e', 'H={"Authorization": "Bearer {{TOKEN}}"}'], { tag: ['a', 'b'] }, { TOKEN: 'secret' })).toEqual([
      '--tag',
      'a',
      '--tag',
      'b',
      '-e',
      'H={"Authorization": "Bearer secret"}'
    ])
  })

  it('writes env values (user input, else default) and appends extra args', () => {
    const opt: InstallOption = {
      id: 'docker',
      kind: 'docker',
      label: 'Docker',
      runtime: 'docker',
      transport: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'API_KEY', '-e', 'MODE', 'img'],
      env: [
        { name: 'API_KEY', required: true, secret: true },
        { name: 'MODE', required: false, secret: false, default: 'stdio' },
        { name: 'OPTIONAL', required: false, secret: false }
      ]
    }
    const r = buildServerConfig(opt, { env: { API_KEY: ' k ' }, extraArgs: ['--verbose'] })
    expect(r.ok).toBe(true)
    expect(r.config).toEqual({ type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'API_KEY', '-e', 'MODE', 'img', '--verbose'], env: { API_KEY: 'k', MODE: 'stdio' } })
  })

  it('builds remote configs with URL arguments and header templates', () => {
    const remote: InstallOption = {
      id: 'remote',
      kind: 'remote',
      label: 'Remote',
      runtime: 'none',
      transport: 'http',
      url: 'https://{{arg:api_host}}/mcp',
      env: [],
      argsSpec: [{ name: 'api_host', required: true }],
      headers: [{ name: 'Authorization', required: true, secret: true, template: 'Bearer {{value}}' } as HeaderSpec]
    }
    const r = buildServerConfig(remote, { args: { api_host: 'api.eu.example.com' }, headers: { Authorization: 'abc123' } })
    expect(r).toMatchObject({ ok: true, config: { type: 'http', url: 'https://api.eu.example.com/mcp', headers: { Authorization: 'Bearer abc123' } } })
    const typedFull = buildServerConfig(remote, { args: { api_host: 'x.example.com' }, headers: { Authorization: 'Bearer abc' } })
    expect(typedFull.config).toMatchObject({ headers: { Authorization: 'Bearer abc' } })
    const missing = buildServerConfig(remote, {})
    expect(missing.ok).toBe(false)
    expect(missing.missing.sort()).toEqual(['Authorization', 'api_host'])
    expect(applyHeaderTemplate({ name: 'X', required: false, secret: false }, 'v')).toBe('v')
  })

  it('refuses options without a launch template', () => {
    const r = buildServerConfig({ id: 'manual', kind: 'manual', label: 'Manual', runtime: 'none', transport: 'stdio', env: [], notes: 'Follow the README.' })
    expect(r.ok).toBe(false)
    expect(r.warnings).toEqual(['Follow the README.'])
  })
})
