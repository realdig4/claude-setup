import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createMemorySecretStore, type SecretStore } from '@core/secrets'
import { runCli } from '../../src/cli/run'
import { makeFakeCore, sampleServer, type FakeCore } from './fakeCore'

interface Harness {
  code: number
  stdout: string
  stderr: string
}

const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

async function run(argv: string[], opts: { core?: FakeCore; secrets?: SecretStore; stdin?: string; tty?: boolean } = {}): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.isTTY = opts.tty ?? false
  if (opts.stdin !== undefined) stdin.end(opts.stdin)
  const core = opts.core ?? makeFakeCore()
  const code = await runCli(argv, {
    io: {
      stdout: {
        write: (s: string, cb?: (e?: Error | null) => void) => {
          out.push(s)
          cb?.()
          return true
        },
        isTTY: opts.tty ?? false,
        columns: 120
      },
      stderr: {
        write: (s: string) => {
          err.push(s)
          return true
        },
        isTTY: opts.tty ?? false
      },
      stdin,
      env: { NO_COLOR: '1' },
      platform: 'linux'
    },
    version: '1.2.3',
    createCore: async () => core,
    secrets: () => opts.secrets ?? createMemorySecretStore(),
    cwd: () => cwd
  })
  return { code, stdout: out.join(''), stderr: err.join('') }
}

describe('basics', () => {
  it('prints the version and help', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: '1.2.3\n' })
    const help = await run([])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: claude-setup')
    expect(help.stdout).toContain('install')
  })

  it('returns exit code 2 for usage errors', async () => {
    const r = await run(['bogus'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/unknown command 'bogus'/)
    const badTarget = await run(['install', 'x', '--target', 'notepad', '--yes'])
    expect(badTarget.code).toBe(2)
    expect(badTarget.stderr).toMatch(/Unknown app "notepad"/)
  })
})

describe('search / info / list', () => {
  it('search maps flags and prints JSON', async () => {
    const core = makeFakeCore()
    const r = await run(['search', 'git', 'hub', '--remote', '--no-key', '--limit', '5', '--json'], { core })
    expect(r.code).toBe(0)
    expect(core.catalog.search).toHaveBeenCalledWith({
      query: 'git hub',
      category: undefined,
      remoteOnly: true,
      noKeyRequired: true,
      source: undefined,
      sort: undefined,
      limit: 5
    })
    expect(JSON.parse(r.stdout).items[0].id).toBe(sampleServer.id)
  })

  it('search prints a readable list', async () => {
    const r = await run(['search', 'github'])
    expect(r.stdout).toContain('GitHub')
    expect(r.stdout).toContain(sampleServer.id)
    expect(r.stdout).toContain('official')
  })

  it('info shows install options and fails for unknown ids', async () => {
    const r = await run(['info', sampleServer.id])
    expect(r.stdout).toContain('GITHUB_TOKEN')
    expect(r.stdout).toContain('Install options')
    const core = makeFakeCore()
    core.catalog.search.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 5 })
    const missing = await run(['info', 'nope'], { core })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/No catalog server called "nope"/)
  })

  it('list prints a table without secret values', async () => {
    const r = await run(['list'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('NAME')
    expect(r.stdout).toContain('Claude Desktop')
    expect(r.stdout).toContain('GITHUB_TOKEN')
    expect(r.stdout).not.toContain('ghp_secret_value')
  })
})

