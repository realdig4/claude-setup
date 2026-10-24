import { useState } from 'react'
import { Download, FolderGit2, Globe, ShieldAlert, User } from 'lucide-react'
import type { ExtensionItem, Scope } from '@shared/types'
import { Button, Callout, Dialog, Field, Monogram, OptionCard, OptionCardGroup } from '@renderer/components/ui'
import { KIND_META, SCOPE_META, runsCommands, sourceLabel } from './meta'
import { ProjectPicker } from './ProjectPicker'

export interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: ExtensionItem
  /** Called with the chosen scope (and project folder for project/local). */
  onInstall: (scope: Scope, projectPath?: string) => void
}

const SCOPE_ICONS = { user: Globe, project: FolderGit2, local: User } as const

/** Advanced install: choose where the extension goes (everywhere, a project, or just you in a project). */
export function InstallDialog({ open, onOpenChange, item, onInstall }: InstallDialogProps) {
  const meta = KIND_META[item.kind]
  const [scope, setScope] = useState<Scope>('user')
  const [project, setProject] = useState('')
  const [attempted, setAttempted] = useState(false)
  const needsProject = scope !== 'user'
  const projectError = attempted && needsProject && !project ? 'Choose the project folder.' : undefined

  const submit = (): void => {
    setAttempted(true)
    if (needsProject && !project) return
    onInstall(scope, needsProject ? project : undefined)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-3">
          <Monogram text={item.name} seed={item.id} size="md" />
          <span className="min-w-0 truncate">Install {item.name}</span>
        </span>
      }
      description={`${meta.singular.charAt(0).toUpperCase()}${meta.singular.slice(1)} from ${sourceLabel(item)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" leftIcon={Download} onClick={submit}>
            Install
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {runsCommands(item.kind) || item.warnings?.length ? (
          <Callout
            tone="warn"
            icon={ShieldAlert}
            title={runsCommands(item.kind) ? 'This runs commands on your computer' : 'Read before installing'}
          >
            {runsCommands(item.kind)
              ? `${meta.label} run automatically while Claude Code works. Only install ones from people you trust.`
              : null}
            {item.warnings?.length ? (
              <ul className="mt-1 list-disc pl-4">
                {item.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </Callout>
        ) : null}
        <OptionCardGroup label="Where to install" columns={1}>
          {meta.scopes.map((s) => (
            <OptionCard
              key={s}
              icon={SCOPE_ICONS[s]}
              title={SCOPE_META[s].simple}
              badge={<span className="font-mono text-2xs text-fg-subtle">{s}</span>}
              description={SCOPE_META[s].description}
              checked={scope === s}
              onCheckedChange={() => setScope(s)}
            />
          ))}
        </OptionCardGroup>
        {needsProject ? (
          <Field label="Project folder" error={projectError} required>
            <ProjectPicker value={project} onChange={setProject} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  )
}
