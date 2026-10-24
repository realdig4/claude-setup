import { cn } from '../../lib/cn'
import type { Tone } from './Badge'
import { renderIcon, type IconProp } from './icon'

export type IconTileSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<IconTileSize, string> = {
  sm: 'size-7 rounded-lg [&>svg]:size-[15px]',
  md: 'size-9 rounded-[10px] [&>svg]:size-[18px]',
  lg: 'size-11 rounded-xl [&>svg]:size-[22px]',
  xl: 'size-14 rounded-2xl [&>svg]:size-[26px]'
}

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-3/70 text-fg-muted ring-line',
  accent: 'bg-accent-soft text-accent-text ring-accent-line/60',
  success: 'bg-success-soft text-success-text ring-success-line/60',
  warn: 'bg-warn-soft text-warn-text ring-warn-line/70',
  danger: 'bg-danger-soft text-danger-text ring-danger-line/60',
  info: 'bg-info-soft text-info-text ring-info-line/60'
}

export interface IconTileProps {
  icon: IconProp
  tone?: Tone
  size?: IconTileSize
  className?: string
}

/**
 * An icon on a soft tinted square — for page headers, cards and empty states.
 * @example <IconTile icon={Compass} tone="accent" size="lg" />
 */
export function IconTile({ icon, tone = 'accent', size = 'md', className }: IconTileProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-grid shrink-0 place-items-center ring-1 ring-inset',
        'bg-linear-to-b from-white/40 to-transparent dark:from-white/[0.04]',
        SIZES[size],
        TONES[tone],
        className
      )}
    >
      {renderIcon(icon)}
    </span>
  )
}
