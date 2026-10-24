import { FolderOpen } from 'lucide-react'
import { Button, Select, toastError } from '@renderer/components/ui'
import { ui } from '@renderer/lib/api'
import { useSettings } from '@renderer/lib/hooks'

export interface ProjectPickerProps {
  value: string
  onChange: (path: string) => void
  disabled?: boolean
  /** Dialog title of the folder picker. */
  title?: string
}

/** "Last folder name" for a path (works with \ and /). */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Pick a project folder: recent projects from settings, or "Choose folder…" (system dialog). Picked folders are added
 * to the recent list.
 */
export function ProjectPicker({ value, onChange, disabled, title = 'Choose a project folder' }: ProjectPickerProps) {
  const { settings, update } = useSettings()
  const recent = settings?.recentProjects ?? []
  const options = [...new Set([...(value ? [value] : []), ...recent])].map((path) => ({
    value: path,
    label: `${folderName(path)} — ${path}`
  }))

  const choose = async (): Promise<void> => {
    try {
      const picked = await ui.pickFolder({ title, defaultPath: value || recent[0] })
      if (!picked) return
      onChange(picked)
      if (settings) void update({ recentProjects: [picked, ...recent.filter((p) => p !== picked)].slice(0, 20) })
    } catch (err) {
      toastError(err, 'Couldn’t open the folder picker')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.length ? (
        <Select
          value={value}
          onValueChange={onChange}
          options={options}
          placeholder="Choose a recent project"
          disabled={disabled}
          containerClassName="min-w-56 flex-1"
          aria-label="Project folder"
        />
      ) : null}
      <Button leftIcon={FolderOpen} onClick={() => void choose()} disabled={disabled}>
        {options.length ? 'Other folder…' : 'Choose folder…'}
      </Button>
    </div>
  )
}
