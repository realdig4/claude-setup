/**
 * Terminal output for the CLI: colours (respecting NO_COLOR / FORCE_COLOR / non-TTY), symbols with
 * ASCII fallbacks for old Windows consoles, tables, spinners and JSON mode.
 * Results go to stdout; spinners, prompts, warnings and errors go to stderr.
 */

export interface WritableLike {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean | void
  isTTY?: boolean
  columns?: number
}

/** The parts of stdin the CLI uses. */
export interface ReadableLike extends NodeJS.ReadableStream {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

/** Streams and environment of one CLI invocation. */
export interface CliIo {
  stdout: WritableLike
  stderr: WritableLike
  stdin: ReadableLike
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}

/** Matches ANSI escape sequences. */
export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Remove ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** Printable width (code points, ANSI codes ignored). */
export function visibleLength(text: string): number {
  return Array.from(stripAnsi(text)).length
}

/** Cut to `max` visible characters with an ellipsis (colours are dropped when cutting). */
export function fitText(text: string, max: number): string {
  if (visibleLength(text) <= max) return text
  const plain = Array.from(stripAnsi(text))
  if (max <= 1) return plain.slice(0, Math.max(0, max)).join('')
  return plain.slice(0, max - 1).join('') + '…'
}

/** Pad to a visible width (ANSI-aware). */
export function padEnd(text: string, width: number): string {
  const len = visibleLength(text)
  return len >= width ? text : text + ' '.repeat(width - len)
}

/** NO_COLOR (any non-empty value) disables colour; FORCE_COLOR forces it; otherwise only on a TTY. */
export function shouldUseColor(stream: WritableLike, env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  if (env.TERM === 'dumb') return false
  return !!stream.isTTY
}

/** Unicode symbols render in modern terminals; the classic Windows console needs ASCII-ish ones. */
export function supportsUnicode(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return env.TERM !== 'linux'
  return !!(
    env.WT_SESSION ||
    env.TERMINUS_SUBLIME ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  )
}

type Paint = (text: string) => string

/** Colour helpers (identity functions when colour is off). */
export interface Colors {
  bold: Paint
  dim: Paint
  red: Paint
  green: Paint
  yellow: Paint
  blue: Paint
  magenta: Paint
  cyan: Paint
  gray: Paint
}

/** Colour helpers, enabled or not. */
export function makeColors(enabled: boolean): Colors {
  const wrap = (open: number, close: number): Paint => (enabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => text)
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39)
  }
}

/** Status symbols and spinner frames. */
export interface Symbols {
  ok: string
  fail: string
  warn: string
  info: string
  bullet: string
  arrow: string
  dash: string
  spinner: string[]
}

