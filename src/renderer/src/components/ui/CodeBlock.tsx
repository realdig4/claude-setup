import { useMemo, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { CopyButton } from './CopyButton'

export type CodeLanguage = 'json' | 'text' | 'shell'

export interface CodeBlockProps {
  /** A string, or any JSON-serializable value (pretty-printed as JSON). */
  code: unknown
  /** Highlighting mode (default: 'json' for objects, 'text' for strings). */
  language?: CodeLanguage
  /** Header label, e.g. a file name. */
  title?: ReactNode
  /** Max height before scrolling (px or CSS length, default 360). */
  maxHeight?: number | string
  /** Show the copy button (default true). */
  copy?: boolean
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean
  className?: string
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g

/** Tiny JSON highlighter (keys, strings, numbers, literals, punctuation). */
function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0
    if (index > last) out.push(text.slice(last, index))
    const [token, str, colon, literal, num, punct] = match
    if (str !== undefined && colon !== undefined) {
      out.push(
        <span key={i++} className="text-info-text">
          {str}
        </span>,
        <span key={i++} className="text-fg-subtle">
          {colon}
        </span>
      )
    } else if (str !== undefined) {
      out.push(
        <span key={i++} className="text-success-text">
          {str}
        </span>
      )
    } else if (literal !== undefined) {
      out.push(
        <span key={i++} className="text-accent-text">
          {literal}
        </span>
      )
    } else if (num !== undefined) {
      out.push(
        <span key={i++} className="text-warn-text">
          {num}
        </span>
      )
    } else if (punct !== undefined) {
      out.push(
        <span key={i++} className="text-fg-subtle">
          {punct}
        </span>
      )
    } else {
      out.push(token)
    }
    last = index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Shell: dim comments and the "$ " prompt. */
function highlightShell(text: string): ReactNode[] {
  return text.split('\n').flatMap((line, index, lines) => {
    const nodes: ReactNode[] = []
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) {
      nodes.push(
        <span key={`c${index}`} className="text-fg-subtle italic">
          {line}
        </span>
      )
    } else if (trimmed.startsWith('$ ')) {
      const pad = line.length - trimmed.length
      nodes.push(
        line.slice(0, pad),
        <span key={`p${index}`} className="text-fg-subtle select-none">
          ${' '}
        </span>,
        trimmed.slice(2)
      )
    } else {
      nodes.push(line)
    }
    if (index < lines.length - 1) nodes.push('\n')
    return nodes
  })
}

function toText(code: unknown): { text: string; isJson: boolean } {
  if (typeof code === 'string') return { text: code, isJson: false }
  try {
    return { text: JSON.stringify(code, null, 2) ?? String(code), isJson: true }
  } catch {
    return { text: String(code), isJson: false }
  }
}

/**
 * Read-only code/JSON viewer with syntax colors, scroll and a copy button.
 * @example <CodeBlock title="claude_desktop_config.json" code={preview.snippet} language="json" />
 * @example <CodeBlock code={{ mcpServers: { github: config } }} />
 */
export function CodeBlock({ code, language, title, maxHeight = 360, copy = true, wrap, className }: CodeBlockProps) {
  const { text, isJson } = useMemo(() => toText(code), [code])
  const lang: CodeLanguage = language ?? (isJson ? 'json' : 'text')
  const content = useMemo(
    () => (lang === 'json' ? highlightJson(text) : lang === 'shell' ? highlightShell(text) : [text]),
    [lang, text]
  )

  return (
    <figure className={cn('group/code relative overflow-hidden rounded-xl border border-line bg-surface-2/60', className)}>
      {title ? (
        <figcaption className="flex h-10 items-center justify-between gap-3 border-b border-line bg-surface-2/60 pr-1.5 pl-3.5">
          <span className="truncate font-mono text-xs text-fg-muted">{title}</span>
          {copy ? <CopyButton text={text} label="Copy to clipboard" /> : null}
        </figcaption>
      ) : null}
      <pre
        tabIndex={0}
        className={cn(
          'overflow-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.65] text-fg outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
        )}
        style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
      >
        <code>{content}</code>
      </pre>
      {!title && copy ? (
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100">
          <CopyButton text={text} label="Copy to clipboard" variant="outline" className="bg-surface/90 backdrop-blur" />
        </div>
      ) : null}
    </figure>
  )
}
