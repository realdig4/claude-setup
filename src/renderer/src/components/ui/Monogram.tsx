import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { brandPalette, initials, monogramPalette } from '../../lib/color'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export const AVATAR_SIZES: Record<AvatarSize, string> = {
  xs: 'size-5 rounded-[6px] text-[9px]',
  sm: 'size-7 rounded-lg text-[11px]',
  md: 'size-9 rounded-[10px] text-[13px]',
  lg: 'size-11 rounded-xl text-[15px]',
  xl: 'size-14 rounded-2xl text-[19px]'
}

export interface MonogramProps {
  /** Name used for the letters and (unless `color` is set) the deterministic color. */
  text: string
  /** Explicit letters (1–2), e.g. ProviderPreset.monogram. */
  letters?: string
  /** Brand color (hex). Text color is chosen for contrast. */
  color?: string
  /** Seed for the generated color (defaults to `text`) — pass a stable id when names may change. */
  seed?: string
  size?: AvatarSize
  shape?: 'rounded' | 'circle'
  className?: string
  /** Accessible name; omit when the name is already shown next to it (decorative). */
  label?: string
}

/**
 * Colored letter avatar — deterministic color from the name, or a given brand color.
 * @example <Monogram text="Brave Search" />  <Monogram text="Kimi" letters="K" color="#16191E" size="lg" />
 */
export function Monogram({ text, letters, color, seed, size = 'md', shape = 'rounded', className, label }: MonogramProps) {
  const palette = color ? brandPalette(color) : monogramPalette(seed ?? text)
  const chars = (letters ?? initials(text)).slice(0, 2)
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'relative inline-grid shrink-0 place-items-center overflow-hidden font-semibold tracking-tight select-none',
        'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),inset_0_1px_0_rgb(255_255_255/0.18)]',
        AVATAR_SIZES[size],
        shape === 'circle' && 'rounded-full',
        className
      )}
      style={{ background: palette.background, color: palette.color }}
    >
      {chars}
    </span>
  )
}

const failedIcons = new Set<string>()

/** Only remote https images and inline data images are allowed (CSP: img-src 'self' data: https:). */
function isAllowedSrc(src: string | undefined): src is string {
  return !!src && (src.startsWith('https://') || src.startsWith('data:image/'))
}

export interface ServerIconProps {
  /** Remote icon URL (registry iconUrl). Falls back to a Monogram if missing or broken. */
  src?: string
  name: string
  /** Stable seed for the fallback color (e.g. catalog id). */
  seed?: string
  size?: AvatarSize
  className?: string
}

/**
 * Logo of an MCP server / extension with a graceful Monogram fallback (no layout shift while loading).
 * @example <ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size="lg" />
 */
export function ServerIcon({ src, name, seed, size = 'md', className }: ServerIconProps) {
  const usable = isAllowedSrc(src) && !failedIcons.has(src)
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>(usable ? 'loading' : 'error')

  useEffect(() => {
    setState(isAllowedSrc(src) && !failedIcons.has(src) ? 'loading' : 'error')
  }, [src])

  return (
    <span className={cn('relative inline-grid shrink-0', AVATAR_SIZES[size], className)}>
      {state !== 'loaded' ? <Monogram text={name} seed={seed} size={size} className="absolute inset-0" /> : null}
      {usable && state !== 'error' ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setState('loaded')}
          onError={() => {
            failedIcons.add(src)
            setState('error')
          }}
          className={cn(
            'absolute inset-0 size-full bg-white object-cover transition-opacity duration-300',
            'outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10',
            AVATAR_SIZES[size].split(' ').filter((c) => c.startsWith('rounded')),
            state === 'loaded' ? 'opacity-100' : 'opacity-0'
          )}
        />
      ) : null}
    </span>
  )
}