/** Unicode symbols, or ASCII-ish fallbacks for legacy consoles. */
export function makeSymbols(unicode: boolean): Symbols {
  return unicode
    ? { ok: '✔', fail: '✘', warn: '⚠', info: 'ℹ', bullet: '•', arrow: '→', dash: '—', spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
    : { ok: '√', fail: '×', warn: '!', info: 'i', bullet: '*', arrow: '->', dash: '-', spinner: ['-', '\\', '|', '/'] }
}

/** Progress spinner handle. */
export interface Spinner {
  update(text: string): void
  /** Stop and print a success line (when text is given). */
  succeed(text?: string): void
  /** Stop and print a failure line (when text is given). */
  fail(text?: string): void
  /** Stop silently. */
  stop(): void
}

/** Layout options for Output.table(). */
export interface TableOptions {
  /** Column that shrinks when the table is too wide (default: last). */
  flex?: number
  /** Indent every line by this many spaces. */
  indent?: number
}

/** All CLI output goes through here (colours, JSON mode, tables, spinners). */
export class Output {
  json = false
  verbose = false
  c: Colors
  sym: Symbols
  private colorEnabled: boolean

  constructor(private readonly io: CliIo) {
    this.colorEnabled = shouldUseColor(io.stdout, io.env)
    this.c = makeColors(this.colorEnabled)
    this.sym = makeSymbols(supportsUnicode(io.env, io.platform))
  }

  /** Apply global flags (--json, --no-color, --verbose). */
  configure(opts: { json?: boolean; color?: boolean; verbose?: boolean }): void {
    if (opts.json !== undefined) this.json = opts.json
    if (opts.verbose !== undefined) this.verbose = opts.verbose
    this.colorEnabled = !this.json && opts.color !== false && shouldUseColor(this.io.stdout, this.io.env)
    this.c = makeColors(this.colorEnabled)
  }

  /** Terminal width for tables (wide default when piped). */
  get width(): number {
    return this.io.stdout.columns && this.io.stdout.columns > 20 ? this.io.stdout.columns : 200
  }

  /** A line of normal output (suppressed in --json mode). */
  line(text = ''): void {
    if (!this.json) this.io.stdout.write(text + '\n')
  }

  /** Raw text to stdout, always (used by `secret get`). */
  raw(text: string): void {
    this.io.stdout.write(text)
  }

  /** JSON result to stdout. */
  printJson(value: unknown): void {
    this.io.stdout.write(JSON.stringify(value, null, 2) + '\n')
  }

  success(text: string): void {
    this.line(`${this.c.green(this.sym.ok)} ${text}`)
  }

  info(text: string): void {
    this.line(`${this.c.cyan(this.sym.info)} ${text}`)
  }

  /** Dimmed follow-up line ("next step" hints). */
  hint(text: string): void {
    if (!this.json) this.io.stderr.write(`  ${this.c.dim(text)}\n`)
  }

  warn(text: string): void {
    this.io.stderr.write(`${this.c.yellow(this.sym.warn)} ${text}\n`)
  }

  error(text: string): void {
    this.io.stderr.write(`${this.c.red(this.sym.fail)} ${text}\n`)
  }

  heading(text: string): void {
    this.line(this.c.bold(text))
  }

  /** "Label: value" lines with aligned values. */
  pairs(rows: Array<[string, string | undefined]>, indent = 2): void {
    const shown = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '')
    const width = Math.max(0, ...shown.map(([k]) => visibleLength(k))) + 1
    for (const [k, v] of shown) this.line(`${' '.repeat(indent)}${this.c.dim(padEnd(k + ':', width))} ${v}`)
  }

  /** Render rows as aligned columns, shrinking the flex column to fit the terminal. */
  table(head: string[], rows: string[][], opts: TableOptions = {}): void {
    if (this.json) return
    const indent = opts.indent ?? 0
    const cols = head.length
    const flex = Math.min(opts.flex ?? cols - 1, cols - 1)
    const widths = head.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))))
    const gap = 2
    const total = indent + widths.reduce((a, b) => a + b, 0) + gap * (cols - 1)
    if (total > this.width) widths[flex] = Math.max(8, widths[flex] - (total - this.width))
    const render = (cells: string[], paint?: Paint): string =>
      ' '.repeat(indent) +
      cells
        .map((cell, i) => {
          const fitted = fitText(cell ?? '', widths[i])
          const painted = paint ? paint(stripAnsi(fitted)) : fitted
          return i === cols - 1 ? painted : padEnd(painted, widths[i])
        })
        .join(' '.repeat(gap))
        .trimEnd()
    this.line(render(head, (t) => this.c.bold(this.c.dim(t))))
    for (const row of rows) this.line(render(row))
  }

  /** Animated spinner on stderr (TTY only); a no-op otherwise. */
  spinner(text: string): Spinner {
    const stream = this.io.stderr
    const animate = !this.json && !!stream.isTTY
    let current = text
    let frame = 0
    let timer: NodeJS.Timeout | undefined
    const clear = (): void => {
      if (animate) stream.write('\r\x1b[2K')
    }
    const draw = (): void => {
      stream.write(`\r\x1b[2K${this.c.cyan(this.sym.spinner[frame % this.sym.spinner.length])} ${current}`)
      frame++
    }
    if (animate) {
      stream.write('\x1b[?25l')
      draw()
      timer = setInterval(draw, 80)
    }
    const stop = (): void => {
      if (timer) clearInterval(timer)
      timer = undefined
      clear()
      if (animate) stream.write('\x1b[?25h')
    }
    return {
      update: (t) => {
        current = t
      },
      succeed: (t) => {
        stop()
        if (t) this.success(t)
      },
      fail: (t) => {
        stop()
        if (t) this.error(t)
      },
      stop
    }
  }

  /** Run `task` with a spinner; the spinner always stops, even when the task throws. */
  async withSpinner<T>(text: string, task: (spinner: Spinner) => Promise<T>): Promise<T> {
    const spinner = this.spinner(text)
    try {
      return await task(spinner)
    } finally {
      spinner.stop()
    }
  }
}
