import { useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode, type Ref } from 'react'
import { ClipboardPaste, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { ui } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useFieldControl } from './Field'
import { renderIcon, type IconProp } from './icon'

export type ControlSize = 'sm' | 'md' | 'lg'

/** Shared look of every text-like control (also used by Select and SearchInput). */
export const controlBase =
  'w-full min-w-0 rounded-lg border border-line bg-surface text-fg shadow-xs outline-none ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ' +
  'placeholder:text-fg-subtle hover:border-line-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent/20 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-line ' +
  'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20'

export const controlSizes: Record<ControlSize, string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3 text-sm',
  lg: 'h-11 px-3.5 text-[15px]'
}

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'> {
  size?: ControlSize
  /** Icon inside the field on the left. */
  leftIcon?: IconProp
  /** Element inside the field on the right (buttons, badges, a Kbd hint). */
  rightSlot?: ReactNode
  /** Force the invalid style (Field sets it automatically when it has an error). */
  invalid?: boolean
  /** Monospace text (paths, ids, URLs). */
  mono?: boolean
  /** Called with the new string value on every change. */
  onValueChange?: (value: string) => void
  /** Classes for the wrapper element (width, margins). */
  containerClassName?: string
}

/**
 * Text input. Works inside <Field> (label/hint/error wiring) or standalone with aria-label.
 * @example <Input placeholder="my-server" value={name} onValueChange={setName} />
 */
export function Input({
  size = 'md',
  leftIcon,
  rightSlot,
  mono,
  onValueChange,
  onChange,
  className,
  containerClassName,
  ...props
}: InputProps) {
  const controlProps = useFieldControl(props)
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange?.(event)
    onValueChange?.(event.target.value)
  }
  return (
    <div className={cn('relative flex w-full items-center', containerClassName)}>
      {leftIcon ? (
        <span className="pointer-events-none absolute left-3 flex text-fg-subtle [&>svg]:size-4">{renderIcon(leftIcon)}</span>
      ) : null}
      <input
        className={cn(
          controlBase,
          controlSizes[size],
          leftIcon && (size === 'sm' ? 'pl-8' : 'pl-9'),
          rightSlot && 'pr-11',
          mono && 'font-mono text-[0.92em] tracking-tight',
          className
        )}
        onChange={handleChange}
        {...controlProps}
      />
      {rightSlot ? <div className="absolute right-1.5 flex items-center gap-1">{rightSlot}</div> : null}
    </div>
  )
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean
  mono?: boolean
  onValueChange?: (value: string) => void
}

/**
 * Multi-line text input (resizable vertically).
 * @example <Textarea mono rows={10} value={json} onValueChange={setJson} />
 */
export function Textarea({ mono, onValueChange, onChange, className, rows = 4, ...props }: TextareaProps) {
  const controlProps = useFieldControl(props)
  return (
    <textarea
      rows={rows}
      className={cn(
        controlBase,
        'min-h-20 resize-y px-3 py-2 text-sm leading-relaxed',
        mono && 'font-mono text-[12.5px] leading-[1.6]',
        className
      )}
      onChange={(event) => {
        onChange?.(event)
        onValueChange?.(event.target.value)
      }}
      spellCheck={mono ? false : props.spellCheck}
      {...controlProps}
    />
  )
}

export interface SecretInputProps extends Omit<InputProps, 'type' | 'rightSlot'> {
  /** Show the paste-from-clipboard button (default true). */
  allowPaste?: boolean
  /** Show the eye toggle (default true). */
  revealable?: boolean
}

const SLOT_BUTTON =
  'grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-3/70 hover:text-fg disabled:opacity-40'

/** Set an input's value the way a user would, so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value
}

/**
 * Password-style field for API keys and tokens, with show/hide and paste buttons.
 * Pasted values are trimmed (keys copied from web pages often carry spaces or newlines).
 * @example <Field label="API key"><SecretInput value={key} onValueChange={setKey} placeholder="sk-…" /></Field>
 */
export function SecretInput({ allowPaste = true, revealable = true, ref, mono = true, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const paste = async (): Promise<void> => {
    const input = inputRef.current
    if (!input) return
    try {
      // Read through the main process (no clipboard-read permission needed); the browser API is the fallback.
      const raw = await ui.readClipboard().catch(() => navigator.clipboard.readText())
      const text = raw.trim()
      if (!text) {
        toast.info('Your clipboard is empty', { description: 'Copy the key first, then try again.' })
        return
      }
      setNativeValue(input, text)
      input.focus()
    } catch {
      input.focus()
      toast.info('Press Ctrl+V to paste', { description: 'Claude Setup couldn’t read the clipboard directly.' })
    }
  }

  return (
    <Input
      {...props}
      ref={(el) => {
        inputRef.current = el
        assignRef(ref, el)
      }}
      mono={mono}
      type={revealed ? 'text' : 'password'}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onPaste={(event) => {
        props.onPaste?.(event)
        if (event.defaultPrevented) return
        const text = event.clipboardData.getData('text')
        if (text && text !== text.trim()) {
          event.preventDefault()
          setNativeValue(event.currentTarget, text.trim())
        }
      }}
      className={cn(allowPaste && revealable && 'pr-[4.5rem]', props.className)}
      rightSlot={
        allowPaste || revealable ? (
          <>
            {allowPaste ? (
              <button
                type="button"
                onClick={() => void paste()}
                disabled={props.disabled}
                className={SLOT_BUTTON}
                aria-label="Paste from clipboard"
                title="Paste"
              >
                <ClipboardPaste className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            {revealable ? (
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                disabled={props.disabled}
                className={SLOT_BUTTON}
                aria-label={revealed ? 'Hide' : 'Show'}
                aria-pressed={revealed}
                title={revealed ? 'Hide' : 'Show'}
              >
                {revealed ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            ) : null}
          </>
        ) : undefined
      }
    />
  )
}
