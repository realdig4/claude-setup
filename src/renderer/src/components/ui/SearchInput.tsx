import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useHotkey, useLatest } from '../../lib/hooks'
import { controlBase, controlSizes, type ControlSize } from './Input'
import { Shortcut } from './Kbd'
import { Spinner } from './Spinner'

export interface SearchInputProps {
  /** External value (e.g. from route params). Typing updates it after `debounce` ms. */
  value: string
  /** Called with the debounced value (and immediately on clear / Enter). */
  onValueChange: (value: string) => void
  placeholder?: string
  /** Milliseconds to wait after typing stops (default 250). 0 = immediate. */
  debounce?: number
  /** Keyboard shortcut that focuses the field, e.g. '/' or 'mod+f'. Shown as a hint while empty. */
  shortcut?: string
  /** Show a spinner on the right (e.g. while results load). */
  loading?: boolean
  size?: ControlSize
  autoFocus?: boolean
  className?: string
  /** Accessible name (defaults to the placeholder). */
  'aria-label'?: string
  onSubmit?: (value: string) => void
}

/**
 * Debounced search field with a clear button and an optional focus shortcut.
 * Escape clears the text (or blurs when already empty).
 * @example <SearchInput value={q} onValueChange={setQ} placeholder="Search tools…" shortcut="/" />
 */
export function SearchInput({
  value,
  onValueChange,
  placeholder = 'Search…',
  debounce = 250,
  shortcut,
  loading,
  size = 'md',
  autoFocus,
  className,
  onSubmit,
  'aria-label': ariaLabel
}: SearchInputProps) {
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const onChangeRef = useLatest(onValueChange)
  const lastEmitted = useRef(value)

  // Follow external changes (e.g. navigation sets a new query).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      setText(value)
    }
  }, [value])

  useEffect(() => {
    if (text === lastEmitted.current) return
    const emit = (): void => {
      lastEmitted.current = text
      onChangeRef.current(text)
    }
    if (debounce <= 0) {
      emit()
      return
    }
    const id = window.setTimeout(emit, debounce)
    return () => window.clearTimeout(id)
  }, [text, debounce, onChangeRef])

  useHotkey(shortcut ?? '', () => inputRef.current?.focus(), { enabled: !!shortcut })

  const emitNow = (next: string): void => {
    setText(next)
    lastEmitted.current = next
    onChangeRef.current(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (text) {
        event.preventDefault()
        event.stopPropagation()
        emitNow('')
      } else {
        inputRef.current?.blur()
      }
    } else if (event.key === 'Enter') {
      emitNow(text)
      onSubmit?.(text)
    }
  }

  return (
    <div className={cn('relative flex w-full items-center', className)}>
      <Search className="pointer-events-none absolute left-3 size-4 text-fg-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        className={cn(controlBase, controlSizes[size], 'pr-16', size === 'sm' ? 'pl-8' : 'pl-9')}
      />
      <div className="absolute right-2 flex items-center gap-1.5">
        {loading ? <Spinner size="xs" className="text-fg-subtle" label="Searching" /> : null}
        {text ? (
          <button
            type="button"
            onClick={() => {
              emitNow('')
              inputRef.current?.focus()
            }}
            className="grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-3/70 hover:text-fg"
            aria-label="Clear search"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : shortcut ? (
          <Shortcut keys={shortcut} className="pointer-events-none" />
        ) : null}
      </div>
    </div>
  )
}
