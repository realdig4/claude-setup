import { useMemo } from 'react'
import { ExternalLink } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { parseMarkdown, type MdInline } from './markdown'

function Inline({ spans }: { spans: MdInline[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.type) {
          case 'code':
            return (
              <code key={i} className="rounded bg-surface-3/70 px-1 py-px font-mono text-[0.88em] text-fg">
                {span.text}
              </code>
            )
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-fg">
                {span.text}
              </strong>
            )
          case 'em':
            return <em key={i}>{span.text}</em>
          case 'link':
            return /^https?:\/\//.test(span.href) ? (
              <ExternalLink key={i} href={span.href} showIcon={false}>
                {span.text}
              </ExternalLink>
            ) : (
              <span key={i} className="text-accent-text">
                {span.text}
              </span>
            )
          default:
            return <span key={i}>{span.text}</span>
        }
      })}
    </>
  )
}

const HEADING_CLASSES = [
  '',
  'text-lg font-semibold',
  'text-base font-semibold',
  'text-[15px] font-semibold',
  'text-sm font-semibold',
  'text-sm font-semibold',
  'text-sm font-semibold'
]

/** Renders a small, safe Markdown subset (no HTML) — used to preview CLAUDE.md templates. */
export function MarkdownPreview({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={cn('flex flex-col gap-3 text-sm leading-6 text-fg-muted', className)}>
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const level = Math.min(Math.max(block.level, 1), 6)
          return (
            <p
              key={i}
              role="heading"
              aria-level={Math.min(level + 3, 6)}
              className={cn('tracking-[-0.01em] text-fg', HEADING_CLASSES[level], i > 0 && 'pt-1')}
            >
              <Inline spans={block.content} />
            </p>
          )
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List
              key={i}
              className={cn('flex flex-col gap-1 pl-5 marker:text-fg-subtle', block.ordered ? 'list-decimal' : 'list-disc')}
            >
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline spans={item} />
                </li>
              ))}
            </List>
          )
        }
        if (block.type === 'code') {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg border border-line bg-surface-2/60 px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-fg"
            >
              {block.text}
            </pre>
          )
        }
        return (
          <p key={i}>
            <Inline spans={block.content} />
          </p>
        )
      })}
    </div>
  )
}