describe('install / add / uninstall', () => {
  it('installs non-interactively with --yes, mapping targets and values', async () => {
    const core = makeFakeCore()
    const r = await run(['install', sampleServer.id, '-t', 'desktop,code', '--env', 'GITHUB_TOKEN=x', '--arg', 'path=/a', '--arg', 'path=/b', '--yes'], { core })
    expect(r.code).toBe(0)
    expect(core.servers.install).toHaveBeenCalledWith({
      catalogId: sampleServer.id,
      optionId: undefined,
      values: { env: { GITHUB_TOKEN: 'x' }, headers: {}, args: { path: ['/a', '/b'] } },
      name: undefined,
      targets: [{ target: 'claude-desktop' }, { target: 'claude-code' }],
      overwrite: undefined,
      test: undefined
    })
    expect(r.stdout).toContain('Added.')
    expect(r.stderr).toMatch(/claude-setup restart/)
  })

  it('uses the default apps from settings and the chosen scope', async () => {
    const core = makeFakeCore({ settings: { defaultTargets: [{ target: 'claude-code', scope: 'user' }] } })
    await run(['install', sampleServer.id, '--option', 'remote', '--scope', 'project', '--yes'], { core })
    expect(core.servers.install.mock.calls[0][0]).toMatchObject({ optionId: 'remote', targets: [{ target: 'claude-code', scope: 'project', projectPath: cwd }] })
  })

  it('refuses to change things without confirmation when it cannot ask', async () => {
    const core = makeFakeCore()
    const r = await run(['install', sampleServer.id, '-t', 'code'], { core })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/needs confirmation/)
    expect(r.stderr).toMatch(/--yes/)
    expect(core.servers.install).not.toHaveBeenCalled()
  })

  it('explains which flags to pass for missing values', async () => {
    const core = makeFakeCore()
    core.servers.preview.mockImplementationOnce(async (req) => ({
      name: 'github',
      config: { type: 'stdio', command: 'npx' },
      targets: req.targets.map((t) => ({ target: t, snippet: '', supported: true })),
      missingRuntimes: [],
      missingValues: ['GITHUB_TOKEN'],
      warnings: []
    }))
    const r = await run(['install', sampleServer.id, '-t', 'code', '--option', 'npm', '--yes'], { core })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--env GITHUB_TOKEN=…')
    expect(core.servers.install).not.toHaveBeenCalled()
  })

  it('suggests ids when the server is unknown', async () => {
    const r = await run(['install', 'gh', '-t', 'code', '--yes'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/No catalog server matches "gh"/)
    expect(r.stderr).toContain(`claude-setup install ${sampleServer.id}`)
  })

  it('adds a custom stdio server from the words after --', async () => {
    const core = makeFakeCore()
    const r = await run(['add', 'files', '-t', 'code', '-e', 'ROOT=/x', '--yes', '--', 'npx', '-y', '@scope/files', '--read-only'], { core })
    expect(r.code).toBe(0)
    expect(core.servers.install.mock.calls[0][0]).toMatchObject({
      name: 'files',
      config: { type: 'stdio', command: 'npx', args: ['-y', '@scope/files', '--read-only'], env: { ROOT: '/x' } },
      targets: [{ target: 'claude-code' }]
    })
  })

  it('adds a remote server and validates names and URLs', async () => {
    const core = makeFakeCore()
    await run(['add', 'docs', '--url', 'https://example.com/mcp', '-H', 'Authorization=Bearer t', '-t', 'code', '--yes'], { core })
    expect(core.servers.install.mock.calls[0][0].config).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } })
    expect((await run(['add', 'bad name', '--url', 'https://x.example', '--yes'])).code).toBe(2)
    expect((await run(['add', 'ok', '--url', 'ftp://x.example', '--yes'])).code).toBe(2)
    expect((await run(['add', 'ok', '--yes'])).code).toBe(2)
  })

  it('uninstalls from every app where it is installed, or only the chosen ones', async () => {
    const core = makeFakeCore()
    await run(['uninstall', 'github', '--yes'], { core })
    expect(core.servers.uninstall).toHaveBeenLastCalledWith('github', [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }])
    await run(['remove', 'github', '-t', 'desktop', '--yes'], { core })
    expect(core.servers.uninstall).toHaveBeenLastCalledWith('github', [{ target: 'claude-desktop' }])
    const missing = await run(['uninstall', 'nope', '--yes'], { core })
    expect(missing.code).toBe(1)
    const typo = await run(['uninstall', 'git-hub', '--yes'], { core })
    expect(typo.code).toBe(1)
    expect(typo.stderr).toContain('Did you mean: github?')
  })

  it('tests an installed server and reports failures with exit code 1', async () => {
    const core = makeFakeCore()
    const ok = await run(['test', 'github', '-t', 'code'], { core })
    expect(ok.code).toBe(0)
    expect(core.servers.testInstalled).toHaveBeenCalledWith('github', { target: 'claude-code', scope: 'user' })
    core.servers.testInstalled.mockResolvedValueOnce({ ok: false, kind: 'timeout', ms: 30000, tools: [], error: 'Timed out' })
    const bad = await run(['test', 'github', '-t', 'code'], { core })
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/failed \(timeout\)/)
  })
})

