import { describe, expect, it } from 'vitest'
import type { ExtensionItem } from '@shared/types'
import { parseInline, parseMarkdown } from '../../src/renderer/src/pages/extensions/markdown'
import {
  KIND_META,
  SCOPE_META,
  isOfficialSource,
  itemUrl,
  matchesExtension,
  parseMarketplaceSource,
  runsCommands,
  sourceLabel
} from '../../src/renderer/src/pages/extensions/meta'

const item = (over: Partial<ExtensionItem>): ExtensionItem => ({
  id: 'plugin:x@m',
  kind: 'plugin',
  name: 'x',
  description: '',
  source: 'claude-cli',
  installed: false,
  ...over
})

describe('pages-b/extensions: meta', () => {
  it('labels sources in plain words', () => {
    expect(sourceLabel(item({ marketplace: 'claude-plugins-official' }))).toBe('Official marketplace')
    expect(sourceLabel(item({ marketplace: 'anthropic-plugin-directory' }))).toBe('Plugin directory')
    expect(sourceLabel(item({ marketplace: 'wshobson' }))).toBe('wshobson')
    expect(sourceLabel(item({ source: 'marketplace', marketplace: undefined }))).toBe('Marketplace')
    expect(sourceLabel(item({ source: 'skills.sh' }))).toBe('skills.sh')
    expect(sourceLabel(item({ source: 'aitmpl' }))).toBe('aitmpl.com')
    expect(sourceLabel(item({ source: 'anthropic-skills' }))).toBe('Anthropic skills')
    expect(sourceLabel(item({ source: 'local' }))).toBe('On this computer')
  })

  it('recognises official sources', () => {
    expect(isOfficialSource(item({ marketplace: 'claude-plugins-official' }))).toBe(true)
    expect(isOfficialSource(item({ source: 'anthropic-skills' }))).toBe(true)
    expect(isOfficialSource(item({ source: 'marketplace', marketplace: 'anthropic-agent-skills' }))).toBe(true)
    expect(isOfficialSource(item({ marketplace: 'random' }))).toBe(false)
  })

  it('knows where each kind can be installed and which ones run commands', () => {
    expect(KIND_META.plugin.scopes).toEqual(['user', 'project', 'local'])
    expect(KIND_META.skill.scopes).toEqual(['user', 'project'])
    expect(SCOPE_META.local.simple).toMatch(/just me/)
    expect(runsCommands('hook')).toBe(true)
    expect(runsCommands('statusline')).toBe(true)
    expect(runsCommands('skill')).toBe(false)
  })

  it('filters installed items locally', () => {
    const a = item({ name: 'commit-commands', description: 'Git commit workflows', author: 'Anthropic', marketplace: 'claude-plugins-official' })
    expect(matchesExtension(a, 'git')).toBe(true)
    expect(matchesExtension(a, 'anthropic official')).toBe(true)
    expect(matchesExtension(a, 'python')).toBe(false)
  })

  it('validates marketplace sources', () => {
    expect(parseMarketplaceSource('anthropics/skills')).toEqual({ value: 'anthropics/skills' })
    expect(parseMarketplaceSource('https://github.com/obra/superpowers-marketplace.git')).toEqual({ value: 'obra/superpowers-marketplace' })
    expect(parseMarketplaceSource(' https://github.com/a/b/ ')).toEqual({ value: 'a/b' })
    expect(parseMarketplaceSource('https://example.com/marketplace.json')).toEqual({ value: 'https://example.com/marketplace.json' })
    expect(parseMarketplaceSource('git@github.com:a/b.git')).toEqual({ value: 'git@github.com:a/b.git' })
    expect('error' in parseMarketplaceSource('not a repo!')).toBe(true)
    expect('error' in parseMarketplaceSource('')).toBe(true)
  })

  it('builds item links only from safe values', () => {
    expect(itemUrl({ url: 'https://skills.sh/x' })).toBe('https://skills.sh/x')
    expect(itemUrl({ repo: 'obra/superpowers' })).toBe('https://github.com/obra/superpowers')
    expect(itemUrl({ url: 'javascript:alert(1)' })).toBeUndefined()
    expect(itemUrl({ repo: 'bad repo' })).toBeUndefined()
  })
})

describe('pages-b/extensions: markdown preview parser', () => {
  it('parses headings, lists, paragraphs and code', () => {
    const blocks = parseMarkdown(
      ['# Title', '', 'Some *nice* text', 'continues here.', '', '- one', '- `two`', '1. first', '2. second', '', '```', 'npm test', '```', '## Next'].join('\n')
    )
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'heading'])
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 })
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: false })
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true })
    expect(blocks[4]).toEqual({ type: 'code', text: 'npm test' })
    const paragraph = blocks[1]
    expect(paragraph?.type === 'paragraph' && paragraph.content.map((s) => s.type)).toEqual(['text', 'em', 'text'])
  })

  it('parses inline code, bold and links without HTML', () => {
    expect(parseInline('Run `npm test` **now** — see [docs](https://x.dev) <b>raw</b>')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'npm test' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'now' },
      { type: 'text', text: ' — see ' },
      { type: 'link', text: 'docs', href: 'https://x.dev' },
      { type: 'text', text: ' <b>raw</b>' }
    ])
  })
})
