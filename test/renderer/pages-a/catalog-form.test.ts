import { describe, expect, it } from 'vitest'
import type { CatalogServer, InstallOption } from '@shared/types'
import {
  defaultOption,
  hasRemoteOption,
  isInstallable,
  optionNeedsKey,
  optionTarget,
  optionTitle,
  requiredInputCount,
  serverNeedsKey
} from '../../../src/renderer/src/pages/discover/lib/catalog'
import {
  formFields,
  headerValue,
  humanizeName,
  initialValues,
  maskSecrets,
  secretValues,
  toInstallValues,
  validateValues
} from '../../../src/renderer/src/pages/discover/lib/installForm'
import { markdownBlocks } from '../../../src/renderer/src/pages/discover/lib/markdown'

const npm = (extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'npm',
  kind: 'npm',
  label: 'Node.js (npx)',
  package: '@scope/server',
  runtime: 'node',
  transport: 'stdio',
  env: [],
  ...extra
})

const remote = (extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'remote',
  kind: 'remote',
  label: 'Hosted',
  runtime: 'none',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  env: [],
  ...extra
})

function server(install: InstallOption[]): CatalogServer {
  return { id: 'x', name: 'X', slug: 'x', description: '', categories: ['other'], tags: [], sources: ['seed'], install }
}

describe('pages-a/catalog', () => {
  it('picks the same default option as the core', () => {
    const manual: InstallOption = { ...npm(), id: 'manual', kind: 'manual', package: undefined }
    const mcpb: InstallOption = { ...npm(), id: 'mcpb', kind: 'mcpb' }
    expect(defaultOption(server([manual, npm()]))?.id).toBe('npm')
    expect(defaultOption(server([mcpb]))?.id).toBe('mcpb')
    expect(isInstallable(server([mcpb]))).toBe(false)
    expect(isInstallable(server([{ ...manual, command: 'my-server' }]))).toBe(true)
  })

  it('knows when a key is needed and when it runs online', () => {
    const keyed = npm({ env: [{ name: 'API_KEY', required: true, secret: true }] })
    const optional = remote({ headers: [{ name: 'X-Key', required: false, secret: true }] })
    expect(optionNeedsKey(keyed)).toBe(true)
    expect(optionNeedsKey(optional)).toBe(false)
    expect(serverNeedsKey(server([keyed]))).toBe(true)
    expect(serverNeedsKey(server([keyed, optional]))).toBe(false)
    expect(hasRemoteOption(server([keyed, optional]))).toBe(true)
    expect(requiredInputCount(keyed)).toBe(1)
    expect(requiredInputCount(npm({ env: [{ name: 'HOST', required: true, secret: false, default: 'localhost' }] }))).toBe(0)
  })

  it('describes options in plain words and in detail', () => {
    expect(optionTitle(remote())).toBe('Online — nothing to install')
    expect(optionTitle(npm())).toBe('On your computer (Node.js)')
    expect(optionTarget(npm({ version: '1.2.3' }))).toBe('@scope/server@1.2.3')
    expect(optionTarget(npm({ version: 'latest' }))).toBe('@scope/server')
    expect(optionTarget({ ...npm(), kind: 'docker', package: 'mcp/fetch', version: '2' })).toBe('mcp/fetch:2')
    expect(optionTarget(remote())).toBe('https://mcp.example.com/mcp')
  })
})

