import { describe, expect, it } from 'vitest'
import type { InstallOption } from '@shared/types'
import { buildServerConfig, buildServerConfigStrict, MissingValuesError, UnsupportedOptionError } from '@core/servers/build'

const base = (o: Partial<InstallOption>): InstallOption => ({ id: 'x', kind: 'npm', label: 'Test', runtime: 'node', transport: 'stdio', env: [], ...o })

describe('buildServerConfig — defaults per kind', () => {
  it('npm → npx -y pkg@version, env values kept', () => {
    const r = buildServerConfigStrict(
      base({ package: '@brave/brave-search-mcp-server', version: '2.1.3', env: [{ name: 'BRAVE_API_KEY', required: true, secret: true }] }),
      { env: { BRAVE_API_KEY: 'bk-1' } }
    )
    expect(r.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'], env: { BRAVE_API_KEY: 'bk-1' } })
  })

  it('npm without a version → bare package name', () => {
    expect(buildServerConfigStrict(base({ package: 'some-mcp' })).config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] })
  })

  it('pypi → uvx pkg@version', () => {
    const r = buildServerConfigStrict(base({ kind: 'pypi', runtime: 'uv', package: 'mcp-server-fetch', version: '1.2.0' }))
    expect(r.config).toEqual({ type: 'stdio', command: 'uvx', args: ['mcp-server-fetch@1.2.0'] })
    expect(buildServerConfigStrict(base({ kind: 'pypi', runtime: 'uv', package: 'armor-mcp' })).config).toEqual({ type: 'stdio', command: 'uvx', args: ['armor-mcp'] })
  })

  it('docker → docker run -i --rm -e NAME… image, values only in env, optional empty values omitted', () => {
    const r = buildServerConfigStrict(
      base({
        kind: 'docker',
        runtime: 'docker',
        package: 'ghcr.io/github/github-mcp-server:2.0.3',
        env: [
          { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, secret: true },
          { name: 'GITHUB_HOST', required: false, secret: false }
        ]
      }),
      { env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x', GITHUB_HOST: '' } }
    )
    expect(r.config).toEqual({
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:2.0.3'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }
    })
  })

  it('docker adds the version as a tag only when the image has none', () => {
    expect(buildServerConfigStrict(base({ kind: 'docker', package: 'mcp/time', version: '1.0' })).config).toMatchObject({ args: ['run', '-i', '--rm', 'mcp/time:1.0'] })
    expect(buildServerConfigStrict(base({ kind: 'docker', package: 'mcp/time:2', version: '1.0' })).config).toMatchObject({ args: ['run', '-i', '--rm', 'mcp/time:2'] })
  })

  it('nuget → dnx pkg@version --yes -- args', () => {
    const r = buildServerConfigStrict(base({ kind: 'nuget', package: 'Some.Mcp', version: '0.2.0', argsSpec: [{ name: 'root', required: false }] }), { args: { root: 'C:\\data' } })
    expect(r.config).toEqual({ type: 'stdio', command: 'dnx', args: ['Some.Mcp@0.2.0', '--yes', '--', 'C:\\data'] })
  })

  it('remote → {type, url, headers}', () => {
    const r = buildServerConfigStrict(
      base({ kind: 'remote', runtime: 'none', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', required: true, secret: true }] }),
      { headers: { Authorization: 'Bearer ghp_x' } }
    )
    expect(r.config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_x' } })
    expect(buildServerConfigStrict(base({ kind: 'remote', transport: 'sse', url: 'https://x.example/sse' })).config).toEqual({ type: 'sse', url: 'https://x.example/sse' })
  })

  it('remote URL and header placeholders are filled', () => {
    const r = buildServerConfigStrict(
      base({
        kind: 'remote',
        transport: 'http',
        url: 'https://{{API_HOST}}/mcp',
        env: [{ name: 'API_HOST', required: true, secret: false }, { name: 'SMITHERY_KEY', required: true, secret: true }],
        headers: [{ name: 'Authorization', required: false, secret: true, default: 'Bearer {{SMITHERY_KEY}}' }]
      }),
      { env: { API_HOST: 'api.eu.autorfp.ai', SMITHERY_KEY: 'sk-9' } }
    )
    expect(r.config).toEqual({ type: 'http', url: 'https://api.eu.autorfp.ai/mcp', headers: { Authorization: 'Bearer sk-9' } })
  })
})

describe('buildServerConfig — templates and arguments', () => {
  it('repeatable positional args expand to one argument per value (filesystem server)', () => {
    const option = base({ package: '@modelcontextprotocol/server-filesystem', argsSpec: [{ name: 'directories', required: true, repeatable: true, format: 'directory' }] })
    const r = buildServerConfigStrict(option, { args: { directories: ['C:\\Users\\me\\Desktop', 'D:\\Projects'] } })
    expect(r.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Desktop', 'D:\\Projects'] })
  })

  it('an element that is exactly {{arg:X}} expands per value; a flag pair repeats; a mixed element repeats', () => {
    const option = base({
      command: 'my-server',
      args: ['{{arg:dirs}}', '--include', '{{arg:globs}}', '--root={{arg:roots}}'],
      argsSpec: [
        { name: 'dirs', required: true, repeatable: true },
        { name: 'globs', required: false, repeatable: true },
        { name: 'roots', required: false, repeatable: true }
      ]
    })
    const r = buildServerConfigStrict(option, { args: { dirs: ['a', 'b'], globs: ['*.ts', '*.md'], roots: ['/x', '/y'] } })
    expect(r.config).toMatchObject({ command: 'my-server', args: ['a', 'b', '--include', '*.ts', '--include', '*.md', '--root=/x', '--root=/y'] })
  })

  it('optional empty values are omitted together with their flag', () => {
    const option = base({
      command: 'npx',
      args: ['-y', 'pkg', '--token', '{{API_TOKEN}}', '--port={{arg:port}}', '--verbose'],
      env: [{ name: 'API_TOKEN', required: false, secret: true }],
      argsSpec: [{ name: 'port', required: false }]
    })
    const r = buildServerConfigStrict(option, {})
    expect(r.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--verbose'] })
  })

  it('arg defaults and env defaults are used when nothing is typed', () => {
    const option = base({
      package: 'pkg',
      env: [{ name: 'LOG_LEVEL', required: false, secret: false, default: 'info' }],
      argsSpec: [{ name: 'mode', required: false, default: 'readonly' }]
    })
    expect(buildServerConfigStrict(option).config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', 'readonly'], env: { LOG_LEVEL: 'info' } })
  })

  it('extra args are appended and extra env vars are kept', () => {
    const r = buildServerConfigStrict(base({ package: 'pkg' }), { extraArgs: ['--debug', ''], env: { CUSTOM: '1', EMPTY: '' } })
    expect(r.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--debug'], env: { CUSTOM: '1' } })
  })

  it('a non-repeatable arg keeps only the first value', () => {
    const r = buildServerConfigStrict(base({ package: 'pkg', argsSpec: [{ name: 'one', required: true }] }), { args: { one: ['first', 'second'] } })
    expect(r.config).toMatchObject({ args: ['-y', 'pkg', 'first'] })
  })
})

describe('buildServerConfig — missing values and unsupported options', () => {
  const option = base({
    package: 'pkg',
    env: [{ name: 'API_KEY', required: true, secret: true }, { name: 'OPTIONAL', required: false, secret: false }],
    argsSpec: [{ name: 'directories', required: true, repeatable: true }]
  })

  it('lenient build lists every missing required value', () => {
    const r = buildServerConfig(option, { env: { API_KEY: '   ' } })
    expect(r.missing.sort()).toEqual(['API_KEY', 'directories'])
  })

  it('strict build throws a typed error listing them', () => {
    try {
      buildServerConfigStrict(option, {})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(MissingValuesError)
      expect((err as MissingValuesError).missing.sort()).toEqual(['API_KEY', 'directories'])
      expect((err as Error).message).toContain('API_KEY')
    }
  })

  it('an undeclared placeholder counts as a required value', () => {
    const r = buildServerConfig(base({ kind: 'remote', transport: 'http', url: 'https://{{TENANT}}.example.com/mcp' }))
    expect(r.missing).toEqual(['TENANT'])
  })

  it('options that need manual setup are rejected with a friendly message', () => {
    expect(() => buildServerConfigStrict(base({ kind: 'mcpb', package: 'https://x/y.mcpb' }))).toThrow(UnsupportedOptionError)
    expect(() => buildServerConfigStrict(base({ kind: 'manual' }))).toThrow(/manual setup|which package/)
    expect(() => buildServerConfigStrict(base({ kind: 'npm', package: 'pkg', transport: 'http' }))).toThrow(/web server/)
    expect(() => buildServerConfigStrict(base({ kind: 'remote', transport: 'http' }))).toThrow(/no server address/)
  })

  it('an explicit command template overrides the default (binary)', () => {
    const r = buildServerConfigStrict(base({ kind: 'binary', command: '{{arg:bin}}', args: ['serve'], argsSpec: [{ name: 'bin', required: true }] }), { args: { bin: '/opt/tool' } })
    expect(r.config).toEqual({ type: 'stdio', command: '/opt/tool', args: ['serve'] })
  })
})
