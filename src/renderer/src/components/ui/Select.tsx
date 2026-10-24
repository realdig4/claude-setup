import type { ComponentProps } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useFieldControl } from './Field'
import { controlBase, controlSizes, type ControlSize } from './Input'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** Options sharing a group name are rendered inside one <optgroup>. */
  group?: string
}

export interface SelectProps extends Omit<ComponentProps<'select'>, 'size'> {
  options?: SelectOption[]
  /** Disabled first option shown when the value is empty. */
  placeholder?: string
  size?: ControlSize
  invalid?: boolean
  /** Called with the selected value. */
  onValueChange?: (value: string) => void
  containerClassName?: string
}

/**
 * Styled native <select> — reliable keyboard and screen-reader support, OS-native dropdown.
 * @example <Select value={region} onValueChange={setRegion} options={[{ value: 'intl', label: 'International' }]} />
 */
export function Select({
  options,
  placeholder,
  size = 'md',
  onValueChange,
  onChange,
  className,
  containerClassName,
  children,
  ...props
}: SelectProps) {
  const controlProps = useFieldControl(props)
  const groups = groupOptions(options ?? [])
  return (
    <div className={cn('relative flex w-full items-center', containerClassName)}>
      <select
        className={cn(controlBase, controlSizes[size], 'appearance-none truncate pr-9', className)}
        onChange={(event) => {
          onChange?.(event)
          onValueChange?.(event.target.value)
        }}
        {...controlProps}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {groups.map((group, i) =>
          group.name ? (
            <optgroup key={`${group.name}-${i}`} label={group.name}>
              {group.options.map(renderOption)}
            </optgroup>
          ) : (
            group.options.map(renderOption)
          )
        )}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 size-4 text-fg-subtle" aria-hidden="true" />
    </div>
  )
}

function renderOption(option: SelectOption) {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  )
}

function groupOptions(options: SelectOption[]): Array<{ name?: string; options: SelectOption[] }> {
  const groups: Array<{ name?: string; options: SelectOption[] }> = []
  for (const option of options) {
    const last = groups[groups.length - 1]
    if (last && last.name === option.group) last.options.push(option)
    else groups.push({ name: option.group, options: [option] })
  }
  return groups
}
