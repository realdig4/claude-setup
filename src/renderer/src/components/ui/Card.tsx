import type { ComponentProps, KeyboardEvent, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type CardVariant = 'default' | 'muted' | 'outline' | 'hero'

export interface CardProps extends ComponentProps<'div'> {
  /**
   * - default: white surface, hairline border, soft shadow
   * - muted: tinted fill, no shadow (secondary info)
   * - outline: transparent with border (grouping)
   * - hero: warm terracotta glow (top-of-page highlights)
   */
  variant?: CardVariant
  /** Hover lift + pointer. With onClick, the card also becomes keyboard-activatable (Enter/Space). */
  interactive?: boolean
  /** Visually mark as selected (accent border). */
  selected?: boolean
}

const VARIANTS: Record<CardVariant, string> = {
  default: 'border border-line bg-surface shadow-xs',
  muted: 'border border-transparent bg-surface-2/80',
  outline: 'border border-line bg-transparent',
  hero: 'border border-accent-line/60 bg-surface hero-glow shadow-sm'
}

/**
 * Container for a group of related content. Compose with CardHeader / CardTitle / CardDescription /
 * CardContent / CardFooter.
 * @example
 * <Card>
 *   <CardHeader><CardTitle>Claude Desktop</CardTitle><CardDescription>3 tools</CardDescription></CardHeader>
 *   <CardContent>…</CardContent>
 * </Card>
 */
export function Card({ variant = 'default', interactive, selected, className, onClick, onKeyDown, role, tabIndex, ...props }: CardProps) {
  const clickable = interactive && !!onClick
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (!clickable || event.defaultPrevented || event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.currentTarget.click()
    }
  }
  return (
    <div
      role={role ?? (clickable ? 'button' : undefined)}
      tabIndex={tabIndex ?? (clickable ? 0 : undefined)}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative rounded-xl text-fg',
        VARIANTS[variant],
        interactive && [
          'cursor-pointer transition-[border-color,box-shadow,transform,background-color] duration-200 ease-smooth',
          'hover:-translate-y-px hover:border-line-strong hover:shadow-md active:translate-y-0'
        ],
        selected && 'border-accent-line ring-1 ring-accent/40',
        className
      )}
      {...props}
    />
  )
}

export interface CardHeaderProps extends Omit<ComponentProps<'div'>, 'title'> {
  /** Right-aligned actions (buttons, badges). */
  actions?: ReactNode
}

/** Top section of a card: title/description on the left, optional actions on the right. */
export function CardHeader({ className, actions, children, ...props }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start gap-4 px-5 pt-5 pb-3', className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** Card heading (renders an h3). */
export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg', className)} {...props} />
}

/** Secondary line under a CardTitle. */
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mt-0.5 text-[13px] leading-5 text-fg-muted', className)} {...props} />
}

/** Main card body. */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />
}

/** Bottom bar for actions; separated by a hairline. */
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 rounded-b-xl border-t border-line bg-surface-2/50 px-5 py-3', className)}
      {...props}
    />
  )
}