describe('pages-a/installForm', () => {
  it('humanizes setting names', () => {
    expect(humanizeName('BRAVE_API_KEY')).toBe('Brave API key')
    expect(humanizeName('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe('GitHub personal access token')
    expect(humanizeName('local-timezone')).toBe('Local timezone')
    expect(humanizeName('directories')).toBe('Folders')
    expect(humanizeName('db-path')).toBe('DB path')
    expect(humanizeName('projectRef')).toBe('Project ref')
    expect(humanizeName('API_URL')).toBe('API URL')
  })

  const option = npm({
    argsSpec: [
      { name: 'directories', required: true, repeatable: true, format: 'directory' },
      { name: 'mode', required: false }
    ],
    env: [
      { name: 'API_KEY', required: true, secret: true, helpUrl: 'https://example.com/keys' },
      { name: 'HOST', required: true, secret: false, default: '127.0.0.1' },
      { name: 'PORT', required: false, secret: false, format: 'number' },
      { name: 'READ_ONLY', required: false, secret: false, format: 'boolean', default: 'true' },
      { name: 'VERBOSE', required: false, secret: false, format: 'boolean' }
    ],
    headers: [{ name: 'Authorization', required: true, secret: true, placeholder: 'Bearer ghp_…' }]
  })

  it('generates fields with required ones first', () => {
    const fields = formFields(option)
    expect(fields.map((f) => f.key)).toEqual([
      'arg:directories',
      'env:API_KEY',
      'header:Authorization',
      'arg:mode',
      'env:HOST',
      'env:PORT',
      'env:READ_ONLY',
      'env:VERBOSE'
    ])
    const auth = fields.find((f) => f.name === 'Authorization')!
    expect(auth).toMatchObject({ label: 'Access token', bearer: true, placeholder: 'ghp_…', secret: true })
    expect(fields.find((f) => f.name === 'directories')).toMatchObject({ label: 'Folders', repeatable: true })
  })

  it('starts from defaults and validates', () => {
    const fields = formFields(option)
    const values = initialValues(fields)
    expect(values['env:HOST']).toBe('127.0.0.1')
    expect(values['arg:directories']).toEqual([])
    expect(values['env:READ_ONLY']).toBe('true')
    expect(values['env:VERBOSE']).toBe('')
    const errors = validateValues(fields, { ...values, 'env:PORT': 'abc' })
    expect(errors['arg:directories']).toBe('Add at least one folder.')
    expect(errors['env:API_KEY']).toBe('Paste your key to continue.')
    expect(errors['header:Authorization']).toBe('Paste your token to continue.')
    expect(errors['env:PORT']).toBe('Enter a number.')
    expect(errors['env:HOST']).toBeUndefined()
  })

  it('checks addresses', () => {
    const fields = formFields(npm({ env: [{ name: 'DATABASE_URI', required: true, secret: true, format: 'url' }] }))
    expect(validateValues(fields, { 'env:DATABASE_URI': 'localhost:5432' })['env:DATABASE_URI']).toMatch(/full address/)
    expect(validateValues(fields, { 'env:DATABASE_URI': 'postgresql://u:p@localhost/db' })).toEqual({})
  })

  it('converts values for the core', () => {
    const fields = formFields(option)
    const values = {
      ...initialValues(fields),
      'arg:directories': ['C:\\Docs', ' ', 'D:\\Work '],
      'env:API_KEY': '  sk-123  ',
      'header:Authorization': 'ghp_abc',
      'env:READ_ONLY': '',
      'env:VERBOSE': 'true'
    }
    expect(toInstallValues(fields, values, ['--debug', ' '])).toEqual({
      env: { API_KEY: 'sk-123', HOST: '127.0.0.1', READ_ONLY: 'false', VERBOSE: 'true' },
      headers: { Authorization: 'Bearer ghp_abc' },
      args: { directories: ['C:\\Docs', 'D:\\Work'] },
      extraArgs: ['--debug']
    })
    expect(toInstallValues(formFields(npm()), {})).toEqual({})
  })

  it('only adds Bearer when a bare token was pasted', () => {
    const auth = formFields(option).find((f) => f.name === 'Authorization')!
    expect(headerValue(auth, 'Bearer ghp_x')).toBe('Bearer ghp_x')
    expect(headerValue(auth, 'token ghp_x')).toBe('token ghp_x')
    expect(headerValue({ ...auth, bearer: false }, 'abc')).toBe('abc')
  })

  it('hides typed secrets in previews', () => {
    const fields = formFields(option)
    const secrets = secretValues(fields, { 'env:API_KEY': 'sk-secret-1234', 'header:Authorization': 'ghp_token9876' })
    expect(secrets).toEqual(expect.arrayContaining(['sk-secret-1234', 'ghp_token9876', 'Bearer ghp_token9876']))
    const snippet = JSON.stringify({ env: { API_KEY: 'sk-secret-1234' }, headers: { Authorization: 'Bearer ghp_token9876' } })
    const masked = maskSecrets(snippet, secrets, () => '•••')
    expect(masked).not.toContain('sk-secret-1234')
    expect(masked).not.toContain('ghp_token9876')
  })
})

describe('pages-a/markdown', () => {
  it('turns README markdown into safe text blocks', () => {
    const md = [
      '# Filesystem',
      '',
      'Secure **file** operations with [access control](https://x.y).',
      'Second line of the _same_ paragraph with snake_case_name.',
      '',
      '```bash',
      'npx -y something',
      '```',
      '',
      '- Read files',
      '- Write <b>files</b>',
      '',
      '| a | b |',
      '|---|---|',
      '',
      '## Empty heading at the end'
    ].join('\n')
    expect(markdownBlocks(md)).toEqual([
      { kind: 'heading', lines: ['Filesystem'] },
      { kind: 'paragraph', lines: ['Secure file operations with access control. Second line of the same paragraph with snake_case_name.'] },
      { kind: 'list', lines: ['Read files', 'Write files'] }
    ])
    expect(markdownBlocks('a\n\nb\n\nc', 2)).toHaveLength(2)
  })
})
