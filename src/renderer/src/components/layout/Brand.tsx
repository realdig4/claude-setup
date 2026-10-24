import { cn } from '../../lib/cn'

/** The Claude Setup glyph: two "setting" sliders on a warm terracotta tile (original mark, not an Anthropic logo). */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-grid size-[22px] shrink-0 place-items-center overflow-hidden rounded-[7px]',
        'bg-[linear-gradient(145deg,var(--color-accent-400),var(--color-accent-600))]',
        'shadow-[0_1px_2px_var(--elev-2),inset_0_1px_0_rgb(255_255_255/0.28),inset_0_0_0_1px_rgb(0_0_0/0.06)]',
        className
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[17px]" fill="none">
        <rect x="4.5" y="6.75" width="15" height="3" rx="1.5" fill="white" fillOpacity="0.5" />
        <circle cx="15" cy="8.25" r="2.75" fill="white" />
        <rect x="4.5" y="14.25" width="15" height="3" rx="1.5" fill="white" fillOpacity="0.5" />
        <circle cx="9" cy="15.75" r="2.75" fill="white" />
      </svg>
    </span>
  )
}

/** Glyph + "Claude Setup" wordmark. */
export function Wordmark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <BrandGlyph />
      {compact ? (
        <span className="sr-only">Claude Setup</span>
      ) : (
        <span className="truncate text-[14px] leading-none font-semibold tracking-[-0.015em] text-fg">
          Claude <span className="font-medium text-fg-muted">Setup</span>
        </span>
      )}
    </span>
  )
}
