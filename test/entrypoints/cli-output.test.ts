import { describe, expect, it } from 'vitest'
import { Output, fitText, makeSymbols, shouldUseColor, stripAnsi, supportsUnicode, visibleLength, type CliIo } from '../../src/cli/output'
import { PassThrough } from 'node:stream'

function io(opts: { tty?: boolean; columns?: number; env?: Record<string, string> } = {}): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: { write: (s: string) => void out.push(s), isTTY: opts.tty, columns: opts.columns },
      stderr: { write: (s: string) => void err.push(s), isTTY: opts.tty },
      stdin: new PassThrough(),
      env: opts.env ?? {},
      platform: 'linux'
    }
  }
}

describe('colour and symbol detection', () => {
  it('honours NO_COLOR, FORCE_COLOR, dumb terminals and TTY', () => {
    expect(shouldUseColor({ write: () => true, isTTY: true }, {})).toBe(true)
    expect(shouldUseColor({ write: () => true, isTTY: false }, {})).toBe(false)
    expect(shouldUseColor({ write: () => true, isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(shouldUseColor({ write: () => true, isTTY: true }, { NO_COLOR: '' })).toBe(true)
    expect(shouldUseColor({ write: () => true, isTTY: false }, { FORCE_COLOR: '1' })).toBe(true)
    expect(shouldUseColor({ write: () => true, isTTY: true }, { FORCE_COLOR: '0' })).toBe(false)
    expect(shouldUseColor({ write: () => true, isTTY: true }, { TERM: 'dumb' })).toBe(false)
  })

  it('uses ASCII-ish symbols in the classic Windows console', () => {
    expect(supportsUnicode({}, 'win32')).toBe(false)
    expect(supportsUnicode({ WT_SESSION: 'x' }, 'win32')).toBe(true)
    expect(supportsUnicode({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true)
    expect(supportsUnicode({}, 'darwin')).toBe(true)
    expect(makeSymbols(false).ok).toBe('√')
  })
})

describe('text helpers', () => {
  it('measures and cuts text without counting colour codes', () => {
    const red = '\x1b[31mhello\x1b[39m'
    expect(visibleLength(red)).toBe(5)
    expect(stripAnsi(red)).toBe('hello')
    expect(fitText('abcdefgh', 5)).toBe('abcd…')
    expect(fitText(red, 10)).toBe(red)
  })
})

describe('Output', () => {
  it('fits tables into the terminal width by shrinking the flex column', () => {
    const h = io({ columns: 40 })
    const out = new Output(h.io)
    out.table(['NAME', 'DESCRIPTION'], [['short', 'x'.repeat(100)]])
    const lines = h.out.join('').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40)
    expect(lines[1]).toContain('…')
  })

  it('suppresses human output in JSON mode but keeps JSON and errors', () => {
    const h = io()
    const out = new Output(h.io)
    out.configure({ json: true })
    out.line('hidden')
    out.success('hidden too')
    out.printJson({ a: 1 })
    out.error('visible problem')
    expect(h.out.join('')).toBe('{\n  "a": 1\n}\n')
    expect(h.err.join('')).toContain('visible problem')
  })

  it('spinners are silent when stderr is not a terminal', async () => {
    const h = io({ tty: false })
    const out = new Output(h.io)
    const value = await out.withSpinner('Working…', async () => 42)
    expect(value).toBe(42)
    expect(h.err.join('')).toBe('')
  })

  it('spinners always stop, even when the task fails', async () => {
    const h = io({ tty: true })
    const out = new Output(h.io)
    await expect(out.withSpinner('Working…', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const written = h.err.join('')
    expect(written).toContain('\x1b[?25l')
    expect(written.endsWith('\x1b[?25h')).toBe(true)
  })
})
