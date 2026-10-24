/** Copy an installed tool to other apps (and, in Advanced mode, to other places inside them). */
import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Copy } from 'lucide-react'
import type { InstallResult, InstalledServer, TargetRef } from '@shared/types'
import { Badge, Button, Dialog, OptionCard, OptionCardGroup, ProgressBar, toastError } from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { useProgress, useSettings, useTargets } from '@renderer/lib/hooks'
import { useIsAdvanced } from '@renderer/lib/store'
import { APP_BLURBS, AppIcon } from '../discover/common/apps'
import { RestartDesktopButton, noteRestart, useRestartPending } from '../discover/common/restart'
import { bumpServers } from '../discover/common/servers'
import { ScopeRows } from '../discover/install/ScopeRows'
import { TARGET_NAMES, orderRefs, refLabel, sameRef, selectionProblem, sortTargets, userRef } from '../discover/lib/targets'

export interface CopyDialogProps {
  server: InstalledServer | null
  label: string
  /** Everything installed (to mark apps that already have it). */
  installed: readonly InstalledServer[]
  onClose: () => void
}

/** Dialog to copy a tool into more apps. */
export function CopyDialog({ server, label, installed, onClose }: CopyDialogProps) {
  const advanced = useIsAdvanced()
  const { settings } = useSettings()
  const { targets, ready } = useTargets()
  const [selected, setSelected] = useState<TargetRef[]>([])
  const [attempted, setAttempted] = useState(false)
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<InstallResult | null>(null)
  const { progress, reset } = useProgress((op) => op === 'copy' || op === 'install')
  const restartPending = useRestartPending()

  useEffect(() => {
    if (!server) return
    setSelected([])
    setAttempted(false)
    setResult(null)
  }, [server])

  if (!server) return <Dialog open={false} onOpenChange={onClose} />

  const has = (ref: TargetRef): boolean => installed.some((s) => s.name === server.name && sameRef(s.target, ref))
  const problem = selectionProblem(selected)
  const duplicate = selected.find(has)

  const copy = async (): Promise<void> => {
    setAttempted(true)
    if (problem || duplicate) return
    reset()
    setCopying(true)
    try {
      const res = await core.servers.copy(server.name, server.target, selected)
      setResult(res)
      noteRestart(res.results)
      if (res.results.some((r) => r.ok)) bumpServers()
    } catch (err) {
      toastError(err, `Couldn’t copy ${label}`)
    } finally {
      setCopying(false)
    }
  }

  const done = !!result
  const okResults = result?.results.filter((r) => r.ok) ?? []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      size="lg"
      icon={Copy}
      title={`Copy ${label} to other apps`}
      description={done ? undefined : 'It keeps the same settings. A backup of each app’s settings file is made first.'}
      dismissible={!copying}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={copying}>
              Cancel
            </Button>
            <Button variant="primary" leftIcon={Copy} loading={copying} disabled={!ready || selected.length === 0} onClick={() => void copy()}>
              {selected.length > 1 ? `Copy to ${selected.length} apps` : 'Copy'}
            </Button>
          </>
        )
      }
    >
      <div className="@container space-y-5 pt-1">
        {copying ? (
          <div className="space-y-2 py-4">
            <ProgressBar value={progress?.pct} label={`Copying ${label}`} />
            <p className="text-[13px] text-fg-muted" aria-live="polite">
              {progress?.message ?? 'Copying…'}
            </p>
          </div>
        ) : done && result ? (
          <div className="space-y-4">
            {result.results.length === 0 ? (
              <p className="text-[13.5px] text-danger-text">{result.warnings[0] ?? 'Nothing was copied.'}</p>
            ) : (
              <ul aria-label="Results" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {result.results.map((r) => (
                  <li key={refLabel(r.target)} className="flex items-start gap-3 px-4 py-3">
                    <AppIcon target={r.target.target} size="sm" className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-fg">
                        {advanced ? refLabel(r.target) : TARGET_NAMES[r.target.target]}
                        {r.ok ? (
                          <CircleCheck className="size-4 text-success-text" aria-label="Copied" role="img" />
                        ) : (
                          <CircleX className="size-4 text-danger-text" aria-label="Not copied" role="img" />
                        )}
                      </div>
                      <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{r.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {restartPending && okResults.some((r) => r.target.target === 'claude-desktop') ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-line/80 bg-warn-soft/70 px-4 py-3">
                <p className="text-[13.5px] text-fg">Restart Claude Desktop so it loads {label}.</p>
                <RestartDesktopButton size="sm" variant="outline">
                  Restart now
                </RestartDesktopButton>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <OptionCardGroup label="Apps to copy it to" type="checkbox" columns={2}>
              {sortTargets(targets).map((target) => {
                const ref = userRef(target.id)
                const checked = selected.some((r) => r.target === target.id)
                const hasIt = has(ref)
                // Simple mode only copies to "everywhere", so an app that already has it there can't be picked.
                const already = hasIt && !advanced
                return (
                  <OptionCard
                    key={target.id}
                    type="checkbox"
                    checked={checked}
                    disabled={!target.installed || already}
                    onCheckedChange={(next) =>
                      setSelected((prev) => {
                        const others = prev.filter((r) => r.target !== target.id)
                        return next ? orderRefs([...others, ref]) : others
                      })
                    }
                    icon={<AppIcon target={target.id} tone={checked ? 'accent' : 'neutral'} />}
                    title={target.label}
                    description={!target.installed ? 'Not installed on this computer' : already ? 'Already has it' : APP_BLURBS[target.id]}
                    badge={
                      hasIt ? (
                        <Badge size="sm" tone="success">
                          Has it
                        </Badge>
                      ) : null
                    }
                  />
                )
              })}
            </OptionCardGroup>
            {advanced ? (
              <ScopeRows
                refs={selected}
                targets={targets}
                onChange={setSelected}
                recentProjects={settings?.recentProjects ?? []}
                showErrors={attempted}
              />
            ) : null}
            {attempted && (problem || duplicate) ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {problem ?? `${refLabel(duplicate as TargetRef)} already has a tool named “${server.name}”.`}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
