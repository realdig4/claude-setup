/**
 * A missing helper program (Node.js, uv, Docker…) with a one-click install when possible, live progress,
 * or a download link plus "Check again".
 */
import { useState } from 'react'
import { Download, RotateCw, Wrench } from 'lucide-react'
import type { RuntimeInfo, RuntimeName } from '@shared/types'
import { Button, CodeBlock, ExternalLink, IconTile, ProgressBar, toast, toastResult } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { useProgress } from '@renderer/lib/hooks'
import { useIsAdvanced } from '@renderer/lib/store'
import { cn } from '@renderer/lib/cn'

/** npx comes with Node.js and uvx with uv: install and name the real thing. */
export function installableRuntime(id: RuntimeName): RuntimeName {
  return id === 'npx' ? 'node' : id === 'uvx' ? 'uv' : id
}

/** Friendly name of a runtime ("Node.js" for npx too). */
export function runtimeName(runtime: Pick<RuntimeInfo, 'id' | 'label'>): string {
  if (runtime.id === 'npx' || runtime.id === 'node') return 'Node.js'
  if (runtime.id === 'uvx' || runtime.id === 'uv') return 'uv'
  return runtime.label
}

const PURPOSES: Partial<Record<RuntimeName, string>> = {
  node: 'Most tools run with Node.js.',
  npx: 'Most tools run with Node.js.',
  uv: 'Tools written in Python run with uv.',
  uvx: 'Tools written in Python run with uv.',
  docker: 'This tool runs inside a Docker container.',
  python: 'This tool runs with Python.'
}

export interface RuntimeFixProps {
  runtime: RuntimeInfo
  /** Called after a successful install or when the person says they installed it. */
  onResolved: () => void
  className?: string
}

/** One missing runtime with a fix. */
export function RuntimeFix({ runtime, onResolved, className }: RuntimeFixProps) {
  const advanced = useIsAdvanced()
  const id = installableRuntime(runtime.id)
  const name = runtimeName(runtime)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const { progress, reset } = useProgress((op) => op === 'install-runtime' || op === `install-${id}`)
  const canAuto = !!runtime.install?.canAutoInstall && !failed

  const install = async (): Promise<void> => {
    reset()
    setBusy(true)
    try {
      const result = await core.runtimes.install(id)
      toastResult(result, result.ok ? { successTitle: `${name} is installed` } : { errorTitle: `Couldn’t install ${name}` })
      if (result.ok) onResolved()
      else setFailed(true)
    } catch (err) {
      setFailed(true)
      toast.error(`Couldn’t install ${name}`, { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('rounded-xl border border-warn-line/70 bg-warn-soft/50 p-4', className)}>
      <div className="flex items-start gap-3">
        <IconTile icon={Wrench} tone="warn" size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">{name} is needed</p>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            {PURPOSES[runtime.id] ?? runtime.purpose}{' '}
            {canAuto ? 'Claude Setup can install it for you — it takes a minute or two.' : 'Install it, then check again.'}
          </p>
        </div>
      </div>
      {busy ? (
        <div className="mt-3.5 space-y-1.5">
          <ProgressBar value={progress?.pct} label={`Installing ${name}`} />
          <p className="text-xs text-fg-muted" aria-live="polite">
            {progress?.message ?? `Installing ${name}…`}
          </p>
        </div>
      ) : (
        <div className="mt-3.5 flex flex-wrap items-center gap-2 pl-12">
          {canAuto ? (
            <Button size="sm" variant="outline" leftIcon={Download} onClick={() => void install()}>
              Install {name}
            </Button>
          ) : null}
          {!canAuto && runtime.install?.url ? <ExternalLink href={runtime.install.url}>Download {name}</ExternalLink> : null}
          <Button size="sm" variant="ghost" leftIcon={RotateCw} onClick={onResolved}>
            {canAuto ? 'Check again' : 'I’ve installed it'}
          </Button>
        </div>
      )}
      {advanced && runtime.install?.command && !busy ? (
        <CodeBlock code={`$ ${runtime.install.command}`} language="shell" className="mt-3" maxHeight={120} />
      ) : null}
    </div>
  )
}
