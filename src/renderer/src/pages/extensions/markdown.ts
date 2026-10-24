/**
 * A tiny, safe Markdown subset parser for previews (CLAUDE.md templates): headings, paragraphs, bullet and numbered
 * lists, fenced code, and inline code / bold / italic / links. Produces plain data — the UI renders it as elements,
 * never as HTML. Pure (unit-tested in Node).
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string }

export type MdBlock =
  | { type: 'heading'; level: number; content: MdInline[] }
  | { type: 'paragraph'; content: MdInline[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'code'; text: string }

interface ListState {
  ordered: boolean
  items: MdInline[][]
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g

/** Inline spans of one line or paragraph. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) out.push({ type: 'text', text: text.slice(last, index) })
    const [token, code, strong, em, link] = match
    if (code) out.push({ type: 'code', text: code.slice(1, -1) })
    else if (strong) out.push({ type: 'strong', text: strong.slice(2, -2) })
    else if (em) out.push({ type: 'em', text: em.slice(1, -1) })
    else if (link) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link)
      if (m) out.push({ type: 'link', text: m[1] ?? '', href: m[2] ?? '' })
    }
    last = index + token.length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** Block structure of a Markdown document. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []
  let list: ListState | null = null
  // Read through a function so TypeScript doesn't narrow `list` across the closures below.
  const currentList = (): ListState | null => list

  const flushParagraph = (): void => {
    if (paragraph.length) blocks.push({ type: 'paragraph', content: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = (): void => {
    const current = currentList()
    if (current) blocks.push({ type: 'list', ordered: current.ordered, items: current.items })
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      flushParagraph()
      flushList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '')
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, content: parseInline((heading[2] ?? '').trim()) })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = !!numbered
      let current = currentList()
      if (!current || current.ordered !== ordered) {
        flushList()
        current = { ordered, items: [] }
        list = current
      }
      current.items.push(parseInline(((bullet ?? numbered)?.[1] ?? '').trim()))
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}
