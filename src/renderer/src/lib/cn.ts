import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Join class names conditionally and resolve Tailwind conflicts (last one wins).
 * @example cn('px-3 text-fg', isActive && 'bg-accent-soft', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export type { ClassValue }
