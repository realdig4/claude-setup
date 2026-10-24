import { describe, expect, it } from 'vitest'
import {
  brandPalette,
  contrastRatio,
  hashString,
  initials,
  monogramPalette,
  parseHex,
  readableTextColor,
  relativeLuminance
} from '../../src/renderer/src/lib/color'

describe('renderer/color', () => {
  it('hashes deterministically', () => {
    expect(hashString('github')).toBe(hashString('github'))
    expect(hashString('github')).not.toBe(hashString('gitlab'))
    expect(hashString('')).toBe(0x811c9dc5)
  })

  it('derives friendly initials', () => {
    expect(initials('brave-search')).toBe('BS')
    expect(initials('Model Context Protocol')).toBe('MC')
    expect(initials('GitHub')).toBe('GH')
    expect(initials('notion')).toBe('N')
    expect(initials('@upstash/context7')).toBe('UC')
    expect(initials('42crunch')).toBe('4')
    expect(initials('  ')).toBe('?')
    expect(initials('Brave Search', 1)).toBe('B')
  })

  it('generates stable monogram palettes', () => {
    const a = monogramPalette('io.github.github/github-mcp-server')
    expect(a).toEqual(monogramPalette('io.github.github/github-mcp-server'))
    expect(a.background).toMatch(/^linear-gradient\(/)
    expect(a.color).toBe('#ffffff')
  })

  it('parses hex colors', () => {
    expect(parseHex('#D97757')).toEqual({ r: 217, g: 119, b: 87 })
    expect(parseHex('fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('nope')).toBeNull()
  })

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBe(1)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
    expect(contrastRatio('#xyz', '#fff')).toBeNull()
  })

  it('picks readable text for brand colors', () => {
    expect(readableTextColor('#16191E')).toBe('#ffffff')
    expect(readableTextColor('#F5D90A')).toBe('#1f1a17')
    expect(brandPalette('#4D6BFE')).toEqual({ background: '#4D6BFE', color: '#ffffff' })
    // Not a hex color → falls back to a generated palette.
    expect(brandPalette('teal').background).toMatch(/^linear-gradient\(/)
  })
})
