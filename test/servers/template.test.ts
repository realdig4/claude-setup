import { describe, expect, it } from 'vitest'
import type { InstallOption } from '@shared/types'
import { applyTemplate, buildServerConfigStrict } from '@core/servers/build'

const remote = (o: Partial<InstallOption>): InstallOption => ({
  id: 'remote',
  kind: 'remote',
  label: 'Remote',
  runtime: 'none',
  transport: 'http',
  url: 'https://api.example.com/mcp/',
  env: [],
  ...o
})

describe('value templates ("Bearer {{value}}")', () => {
  it('adds the prefix when the user typed only the token', () => {
    expect(applyTemplate({ template: 'Bearer {{value}}' }, 'ghp_abc')).toBe('Bearer ghp_abc')
  })

  it('keeps a value that already has the prefix (any case)', () => {
    expect(applyTemplate({ template: 'Bearer {{value}}' }, 'bearer ghp_abc')).toBe('bearer ghp_abc')
  })

  it('leaves values alone without a template', () => {
    expect(applyTemplate({}, 'plain')).toBe('plain')
    expect(applyTemplate({ template: 'no placeholder' }, 'plain')).toBe('plain')
  })

  it('remote servers get the templated Authorization header', () => {
    const r = buildServerConfigStrict(
      remote({ headers: [{ name: 'Authorization', required: true, secret: true, template: 'Bearer {{value}}' }] }),
      { headers: { Authorization: '  ghp_secret  ' } }
    )
    expect(r.config).toEqual({ type: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: 'Bearer ghp_secret' } })
  })
})
