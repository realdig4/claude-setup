import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/hooks'
import { Button, type ButtonSize, type ButtonVariant } from './Button'

export interface CopyButtonProps {
  /** Text to copy. */
  text: string
  /** Accessible label / tooltip (default "Copy"). */
  label?: string
  /** Visible text — renders a labeled button instead of an icon-only one. */
  children?: ReactNode
  /** Also show a toast (default false: the icon turns into a check instead). */
  toast?: boolean | string
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
}

/**
 * Copy-to-clipboard button with a check-mark confirmation.
 * @example <CopyButton text={configPath} label="Copy path" />
 */
export function CopyButton({ text, label = 'Copy', children, toast = false, variant = 'ghost', size, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onClick = async (): Promise<void> => {
    const ok = await copyText(text, toast === false ? false : toast === true ? 'Copied to clipboard' : toast)
    if (!ok) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  const icon = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={copied ? 'check' : 'copy'}
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.7 }}
        transition={{ duration: 0.12 }}
        className="flex"
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-[15px]" aria-hidden="true" />
        )}
      </motion.span>
    </AnimatePresence>
  )

  return (
    <Button
      variant={variant}
      size={size ?? (children ? 'sm' : 'icon-sm')}
      onClick={() => void onClick()}
      aria-label={children ? undefined : copied ? 'Copied' : label}
      title={children ? undefined : label}
      className={cn(className)}
    >
      {icon}
      {children}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </Button>
  )
}