describe('models', () => {
  it('use applies the profile to Claude Code (VS Code not installed) and shows the caveat', async () => {
    const core = makeFakeCore()
    const r = await run(['models', 'use', 'Kimi'], { core })
    expect(r.code).toBe(0)
    expect(core.models.apply).toHaveBeenCalledWith({ profileId: 'kimi-1', targets: ['claude-code'] })
    expect(r.stderr).toMatch(/doesn't support routing Claude Code to non-Claude models/)
    expect((await run(['models', 'use', 'nope'], { core })).code).toBe(1)
  })

  it('reset defaults to both targets; --target narrows it', async () => {
    const core = makeFakeCore()
    await run(['models', 'reset'], { core })
    expect(core.models.reset).toHaveBeenLastCalledWith(['claude-code', 'vscode'])
    await run(['models', 'reset', '-t', 'code'], { core })
    expect(core.models.reset).toHaveBeenLastCalledWith(['claude-code'])
  })

  it('add works non-interactively with --key-stdin and fills every model slot', async () => {
    const core = makeFakeCore()
    const r = await run(['models', 'add', '--provider', 'kimi', '--key-stdin', '--use', '--yes', '--json'], { core, stdin: 'sk-test-key\n' })
    expect(r.code).toBe(0)
    expect(core.models.testConnection).toHaveBeenCalledWith({ providerId: 'kimi', regionId: 'global', baseUrl: undefined, apiKey: 'sk-test-key', model: 'kimi-k3' })
    expect(core.models.saveProfile).toHaveBeenCalledWith({
      name: 'Kimi',
      providerId: 'kimi',
      regionId: 'global',
      baseUrl: undefined,
      apiKey: 'sk-test-key',
      models: { main: 'kimi-k3', haiku: 'kimi-k2.7-code', opus: 'kimi-k3', sonnet: 'kimi-k3', fable: 'kimi-k3', subagent: 'kimi-k3' }
    })
    expect(core.models.apply).toHaveBeenCalled()
    expect(JSON.parse(r.stdout).saved).toBe(true)
  })

  it('add without a key in a non-interactive shell explains --key-stdin', async () => {
    const r = await run(['models', 'add', '--provider', 'kimi', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--key-stdin/)
  })
})

describe('doctor', () => {
  it('exits 1 when problems remain', async () => {
    const r = await run(['doctor'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('Config file has an error')
    expect(r.stdout).toContain('Repair the config file')
  })

  it('--fix --yes applies automatic fixes and re-checks', async () => {
    const core = makeFakeCore()
    const r = await run(['doctor', '--fix', '--yes'], { core })
    expect(core.doctor.fix).toHaveBeenCalledWith('repair-desktop')
    expect(core.doctor.run).toHaveBeenCalledTimes(2)
    expect(r.stdout).toContain('Repaired.')
  })
})

describe('secret', () => {
  it('get prints only the secret (no newline when piped)', async () => {
    const secrets = createMemorySecretStore()
    await secrets.set('profile:kimi-1', 'sk-123')
    const r = await run(['secret', 'get', 'profile:kimi-1'], { secrets })
    expect(r).toMatchObject({ code: 0, stdout: 'sk-123' })
    const missing = await run(['secret', 'get', 'profile:none'], { secrets })
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
  })

  it('set reads the value from stdin; delete removes it', async () => {
    const secrets = createMemorySecretStore()
    const r = await run(['secret', 'set', 'smithery'], { secrets, stdin: 'abc-def\n' })
    expect(r.code).toBe(0)
    expect(await secrets.get('smithery')).toBe('abc-def')
    await run(['secret', 'delete', 'smithery'], { secrets })
    expect(await secrets.has('smithery')).toBe(false)
    expect((await run(['secret', 'get', 'bad ref!'], { secrets })).code).toBe(2)
  })
})

describe('mcp self-registration, proxy, ext, backups, refresh', () => {
  it('mcp register defaults to the installed Claude apps', async () => {
    const core = makeFakeCore()
    const r = await run(['mcp', 'register'], { core })
    expect(r.code).toBe(0)
    expect(core.self.registerMcp).toHaveBeenCalledWith([{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }])
    await run(['mcp', 'register', '-t', 'cursor'], { core })
    expect(core.self.registerMcp).toHaveBeenLastCalledWith([{ target: 'cursor' }])
  })

  it('mcp status and unregister', async () => {
    const core = makeFakeCore()
    const r = await run(['mcp', 'status'], { core })
    expect(r.stdout).toContain('Claude Code')
    await run(['mcp', 'unregister', '-t', 'code'], { core })
    expect(core.self.unregisterMcp).toHaveBeenCalledWith([{ target: 'claude-code' }])
  })

  it('proxy status, ext search, backups restore, refresh', async () => {
    const core = makeFakeCore()
    expect(JSON.parse((await run(['proxy', 'status', '--json'], { core })).stdout)).toMatchObject({ running: false })
    await run(['ext', 'search', 'x', '--kind', 'plugins'], { core })
    expect(core.extensions.search).toHaveBeenCalledWith({ query: 'x', kind: 'plugin', source: undefined, limit: 20 })
    await run(['backups', 'restore', '20261023-120000-abcd', '--yes'], { core })
    expect(core.backups.restore).toHaveBeenCalledWith('20261023-120000-abcd')
    expect((await run(['backups', 'restore', 'nope', '--yes'], { core })).code).toBe(1)
    const refreshed = await run(['refresh'], { core })
    expect(core.catalog.refresh).toHaveBeenCalledWith({ force: true })
    expect(refreshed.stdout).toContain('rate limited')
  })

  it('disposes the core after every command', async () => {
    const core = makeFakeCore()
    await run(['targets'], { core })
    expect(core.dispose).toHaveBeenCalled()
  })
})
