/** Onboarding: helper programs (Node.js, uv, Docker, Claude Code) — found, or installable with live progress. */
import { useState, type ReactNode } from 'react'
import { Download } from 'lucide-react'
import type { RuntimeInfo, RuntimeName } from '@shared/types'
import { Badge, Button, ExternalLink, ProgressBar, toast, toastResult } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { useProgress, type ProgressState } from '@renderer/lib/hooks'
import { installableRuntime, runtimeName } from '../../discover/common/RuntimeFix'

export interface RuntimeInstallState {
  name: string
  busy: boolean
  progress: ProgressState | null
  install: () => Promise<void>
}

/** One-click install of a runtime through the core, with progress events and friendly toasts. */
export function useRuntimeInstall(runtime: RuntimeInfo, onInstalled: (id: RuntimeName) => void): RuntimeInstallState {
  const id = installableRuntime(runtime.id)
  const name = runtimeName(runtime)
  const [busy, setBusy] = useState(false)
  const { progress, reset } = useProgress((op) => op === 'install-runtime' || op === `install-${id}`)
  const install = async (): Promise<void> => {
    reset()
    setBusy(true)
    try {
      const result = await core.runtimes.install(id)
      toastResult(result, result.ok ? { successTitle: `${name} is installed` } : { errorTitle: `Couldn’t install ${name}` })
      if (result.ok) onInstalled(id)
    } catch (err) {
      toast.error(`Couldn’t install ${name}`, { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return { name, busy, progress, install }
}

function InstallProgress({ state, className }: { state: RuntimeInstallState; className?: string }) {
  return (
    <div className={className}>
      <ProgressBar value={state.progress?.pct} label={`Installing ${state.name}`} size="sm" />
      <p className="mt-1.5 text-xs text-fg-muted" aria-live="polite">
        {state.progress?.message ?? `Installing ${state.name}… this can take a minute or two.`}
      </p>
    </div>
  )
}

export interface HelperRowProps {
  runtime: RuntimeInfo
  /** Plain-words purpose. */
  purpose: string
  /** Optional helpers say so instead of looking like a problem. */
  optional?: boolean
  advanced: boolean
  icon: ReactNode
  onInstalled: (id: RuntimeName) => void
}

/** Status + fix for one helper, as a list row. */
export function HelperRow({ runtime, purpose, optional, advanced, icon, onInstalled }: HelperRowProps) {
  const state = useRuntimeInstall(runtime, onInstalled)
  const notRunning = runtime.found && runtime.running === false
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-3.5">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-fg">{state.name}</span>
            {advanced && runtime.version ? <span className="font-mono text-xs text-fg-subtle">{runtime.version}</span> : null}
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            {purpose}
            {notRunning ? ' It’s installed but not running — start Docker Desktop when you need it.' : ''}
            {runtime.outdated ? ' This version is old — updating it is recommended.' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {runtime.found ? (
            notRunning ? (
              <Badge size="sm" tone="warn">
                Not running
              </Badge>
            ) : (
              <Badge size="sm" tone="success" dot>
                Ready
              </Badge>
            )
          ) : state.busy ? null : runtime.install?.canAutoInstall ? (
            <Button size="sm" variant={optional ? 'ghost' : 'outline'} leftIcon={Download} onClick={() => void state.install()}>
              Install
            </Button>
          ) : runtime.install?.url ? (
            <ExternalLink href={runtime.install.url} className="text-[13px]">
              Download
            </ExternalLink>
          ) : (
            <Badge size="sm">{optional ? 'Optional' : 'Missing'}</Badge>
          )}
        </div>
      </div>
      {state.busy ? <InstallProgress state={state} className="mt-3 pl-[50px]" /> : null}
    </li>
  )
}

/** Compact install control (used for Claude Code in the apps list). */
export function InstallButton({ runtime, label, onInstalled }: { runtime: RuntimeInfo; label: string; onInstalled: (id: RuntimeName) => void }) {
  const state = useRuntimeInstall(runtime, onInstalled)
  if (state.busy) return <InstallProgress state={state} className="w-44" />
  return (
    <Button size="sm" variant="outline" leftIcon={Download} onClick={() => void state.install()}>
      {label}
    </Button>
  )
}
