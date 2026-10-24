/**
 * Turn registry README excerpts (markdown, sometimes with HTML) into plain paragraphs that can be shown
 * safely as text — no HTML is ever rendered. Pure TypeScript (unit-tested in Node).
 */

export interface TextBlock {
  kind: 'paragraph' | 'list' | 'heading'
  /** Paragraph or heading text (one line), or the list items. */
  lines: string[]
}

function inline(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // reference links
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,:;!?])/g, '$1$2') // italics (not snake_case)
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split markdown into readable blocks (headings, paragraphs and bullet/numbered lists); code fences, tables
 * and rules are dropped. Trailing headings without content are removed. At most `maxBlocks` blocks are returned.
 */
export function markdownBlocks(markdown: string, maxBlocks = 8): TextBlock[] {
  const blocks: TextBlock[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let inFence = false

  const flushParagraph = (): void => {
    const text = inline(paragraph.join(' '))
    if (text) blocks.push({ kind: 'paragraph', lines: [text] })
    paragraph = []
  }
  const flushList = (): void => {
    const items = list.map(inline).filter(Boolean)
    if (items.length) blocks.push({ kind: 'list', lines: items })
    list = []
  }

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (/^(```|~~~)/.test(line)) {
      flushParagraph()
      flushList()
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line) {
      flushParagraph()
      flushList()
      continue
    }
    if (/^\|.*\|$/.test(line) || /^[-:| ]{3,}$/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      list.push(bullet[1] ?? '')
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const text = inline(heading[1] ?? '')
      if (text) blocks.push({ kind: 'heading', lines: [text] })
      continue
    }
    if (list.length) flushList()
    paragraph.push(line.replace(/^>\s?/, ''))
  }
  flushParagraph()
  flushList()
  const out = blocks.slice(0, maxBlocks)
  while (out.length && out[out.length - 1]?.kind === 'heading') out.pop()
  return out
}
