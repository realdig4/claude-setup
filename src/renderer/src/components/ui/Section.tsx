import { useId, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SectionProps {
  title?: ReactNode
  description?: ReactNode
  /** Right-aligned actions on the title row. */
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}

/**
 * A titled block inside a page. Stack sections with `space-y-10`.
 * @example <Section title="Your apps" description="Where Claude Setup can add tools." actions={<Button size="sm">Refresh</Button>}>…</Section>
 */
export function Section({ title, description, actions, children, className, id }: SectionProps) {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className={cn('flex flex-col gap-4', className)}>
      {title || actions ? (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h2 id={headingId} className="text-base leading-6 font-semibold tracking-[-0.01em] text-fg">
                {title}
              </h2>
            ) : null}
            {description ? <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** Hairline divider. */
export function Separator({ orientation = 'horizontal', className }: { orientation?: 'horizontal' | 'vertical'; className?: string }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn('shrink-0 bg-line', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px self-stretch', className)}
    />
  )
}

export interface CardGridProps extends ComponentProps<'div'> {
  /** Minimum card width in px before wrapping to a new row (default 280). */
  minItemWidth?: number
  /** Gap in Tailwind spacing units ×4px (default 4 → 16px). */
  gap?: 3 | 4 | 5 | 6
}

const GAPS = { 3: 'gap-3', 4: 'gap-4', 5: 'gap-5', 6: 'gap-6' }

/**
 * Responsive auto-fill grid for cards: as many columns as fit at `minItemWidth`.
 * @example <CardGrid minItemWidth={300}>{servers.map((s) => <ServerCard key={s.id} … />)}</CardGrid>
 */
export function CardGrid({ minItemWidth = 280, gap = 4, className, style, ...props }: CardGridProps) {
  const gridStyle: CSSProperties = { gridTemplateColumns: `repeat(auto-fill, minmax(min(${minItemWidth}px, 100%), 1fr))`, ...style }
  return <div className={cn('grid', GAPS[gap], className)} style={gridStyle} {...props} />
}
