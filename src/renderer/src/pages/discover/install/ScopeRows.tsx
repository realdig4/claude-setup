/**
 * Advanced: for each chosen app that supports several places (Claude Code, VS Code, Cursor), pick where the
 * tool is saved — everywhere, a project (shared) or just me in a project — plus the project folder.
 */
import { FolderOpen } from 'lucide-react'
import type { Scope, TargetInfo, TargetRef } from '@shared/types'
import { Button, Select } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { truncateMiddle } from '@renderer/lib/format'
import { AppIcon } from '../common/apps'
import { pickPath } from '../common/inputs'
import { TARGET_NAMES, TARGET_SCOPES, folderName, needsProject, samePath, scopeHint, scopeLabel } from '../lib/targets'

export interface ScopeRowsProps {
  refs: readonly TargetRef[]
  targets: readonly TargetInfo[]
  onChange: (refs: TargetRef[]) => void
  recentProjects: readonly string[]
  /** Highlight missing project folders. */
  showErrors?: boolean
}

/** Where-to-save controls for the selected apps (renders nothing when no app has a choice). */
export function ScopeRows({ refs, targets, onChange, recentProjects, showErrors }: ScopeRowsProps) {
  const rows = refs.filter((ref) => scopesOf(ref, targets).length > 1)
  if (!rows.length) return null

  const replace = (ref: TargetRef, next: TargetRef): void => onChange(refs.map((r) => (r === ref ? next : r)))

  return (
    <div className="space-y-2.5">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">Where to save it</h3>
        <p className="text-[12.5px] text-fg-muted">Some apps can keep a tool for every project, or for just one.</p>
      </div>
      {rows.map((ref) => {
        const scopes = scopesOf(ref, targets)
        const scope = ref.scope ?? scopes[0] ?? 'user'
        const name = TARGET_NAMES[ref.target]
        const missingFolder = !!showErrors && needsProject(scope) && !ref.projectPath
        return (
          <div key={ref.target} className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-3.5">
            <div className="flex flex-wrap items-center gap-3">
              <AppIcon target={ref.target} size="sm" />
              <span className="min-w-24 text-[13.5px] font-medium text-fg">{name}</span>
              <Select
                size="sm"
                aria-label={`Where to save it in ${name}`}
                value={scope}
                containerClassName="ml-auto w-auto min-w-52"
                options={scopes.map((s) => ({ value: s, label: scopeLabel(s) }))}
                onValueChange={(value) => {
                  const nextScope = value as Scope
                  const projectPath = ref.projectPath ?? recentProjects[0]
                  const next: TargetRef = needsProject(nextScope)
                    ? { target: ref.target, scope: nextScope, projectPath }
                    : { target: ref.target, scope: nextScope }
                  replace(ref, next)
                }}
              />
            </div>
            {needsProject(scope) ? (
              <ProjectPicker
                appName={name}
                value={ref.projectPath}
                recent={recentProjects}
                invalid={missingFolder}
                onChange={(projectPath) => replace(ref, { target: ref.target, scope, projectPath })}
              />
            ) : null}
            <p className={cn('text-xs leading-5', missingFolder ? 'text-danger-text' : 'text-fg-muted')} role={missingFolder ? 'alert' : undefined}>
              {missingFolder ? `Choose a project folder for ${name}.` : scopeHint(scope, ref.target)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

function scopesOf(ref: TargetRef, targets: readonly TargetInfo[]): readonly Scope[] {
  const info = targets.find((t) => t.id === ref.target)
  return info?.scopes.length ? info.scopes : TARGET_SCOPES[ref.target]
}

interface ProjectPickerProps {
  appName: string
  value?: string
  recent: readonly string[]
  invalid: boolean
  onChange: (path: string) => void
}

/** Recent project folders + a native folder picker. */
function ProjectPicker({ appName, value, recent, invalid, onChange }: ProjectPickerProps) {
  const choices: string[] = []
  for (const path of [value, ...recent]) if (path && !choices.some((c) => samePath(c, path))) choices.push(path)

  const browse = async (): Promise<void> => {
    const chosen = await pickPath('folder', `Choose the project folder for ${appName}`, value)
    if (chosen) onChange(chosen)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {choices.length ? (
        <Select
          size="sm"
          aria-label={`Project folder for ${appName}`}
          value={value ?? ''}
          placeholder="Choose a project folder"
          invalid={invalid}
          containerClassName="min-w-0 flex-1"
          options={choices.map((path) => ({ value: path, label: `${folderName(path)} — ${truncateMiddle(path, 48)}` }))}
          onValueChange={onChange}
        />
      ) : (
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', invalid ? 'text-danger-text' : 'text-fg-muted')}>No folder chosen yet</span>
      )}
      <Button size="sm" variant="outline" leftIcon={FolderOpen} onClick={() => void browse()}>
        {choices.length ? 'Other folder…' : 'Choose folder…'}
      </Button>
    </div>
  )
}
