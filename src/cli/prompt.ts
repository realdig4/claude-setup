/**
 * Interactive prompts on stdin/stderr: text, hidden secrets, yes/no and numbered choices.
 * Only used when stdin and stderr are terminals; otherwise callers get a CliError telling the
 * user which flag to pass instead.
 */
import { createInterface } from 'node:readline'
import { CliError, PromptCancelled } from './errors'
import type { CliIo, Output } from './output'

/** One option of Prompter.select(). */
export interface Choice<T> {
  label: string
  value: T
  hint?: string
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z~]|\x1b[O][A-Za-z]/g

/** Asks questions on the terminal. */
export class Prompter {
  constructor(
    private readonly io: CliIo,
    private readonly out: Output
  ) {}

  /** Prompts are possible (both stdin and stderr are terminals). */
  get interactive(): boolean {
    return !!this.io.stdin.isTTY && !!this.io.stderr.isTTY
  }

  private requireInteractive(what: string, flagHint?: string): void {
    if (!this.interactive) throw new CliError(`${what} is needed, but this terminal can't ask for it.`, 2, flagHint)
  }

  private ask(query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: this.io.stdin, output: this.io.stderr as NodeJS.WritableStream, terminal: true })
      let settled = false
      rl.on('SIGINT', () => {
        settled = true
        rl.close()
        reject(new PromptCancelled())
      })
      rl.on('close', () => {
        if (!settled) reject(new PromptCancelled())
      })
      rl.question(query, (answer) => {
        settled = true
        rl.close()
        resolve(answer)
      })
    })
  }

  /** Free text with an optional default and validation (re-asks until valid). */
  async text(question: string, opts: { default?: string; validate?: (v: string) => string | undefined; flagHint?: string } = {}): Promise<string> {
    this.requireInteractive(question.replace(/[?:]\s*$/, ''), opts.flagHint)
    const suffix = opts.default ? ` ${this.out.c.dim(`(${opts.default})`)}` : ''
    for (;;) {
      const answer = (await this.ask(`${this.out.c.cyan('?')} ${question}${suffix} `)).trim()
      const value = answer || opts.default || ''
      const problem = opts.validate?.(value)
      if (!problem) return value
      this.out.warn(problem)
    }
  }

  /** Hidden input (API keys, tokens). Nothing is echoed. */
  async secret(question: string, opts: { flagHint?: string; allowEmpty?: boolean } = {}): Promise<string> {
    this.requireInteractive(question.replace(/[?:]\s*$/, ''), opts.flagHint)
    const stdin = this.io.stdin
    if (typeof stdin.setRawMode !== 'function') {
      this.out.warn('This terminal cannot hide what you type; your input will be visible.')
      return this.text(question)
    }
    for (;;) {
      const value = (await this.readHidden(`${this.out.c.cyan('?')} ${question} ${this.out.c.dim('(hidden)')} `)).trim()
      if (value || opts.allowEmpty) return value
      this.out.warn('Nothing was entered. Paste or type the value, then press Enter.')
    }
  }

  private readHidden(query: string): Promise<string> {
    const stdin = this.io.stdin
    return new Promise((resolve, reject) => {
      let value = ''
      this.io.stderr.write(query)
      const finish = (): void => {
        stdin.removeListener('data', onData)
        stdin.setRawMode?.(false)
        stdin.pause()
        this.io.stderr.write('\n')
      }
      const onData = (chunk: Buffer | string): void => {
        const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).replace(ESCAPES, '')
        for (const ch of Array.from(text)) {
          if (ch === '\r' || ch === '\n') {
            finish()
            resolve(value)
            return
          }
          if (ch === '\u0003') {
            finish()
            reject(new PromptCancelled())
            return
          }
          if (ch === '\u0004') {
            if (!value) {
              finish()
              reject(new PromptCancelled())
              return
            }
            continue
          }
          if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('')
          else if (ch === '\u0015') value = ''
          else if (ch >= ' ') value += ch
        }
      }
      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.on('data', onData)
    })
  }

  /** Yes/no question. */
  async confirm(question: string, defaultYes = true, flagHint = 'Add --yes to confirm without a prompt.'): Promise<boolean> {
    this.requireInteractive('A confirmation', flagHint)
    const choices = defaultYes ? 'Y/n' : 'y/N'
    for (;;) {
      const answer = (await this.ask(`${this.out.c.cyan('?')} ${question} ${this.out.c.dim(`(${choices})`)} `)).trim().toLowerCase()
      if (!answer) return defaultYes
      if (['y', 'yes', 'j', 'ja', 'o', 'oui', 's', 'si', 'sí'].includes(answer)) return true
      if (['n', 'no', 'nein', 'non'].includes(answer)) return false
      this.out.warn('Please answer y (yes) or n (no).')
    }
  }

  /** Numbered list; returns the chosen value. */
  async select<T>(question: string, choices: Array<Choice<T>>, defaultIndex = 0, flagHint?: string): Promise<T> {
    if (!choices.length) throw new CliError('There is nothing to choose from.')
    this.requireInteractive(question.replace(/[?:]\s*$/, ''), flagHint)
    this.io.stderr.write(`${this.out.c.cyan('?')} ${question}\n`)
    const width = String(choices.length).length
    choices.forEach((choice, i) => {
      const num = String(i + 1).padStart(width)
      this.io.stderr.write(`  ${this.out.c.bold(num)}. ${choice.label}${choice.hint ? `  ${this.out.c.dim(choice.hint)}` : ''}\n`)
    })
    for (;;) {
      const answer = (await this.ask(`  Choose 1-${choices.length} ${this.out.c.dim(`(${defaultIndex + 1})`)}: `)).trim()
      if (!answer) return choices[defaultIndex].value
      const n = Number(answer)
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value
      const byLabel = choices.find((c) => c.label.toLowerCase() === answer.toLowerCase())
      if (byLabel) return byLabel.value
      this.out.warn(`Type a number from 1 to ${choices.length}.`)
    }
  }
}
