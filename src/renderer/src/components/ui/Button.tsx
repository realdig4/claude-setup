import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { renderIcon, type IconProp } from './icon'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg'

export interface ButtonProps extends ComponentProps<'button'> {
  /** Visual style. Use one `primary` per view for the main action. Default 'outline'. */
  variant?: ButtonVariant
  /** Default 'md'. Icon-only buttons use 'icon' | 'icon-sm' | 'icon-lg' and need an aria-label. */
  size?: ButtonSize
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean
  leftIcon?: IconProp
  rightIcon?: IconProp
  /** Stretch to the container width. */
  fullWidth?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-solid text-accent-fg shadow-sm inset-shadow-[0_1px_0_rgb(255_255_255/0.16)] hover:bg-accent-solid-hover',
  secondary: 'bg-surface-3/70 text-fg hover:bg-surface-3',
  outline: 'border border-line bg-surface text-fg shadow-xs hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-fg-muted hover:bg-surface-3/60 hover:text-fg',
  danger: 'bg-danger-solid text-white shadow-sm inset-shadow-[0_1px_0_rgb(255_255_255/0.14)] hover:bg-danger-solid-hover',
  link: 'text-accent-text underline-offset-4 hover:underline'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-9 gap-2 rounded-lg px-3.5 text-sm',
  lg: 'h-11 gap-2 rounded-xl px-5 text-[15px]',
  icon: 'size-9 rounded-lg',
  'icon-sm': 'size-8 rounded-lg',
  'icon-lg': 'size-11 rounded-xl'
}

const LINK_SIZES: Record<ButtonSize, string> = {
  sm: 'gap-1 text-[13px]',
  md: 'gap-1.5 text-sm',
  lg: 'gap-1.5 text-[15px]',
  icon: 'size-9',
  'icon-sm': 'size-8',
  'icon-lg': 'size-11'
}

/** Sizes every direct <svg> child (lucide icons passed as children or via left/rightIcon). */
const ICON_SIZES: Record<ButtonSize, string> = {
  sm: '[&>svg]:size-3.5',
  md: '[&>svg]:size-4',
  lg: '[&>svg]:size-[18px]',
  icon: '[&>svg]:size-[18px]',
  'icon-sm': '[&>svg]:size-4',
  'icon-lg': '[&>svg]:size-5'
}

/** Is this an icon-only size? */
function isIconSize(size: ButtonSize): boolean {
  return size === 'icon' || size === 'icon-sm' || size === 'icon-lg'
}

/**
 * Button with variants, sizes, icons and a loading state.
 * @example <Button variant="primary" leftIcon={Plus} onClick={add}>Add tool</Button>
 * @example <Button variant="ghost" size="icon" aria-label="More actions"><Ellipsis /></Button>
 */
export function Button({
  variant = 'outline',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const iconClass = 'shrink-0'
  const iconOnly = isIconSize(size)
  const spinnerSize = size === 'lg' || size === 'icon-lg' ? 'md' : size === 'sm' ? 'xs' : 'sm'
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 ease-smooth',
        'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
        VARIANTS[variant],
        variant === 'link' ? LINK_SIZES[size] : SIZES[size],
        ICON_SIZES[size],
        '[&>svg]:shrink-0',
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {loading ? (
        <Spinner size={spinnerSize} label={null} />
      ) : (
        renderIcon(leftIcon, iconClass)
      )}
      {iconOnly && loading ? null : children}
      {!loading && renderIcon(rightIcon, iconClass)}
    </button>
  )
}
