import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  formatTokens,
  joinList,
  maskSecret,
  pluralize,
  truncateMiddle
} from '../../src/renderer/src/lib/format'

describe('renderer/format', () => {
  it('formats numbers', () => {
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(12.345)).toBe('12.3')
    expect(formatNumber(1.456, { decimals: 2 })).toBe('1.46')
    expect(formatNumber(2, { decimals: 2 })).toBe('2')
    expect(formatNumber(Number.NaN)).toBe('—')
    expect(formatNumber(undefined)).toBe('—')
  })

  it('formats compact numbers', () => {
    expect(formatCompact(950)).toBe('950')
    expect(formatCompact(12_345)).toBe('12.3K')
    expect(formatCompact(1_200_000)).toBe('1.2M')
    expect(formatCompact(null)).toBe('—')
  })

  it('formats context windows', () => {
    expect(formatTokens(262_144)).toBe('256K')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(131_072)).toBe('128K')
    expect(formatTokens(786_432)).toBe('768K')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(0)).toBe('—')
  })

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('formats durations', () => {
    expect(formatDuration(85)).toBe('85 ms')
    expect(formatDuration(1250)).toBe('1.3 s')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(7_500_000)).toBe('2h 5m')
  })

  it('formats relative time against a fixed "now"', () => {
    const now = new Date('2026-10-23T12:00:00Z').getTime()
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe('in 5 min')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(formatRelativeTime(now - 86_400_000, now)).toBe('yesterday')
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago')
    expect(formatRelativeTime('2026-03-04T12:00:00Z', now)).toMatch(/^Mar [34]$/)
    expect(formatRelativeTime('2024-03-04T12:00:00Z', now)).toMatch(/^Mar [34], 2024$/)
    expect(formatRelativeTime(null, now)).toBe('never')
    expect(formatRelativeTime('not a date', now)).toBe('unknown')
  })

  it('formats dates', () => {
    expect(formatDateTime('2026-10-23T21:41:00', { time: false })).toBe('Oct 23, 2026')
    expect(formatDateTime(undefined)).toBe('—')
  })

  it('pluralizes', () => {
    expect(pluralize(1, 'server')).toBe('1 server')
    expect(pluralize(3, 'server')).toBe('3 servers')
    expect(pluralize(2, 'entry')).toBe('2 entries')
    expect(pluralize(2, 'match')).toBe('2 matches')
    expect(pluralize(0, 'person', 'people')).toBe('0 people')
    expect(pluralize(5, 'app', undefined, false)).toBe('apps')
    expect(pluralize(1200, 'tool')).toBe('1,200 tools')
  })

  it('joins lists for prose', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['Claude Desktop'])).toBe('Claude Desktop')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(joinList(['a', 'b', 'c'], 'or')).toBe('a, b or c')
  })

  it('truncates in the middle', () => {
    const path = 'C:\\Users\\you\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json'
    const short = truncateMiddle(path, 40)
    expect(short).toHaveLength(40)
    expect(short).toContain('…')
    expect(short.startsWith('C:\\Users')).toBe(true)
    expect(short.endsWith('config.json')).toBe(true)
    expect(truncateMiddle('short', 40)).toBe('short')
  })

  it('masks secrets', () => {
    expect(maskSecret('ghp_1234567890abcdef')).toBe('ghp_••••cdef')
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-••••mnop')
    expect(maskSecret('abc')).toBe('••••')
    expect(maskSecret('')).toBe('')
  })
})
